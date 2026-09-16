import { describe, expect, it, vi } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import {
  clearSiteContentWithoutEdge,
  clearSiteContentWithEdge,
  resetStudioWithoutEdge,
  resetStudioWithEdge,
} from './coordinated-database-operations';

const database = {} as D1Database;
const edgeDatabase = {} as D1Database;
const administratorId = '0123456789abcdef0123456789abcdef';
const emptyLifecycleResult = {
  deletedRows: {},
  insertedRows: {},
  updatedRows: {},
};

describe('Coordinated maintenance database operations', () => {
  it('clears Edge first and merges independently reported Studio and Edge effects', async () => {
    const clearEdge = vi.fn().mockResolvedValue({
      deletedRows: {
        'EDGE_DB.comments': 7,
        'EDGE_DB.edge_comment_targets': 2,
      },
      insertedRows: {},
      updatedRows: {},
    });
    const clearStudio = vi.fn().mockResolvedValue({
      deletedRows: { posts: 2, pages: 1 },
      insertedRows: {},
      updatedRows: {},
    });
    const clearNewsletter = vi.fn().mockResolvedValue({
      ...emptyLifecycleResult,
      deletedRows: { 'EDGE_DB.newsletter_subscriptions': 3 },
    });
    const clearForms = vi.fn().mockResolvedValue({
      ...emptyLifecycleResult,
      deletedRows: { 'EDGE_DB.form_submissions': 4 },
    });

    await expect(clearSiteContentWithEdge({
      db: database,
      edgeDb: edgeDatabase,
      administratorId,
    }, { clearEdge, clearNewsletter, clearForms, clearStudio })).resolves.toEqual({
      deletedRows: {
        posts: 2,
        pages: 1,
        'EDGE_DB.comments': 7,
        'EDGE_DB.edge_comment_targets': 2,
        'EDGE_DB.newsletter_subscriptions': 3,
        'EDGE_DB.form_submissions': 4,
      },
      insertedRows: {},
      updatedRows: {},
    });
    expect(clearEdge).toHaveBeenCalledWith({ edgeDb: edgeDatabase });
    expect(clearNewsletter).toHaveBeenCalledWith({ edgeDb: edgeDatabase });
    expect(clearForms).toHaveBeenCalledWith({ edgeDb: edgeDatabase });
    expect(clearStudio).toHaveBeenCalledWith({
      db: database,
      administratorId,
      now: undefined,
      createRevision: undefined,
    });
    expect(clearEdge.mock.invocationCallOrder[0])
      .toBeLessThan(clearNewsletter.mock.invocationCallOrder[0] ?? 0);
    expect(clearNewsletter.mock.invocationCallOrder[0])
      .toBeLessThan(clearForms.mock.invocationCallOrder[0] ?? 0);
    expect(clearForms.mock.invocationCallOrder[0])
      .toBeLessThan(clearStudio.mock.invocationCallOrder[0] ?? 0);
  });

  it('does not start the Studio phase when the Edge phase fails', async () => {
    const edgeFailure = new StudioOperationalError(
      'MAINTENANCE_EDGE_COMMENT_LIFECYCLE_FAILED',
      {
        metadata: {
          resource: 'EDGE_DB',
          action: 'clear_edge_comment_content',
          phase: 'mutation',
        },
      },
    );
    const clearStudio = vi.fn();

    await expect(clearSiteContentWithEdge({
      db: database,
      edgeDb: edgeDatabase,
      administratorId,
    }, {
      clearEdge: vi.fn().mockRejectedValue(edgeFailure),
      clearNewsletter: vi.fn(),
      clearForms: vi.fn(),
      clearStudio,
    })).rejects.toBe(edgeFailure);
    expect(clearStudio).not.toHaveBeenCalled();
  });

  it('attempts queued R2-backed cleanup after the Studio database phase', async () => {
    const mediaBucket = {} as R2Bucket;
    const drainMediaObjects = vi.fn().mockResolvedValue({
      pendingRows: 2,
      deletedRows: 2,
    });
    await clearSiteContentWithEdge({
      db: database,
      edgeDb: edgeDatabase,
      mediaBucket,
      administratorId,
    }, {
      clearEdge: vi.fn().mockResolvedValue({
        deletedRows: {}, insertedRows: {}, updatedRows: {},
      }),
      clearNewsletter: vi.fn().mockResolvedValue(emptyLifecycleResult),
      clearForms: vi.fn().mockResolvedValue(emptyLifecycleResult),
      clearStudio: vi.fn().mockResolvedValue({
        deletedRows: {}, insertedRows: {}, updatedRows: {},
      }),
      drainMediaObjects,
    });
    expect(drainMediaObjects).toHaveBeenCalledWith({
      db: database,
      bucket: mediaBucket,
      now: undefined,
    });
  });

  it('keeps Studio-owned R2 cleanup while skipping the Edge phase', async () => {
    const mediaBucket = {} as R2Bucket;
    const clearStudio = vi.fn().mockResolvedValue(emptyLifecycleResult);
    const resetStudioDatabase = vi.fn().mockResolvedValue(emptyLifecycleResult);
    const drainMediaObjects = vi.fn().mockResolvedValue({
      pendingRows: 1,
      deletedRows: 1,
    });

    await clearSiteContentWithoutEdge({
      db: database,
      mediaBucket,
      administratorId,
    }, { clearStudio, drainMediaObjects });
    await resetStudioWithoutEdge({
      db: database,
      mediaBucket,
      administratorId,
    }, { resetStudioDatabase, drainMediaObjects });

    expect(clearStudio).toHaveBeenCalledWith({
      db: database,
      administratorId,
      now: undefined,
      createRevision: undefined,
    });
    expect(resetStudioDatabase).toHaveBeenCalledWith({
      db: database,
      administratorId,
      now: undefined,
    });
    expect(drainMediaObjects).toHaveBeenCalledTimes(2);
    expect(drainMediaObjects).toHaveBeenNthCalledWith(1, {
      db: database,
      bucket: mediaBucket,
      now: undefined,
    });
  });

  it('marks a completed Edge phase when the Studio clear phase fails so the operation can be retried safely', async () => {
    const studioFailure = new Error('Studio D1 batch unavailable');

    const operation = clearSiteContentWithEdge({
      db: database,
      edgeDb: edgeDatabase,
      administratorId,
    }, {
      clearEdge: vi.fn().mockResolvedValue({
        deletedRows: {},
        insertedRows: {},
        updatedRows: {},
      }),
      clearNewsletter: vi.fn().mockResolvedValue(emptyLifecycleResult),
      clearForms: vi.fn().mockResolvedValue(emptyLifecycleResult),
      clearStudio: vi.fn().mockRejectedValue(studioFailure),
    });

    await expect(operation).rejects.toMatchObject({
      code: 'CLEAR_SITE_CONTENT_FAILED',
      originalCause: studioFailure,
      operationalMetadata: {
        resource: 'DB',
        action: 'clear_site_content',
        completed_resource: 'EDGE_DB',
      },
    });
  });

  it('coordinates reset and reports the Edge settings reset alongside the rebuilt Studio state', async () => {
    const resetEdge = vi.fn().mockResolvedValue({
      deletedRows: {
        'EDGE_DB.comments': 1,
        'EDGE_DB.edge_comment_targets': 1,
      },
      insertedRows: {},
      updatedRows: { 'EDGE_DB.edge_comment_settings': 1 },
    });
    const resetStudioDatabase = vi.fn().mockResolvedValue({
      deletedRows: { users: 4 },
      insertedRows: { roles: 3 },
      updatedRows: { users: 1 },
    });
    const resetNewsletter = vi.fn().mockResolvedValue({
      deletedRows: { 'EDGE_DB.newsletter_lists': 1 },
      insertedRows: { 'EDGE_DB.newsletter_lists': 1 },
      updatedRows: { 'EDGE_DB.edge_mail_settings': 1 },
    });
    const resetForms = vi.fn().mockResolvedValue({
      deletedRows: { 'EDGE_DB.forms': 2 },
      insertedRows: {},
      updatedRows: { 'EDGE_DB.edge_mail_settings': 1 },
    });
    const now = new Date('2026-08-02T00:00:00.000Z');

    await expect(resetStudioWithEdge({
      db: database,
      edgeDb: edgeDatabase,
      administratorId,
      now,
    }, { resetEdge, resetNewsletter, resetForms, resetStudioDatabase })).resolves.toEqual({
      deletedRows: {
        users: 4,
        'EDGE_DB.comments': 1,
        'EDGE_DB.edge_comment_targets': 1,
        'EDGE_DB.newsletter_lists': 1,
        'EDGE_DB.forms': 2,
      },
      insertedRows: { roles: 3, 'EDGE_DB.newsletter_lists': 1 },
      updatedRows: {
        users: 1,
        'EDGE_DB.edge_comment_settings': 1,
        'EDGE_DB.edge_mail_settings': 1,
      },
    });
    expect(resetEdge).toHaveBeenCalledWith({ edgeDb: edgeDatabase, now });
    expect(resetNewsletter).toHaveBeenCalledWith({
      edgeDb: edgeDatabase,
      now,
    });
    expect(resetForms).toHaveBeenCalledWith({ edgeDb: edgeDatabase });
    expect(resetStudioDatabase).toHaveBeenCalledWith({
      db: database,
      administratorId,
      now,
    });
    expect(resetEdge.mock.invocationCallOrder[0])
      .toBeLessThan(resetNewsletter.mock.invocationCallOrder[0] ?? 0);
    expect(resetNewsletter.mock.invocationCallOrder[0])
      .toBeLessThan(resetForms.mock.invocationCallOrder[0] ?? 0);
    expect(resetForms.mock.invocationCallOrder[0])
      .toBeLessThan(resetStudioDatabase.mock.invocationCallOrder[0] ?? 0);
  });

  it('marks the reset Edge phase complete when rebuilding Studio fails', async () => {
    const studioFailure = new Error('Studio reset batch unavailable');

    await expect(resetStudioWithEdge({
      db: database,
      edgeDb: edgeDatabase,
      administratorId,
    }, {
      resetEdge: vi.fn().mockResolvedValue({
        deletedRows: {},
        insertedRows: {},
        updatedRows: {},
      }),
      resetNewsletter: vi.fn().mockResolvedValue(emptyLifecycleResult),
      resetForms: vi.fn().mockResolvedValue(emptyLifecycleResult),
      resetStudioDatabase: vi.fn().mockRejectedValue(studioFailure),
    })).rejects.toMatchObject({
      code: 'STUDIO_RESET_FAILED',
      originalCause: studioFailure,
      operationalMetadata: {
        resource: 'DB',
        action: 'reset_studio',
        completed_resource: 'EDGE_DB',
      },
    });
  });
});
