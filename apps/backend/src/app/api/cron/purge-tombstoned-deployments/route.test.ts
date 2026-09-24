/**
 * Tests for GET /api/cron/purge-tombstoned-deployments
 *
 * Covers:
 *   - Structured logging of orphaned artifact purge failures
 *   - Cron failure tracker recording failures
 *   - Successful purge operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPurgeOrphanedArtifacts = vi.fn();
const mockRecordFailure = vi.fn();
const mockRecordSuccess = vi.fn();

vi.mock('@/services/cleanup.service', () => ({
    cleanupService: {
        purgeOrphanedArtifacts: mockPurgeOrphanedArtifacts,
    },
}));

vi.mock('@/services/cron-failure-tracker.service', () => ({
    cronFailureTrackerService: {
        recordFailure: mockRecordFailure,
        recordSuccess: mockRecordSuccess,
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string) {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) {
        headers['authorization'] = authHeader;
    }
    return new NextRequest('http://localhost/api/cron/purge-tombstoned-deployments', { headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/purge-tombstoned-deployments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.CRON_SECRET;
        delete process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS;
        mockPurgeOrphanedArtifacts.mockResolvedValue({ recordsDeleted: 5 });
    });

    afterEach(() => {
        delete process.env.CRON_SECRET;
        delete process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS;
    });

    describe('orphaned artifact purge failure handling', () => {
        it('records failure via cronFailureTrackerService when purgeOrphanedArtifacts throws', async () => {
            const testError = new Error('Storage connection failed');
            mockPurgeOrphanedArtifacts.mockRejectedValue(testError);

            const { GET } = await import('./route');
            const res = await GET(makeRequest());

            expect(res.status).toBe(200);
            expect(mockRecordFailure).toHaveBeenCalledWith(
                'purge-tombstoned-deployments',
                expect.anything()
            );
        });

        it('routes error through structured logging instead of bare console.error', async () => {
            const testError = new Error('Artifact storage failed');
            mockPurgeOrphanedArtifacts.mockRejectedValue(testError);

            const consoleSpy = vi.spyOn(console, 'error');

            const { GET } = await import('./route');
            await GET(makeRequest());

            // Should NOT call bare console.error
            const bareConsoleErrors = consoleSpy.mock.calls.filter(
                (call) => typeof call[0] === 'string' && call[0].includes('Orphaned artifact purge failed')
            );
            expect(bareConsoleErrors.length).toBe(0);

            consoleSpy.mockRestore();
        });

        it('continues processing and returns 200 even when purge fails', async () => {
            mockPurgeOrphanedArtifacts.mockRejectedValue(new Error('Purge failed'));

            const { GET } = await import('./route');
            const res = await GET(makeRequest());

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toHaveProperty('purged');
            expect(body).toHaveProperty('orphanedArtifactsPurged', 0);
            expect(body).toHaveProperty('retentionDisabled');
        });
    });

    describe('success path', () => {
        it('records success via cronFailureTrackerService when orphan purge succeeds', async () => {
            mockPurgeOrphanedArtifacts.mockResolvedValue({ recordsDeleted: 3 });

            const { GET } = await import('./route');
            await GET(makeRequest());

            expect(mockRecordSuccess).toHaveBeenCalledWith('purge-tombstoned-deployments');
        });

        it('returns correct purge counts on success', async () => {
            mockPurgeOrphanedArtifacts.mockResolvedValue({ recordsDeleted: 7 });

            const { GET } = await import('./route');
            const res = await GET(makeRequest());

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.orphanedArtifactsPurged).toBe(7);
        });
    });

    describe('authorization', () => {
        it('returns 401 when CRON_SECRET is set and Authorization header is absent', async () => {
            process.env.CRON_SECRET = 'super-secret';
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(401);
            expect(mockRecordFailure).not.toHaveBeenCalled();
        });

        it('proceeds when CRON_SECRET is not configured', async () => {
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
        });
    });
});
