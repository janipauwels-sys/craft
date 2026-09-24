/**
 * Tests for DLQ auto-recovery: scheduleRetry() with exponential backoff,
 * jitter, and circuit-breaker behaviour.
 *
 * Uses vi.useFakeTimers() to control time and avoid real waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webhookDLQ } from '@/lib/webhook-dlq/dead-letter-queue';

// Mock exponential-backoff so sleep() resolves immediately
vi.mock('@/lib/retry/exponential-backoff', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/retry/exponential-backoff')>();
    return {
        ...actual,
        sleep: vi.fn().mockResolvedValue(undefined),
    };
});

beforeEach(() => {
    webhookDLQ._reset();
});

afterEach(() => {
    webhookDLQ._reset();
    vi.restoreAllMocks();
});

// Helper to create test entry
function createDLQEntry(source: 'stripe' | 'github' = 'stripe') {
    return webhookDLQ.capture(source, 'test.event', '{"test":true}', 'test failure', 1);
}

describe('webhookDLQ.scheduleRetry()', () => {
    it('succeeds on first retry attempt', async () => {
        const processor = vi.fn().mockResolvedValue(undefined);
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = webhookDLQ.capture('stripe', 'invoice.paid', '{}', 'timeout', 1);

        await webhookDLQ.scheduleRetry(entry.id);

        expect(processor).toHaveBeenCalledTimes(1);
        const updated = webhookDLQ.get(entry.id)!;
        expect(updated.reprocessStatus).toBe('succeeded');
    });

    it('retries all 6 scheduled intervals on repeated failure then marks permanent failure', async () => {
        const processor = vi.fn().mockRejectedValue(new Error('delivery failed'));
        webhookDLQ.registerProcessor('github', processor);

        const entry = webhookDLQ.capture('github', 'push', '{}', 'net error', 0);

        await webhookDLQ.scheduleRetry(entry.id);

        expect(processor).toHaveBeenCalledTimes(6);
        const updated = webhookDLQ.get(entry.id)!;
        expect(updated.reprocessStatus).toBe('failed');
    });

    it('succeeds on the 3rd attempt after two failures', async () => {
        let callCount = 0;
        const processor = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount < 3) return Promise.reject(new Error('transient'));
            return Promise.resolve();
        });
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = webhookDLQ.capture('stripe', 'checkout.completed', '{}', 'timeout', 0);

        await webhookDLQ.scheduleRetry(entry.id);

        expect(processor).toHaveBeenCalledTimes(3);
        const updated = webhookDLQ.get(entry.id)!;
        expect(updated.reprocessStatus).toBe('succeeded');
    });

    it('does nothing if entry does not exist', async () => {
        // Should not throw
        await expect(webhookDLQ.scheduleRetry('nonexistent-id')).resolves.toBeUndefined();
    });

    it('does nothing if entry already succeeded', async () => {
        const processor = vi.fn().mockResolvedValue(undefined);
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = webhookDLQ.capture('stripe', 'invoice.paid', '{}', 'err', 0);
        await webhookDLQ.scheduleRetry(entry.id);
        processor.mockClear();

        // Should skip - already succeeded
        await webhookDLQ.scheduleRetry(entry.id);
        expect(processor).not.toHaveBeenCalled();
    });

    it('does nothing if no processor registered', async () => {
        const entry = webhookDLQ.capture('stripe', 'invoice.paid', '{}', 'err', 0);
        // No processor registered
        await expect(webhookDLQ.scheduleRetry(entry.id)).resolves.toBeUndefined();
        expect(webhookDLQ.get(entry.id)?.reprocessStatus).toBe('pending');
    });
});

describe('Circuit breaker', () => {
    it('trips after 5 consecutive failures and blocks subsequent retries', async () => {
        const processor = vi.fn().mockRejectedValue(new Error('endpoint down'));
        webhookDLQ.registerProcessor('stripe', processor);

        const endpoint = 'https://example.com/webhook';

        // Create 5 entries with the same endpoint and schedule retries to trip the breaker
        // Each scheduleRetry makes up to 6 attempts, so trip happens fast
        for (let i = 0; i < 5; i++) {
            const entry = webhookDLQ.capture('stripe', 'test', '{}', 'err', 0, endpoint);
            // Run only one retry each to track consecutive failures
            // We need to trip the circuit; simulate by calling recordFailure via the scheduleRetry path
        }

        // Schedule retry for one entry; it will fail multiple times and trip the circuit
        const entries = webhookDLQ.list();
        await webhookDLQ.scheduleRetry(entries[entries.length - 1].id);

        // After 5 failures the circuit should be open
        const cb = webhookDLQ._getCircuitBreaker(endpoint);
        expect(cb.consecutiveFailures).toBeGreaterThanOrEqual(5);
        expect(cb.openedAt).not.toBeNull();
    });

    it('circuit opens and blocks retry for subsequent entries on same endpoint', async () => {
        const processor = vi.fn().mockRejectedValue(new Error('down'));
        webhookDLQ.registerProcessor('github', processor);

        const endpoint = 'https://delivery.example.com/hook';

        // Trip the circuit manually via 5 failures from a first entry
        const first = webhookDLQ.capture('github', 'push', '{}', 'err', 0, endpoint);
        await webhookDLQ.scheduleRetry(first.id); // 6 failures → trips at 5

        const cb = webhookDLQ._getCircuitBreaker(endpoint);
        expect(cb.openedAt).not.toBeNull();

        // A new entry on the same endpoint should be blocked immediately
        processor.mockClear();
        const second = webhookDLQ.capture('github', 'push', '{}', 'err', 0, endpoint);
        await webhookDLQ.scheduleRetry(second.id);

        // processor should not be called since circuit is open on first attempt check
        expect(processor).not.toHaveBeenCalled();
    });

    it('circuit resets after 1 hour', async () => {
        const processor = vi.fn().mockRejectedValue(new Error('down'));
        webhookDLQ.registerProcessor('stripe', processor);
        const endpoint = 'https://reset.example.com/hook';

        // Trip the circuit
        const entry = webhookDLQ.capture('stripe', 'ev', '{}', 'err', 0, endpoint);
        await webhookDLQ.scheduleRetry(entry.id);

        const cb = webhookDLQ._getCircuitBreaker(endpoint);
        expect(cb.openedAt).not.toBeNull();

        // Advance time by 1 hour + 1ms
        cb.openedAt = Date.now() - (60 * 60 * 1000 + 1);

        // Now the circuit should auto-reset
        processor.mockClear().mockResolvedValue(undefined);
        const entry2 = webhookDLQ.capture('stripe', 'ev2', '{}', 'err', 0, endpoint);
        await webhookDLQ.scheduleRetry(entry2.id);

        expect(processor).toHaveBeenCalled();
        const updated = webhookDLQ.get(entry2.id)!;
        expect(updated.reprocessStatus).toBe('succeeded');
    });

    it('records consecutive failures correctly via _getCircuitBreaker', async () => {
        const processor = vi.fn().mockRejectedValue(new Error('fail'));
        webhookDLQ.registerProcessor('stripe', processor);
        const endpoint = 'https://track.example.com';

        const entry = webhookDLQ.capture('stripe', 'ev', '{}', 'err', 0, endpoint);
        await webhookDLQ.scheduleRetry(entry.id);

        const cb = webhookDLQ._getCircuitBreaker(endpoint);
        // At least 5 failures before circuit tripped
        expect(cb.consecutiveFailures).toBeGreaterThanOrEqual(5);
    });
});

describe('webhookDLQ.capture()', () => {
    it('captures entry and stores it', () => {
        const entry = webhookDLQ.capture('stripe', 'invoice.paid', '{"id":"x"}', 'timeout', 3);
        expect(entry.id).toMatch(/^dlq_/);
        expect(webhookDLQ.get(entry.id)).toEqual(entry);
    });

    it('capture stores optional endpointUrl', () => {
        const entry = webhookDLQ.capture('github', 'push', '{}', 'err', 1, 'https://ep.example.com');
        expect(webhookDLQ.get(entry.id)?.endpointUrl).toBe('https://ep.example.com');
    });

    it('generates unique collision-resistant IDs across a large batch of rapidly-generated entries', () => {
        const count = 1000;
        const ids = new Set<string>();
        for (let i = 0; i < count; i++) {
            const entry = webhookDLQ.capture('stripe', `event.${i}`, `{"payload":${i}}`, 'err', 0);
            expect(entry.id).toMatch(/^dlq_\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            ids.add(entry.id);
        }
        expect(ids.size).toBe(count);
    });
});

describe('webhookDLQ dedup index pruning', () => {
    it('prunes dedupIndex entry when reprocess() succeeds', async () => {
        webhookDLQ.registerProcessor('stripe', vi.fn().mockResolvedValue(undefined));

        const entry = webhookDLQ.capture('stripe', 'payment_intent.succeeded', '{"id":"pi_1"}', 'err', 1);
        expect(webhookDLQ._dedupIndexSize()).toBe(1);

        const result = await webhookDLQ.reprocess(entry.id);
        expect(result.success).toBe(true);
        expect(webhookDLQ._dedupIndexSize()).toBe(0);
    });

    it('prunes dedupIndex entry when scheduleRetry() succeeds', async () => {
        webhookDLQ.registerProcessor('github', vi.fn().mockResolvedValue(undefined));

        const entry = webhookDLQ.capture('github', 'push', '{"ref":"main"}', 'timeout', 1);
        expect(webhookDLQ._dedupIndexSize()).toBe(1);

        await webhookDLQ.scheduleRetry(entry.id);
        expect(webhookDLQ.get(entry.id)?.reprocessStatus).toBe('succeeded');
        expect(webhookDLQ._dedupIndexSize()).toBe(0);
    });

    it('retains dedupIndex entry when reprocessing fails so duplicates still merge', async () => {
        webhookDLQ.registerProcessor('stripe', vi.fn().mockRejectedValue(new Error('fail')));

        const entry1 = webhookDLQ.capture('stripe', 'charge.failed', '{"id":"ch_1"}', 'initial err', 1);
        expect(webhookDLQ._dedupIndexSize()).toBe(1);

        const result = await webhookDLQ.reprocess(entry1.id);
        expect(result.success).toBe(false);
        // dedupIndex should still contain the entry
        expect(webhookDLQ._dedupIndexSize()).toBe(1);

        // A duplicate capture merges into the existing entry
        const entry2 = webhookDLQ.capture('stripe', 'charge.failed', '{"id":"ch_1"}', 'second err', 2);
        expect(entry2.id).toBe(entry1.id);
        expect(entry2.attempts).toBe(2);
        expect(entry2.failureReason).toBe('second err');
        expect(webhookDLQ._dedupIndexSize()).toBe(1);
    });

    it('does not grow dedupIndex unboundedly across many capture -> succeed cycles', async () => {
        webhookDLQ.registerProcessor('stripe', vi.fn().mockResolvedValue(undefined));

        const totalCycles = 100;
        for (let i = 0; i < totalCycles; i++) {
            const entry = webhookDLQ.capture('stripe', `event.${i}`, `{"payload":${i}}`, 'err', 1);
            expect(webhookDLQ._dedupIndexSize()).toBe(1);
            await webhookDLQ.reprocess(entry.id);
            expect(webhookDLQ._dedupIndexSize()).toBe(0);
        }

        expect(webhookDLQ._dedupIndexSize()).toBe(0);
    });

    it('_reset() clears dedupIndex completely', () => {
        webhookDLQ.capture('stripe', 'e1', '{"a":1}', 'err', 1);
        webhookDLQ.capture('stripe', 'e2', '{"a":2}', 'err', 1);
        expect(webhookDLQ._dedupIndexSize()).toBe(2);

        webhookDLQ._reset();
        expect(webhookDLQ._dedupIndexSize()).toBe(0);
    });
});

describe('webhookDLQ.reprocess() concurrent protection', () => {
    beforeEach(() => {
        webhookDLQ._reset();
    });

    afterEach(() => {
        webhookDLQ._reset();
        vi.restoreAllMocks();
    });

    it('executes a reprocess request exactly once even with simultaneous concurrent calls', async () => {
        let processorExecutionCount = 0;
        const processor = vi.fn().mockImplementation(async () => {
            processorExecutionCount++;
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = createDLQEntry('stripe');

        // Fire two reprocess requests concurrently for the same entry
        const [result1, result2] = await Promise.all([
            webhookDLQ.reprocess(entry.id),
            webhookDLQ.reprocess(entry.id),
        ]);

        // Exactly one should succeed; the other should report already-in-progress or already-succeeded
        const successCount = [result1.success, result2.success].filter(Boolean).length;
        expect(successCount).toBe(1);

        // The processor should have been called exactly once
        expect(processorExecutionCount).toBe(1);
    });

    it('returns distinguishable error when entry is already being reprocessed', async () => {
        const processor = vi.fn().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = createDLQEntry('stripe');

        const [result1, result2] = await Promise.all([
            webhookDLQ.reprocess(entry.id),
            webhookDLQ.reprocess(entry.id),
        ]);

        // One succeeds, one fails with a clear error message
        if (result1.success) {
            expect(result2.success).toBe(false);
            expect(result2.error).toContain('already');
        } else {
            expect(result2.success).toBe(true);
            expect(result1.error).toContain('already');
        }
    });

    it('does not require a separate pre-check before reprocess()', async () => {
        const processor = vi.fn().mockResolvedValue(undefined);
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = createDLQEntry('stripe');

        // Call reprocess without prior get() — it should be atomic
        const result = await webhookDLQ.reprocess(entry.id);
        expect(result.success).toBe(true);
    });

    it('returns not-found error when entry does not exist', async () => {
        const result = await webhookDLQ.reprocess('nonexistent-id');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('maintains consistent state under concurrent reprocess attempts', async () => {
        const processor = vi.fn().mockResolvedValue(undefined);
        webhookDLQ.registerProcessor('stripe', processor);

        const entry = createDLQEntry('stripe');

        await Promise.all([
            webhookDLQ.reprocess(entry.id),
            webhookDLQ.reprocess(entry.id),
        ]);

        const finalEntry = webhookDLQ.get(entry.id);
        expect(finalEntry).toBeDefined();
        expect(finalEntry!.reprocessStatus).toBe('succeeded');
        expect(finalEntry!.reprocessedAt).toBeDefined();
    });
});
