import {
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import {
  clearSiteContent,
  resetStudio,
  type ClearSiteContentInput,
  type DatabaseOperationResult,
  type ResetStudioInput,
} from './database-operations';
import {
  clearEdgeCommentContent,
  resetEdgeCommentRuntime,
  type EdgeCommentLifecycleResult,
} from './edge-comment-lifecycle';
import {
  clearEdgeNewsletterContent,
  resetEdgeNewsletterRuntime,
} from './edge-newsletter-lifecycle';
import {
  clearEdgeFormContent,
  resetEdgeFormRuntime,
} from './edge-form-lifecycle';
import { drainMediaObjectDeletionQueue } from '../media/media-object-cleanup';

type CoordinatedClearInput = ClearSiteContentInput & {
  edgeDb: D1Database;
  mediaBucket?: R2Bucket;
};

type CoordinatedResetInput = ResetStudioInput & {
  edgeDb: D1Database;
  mediaBucket?: R2Bucket;
};

type StudioOnlyClearInput = ClearSiteContentInput & {
  mediaBucket?: R2Bucket;
};

type StudioOnlyResetInput = ResetStudioInput & {
  mediaBucket?: R2Bucket;
};

type ClearDependencies = {
  clearEdge?: typeof clearEdgeCommentContent;
  clearNewsletter?: typeof clearEdgeNewsletterContent;
  clearForms?: typeof clearEdgeFormContent;
  clearStudio?: typeof clearSiteContent;
  drainMediaObjects?: typeof drainMediaObjectDeletionQueue;
};

type ResetDependencies = {
  resetEdge?: typeof resetEdgeCommentRuntime;
  resetNewsletter?: typeof resetEdgeNewsletterRuntime;
  resetForms?: typeof resetEdgeFormRuntime;
  resetStudioDatabase?: typeof resetStudio;
  drainMediaObjects?: typeof drainMediaObjectDeletionQueue;
};

async function drainQueuedMediaObjects(input: {
  db: D1Database;
  mediaBucket?: R2Bucket;
  now?: Date;
  drain: typeof drainMediaObjectDeletionQueue;
}) {
  if (!input.mediaBucket) return;
  try {
    await input.drain({
      db: input.db,
      bucket: input.mediaBucket,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, { trigger: 'maintenance_operation' });
    }
    // The durable outbox is intentionally retained. Content/reset completion
    // does not become ambiguous merely because physical R2 cleanup is delayed.
  }
}

function mergeEffects(
  studio: DatabaseOperationResult,
  ...edgeResults: EdgeCommentLifecycleResult[]
): DatabaseOperationResult {
  const edge = edgeResults.reduce<EdgeCommentLifecycleResult>(
    (combined, result) => ({
      deletedRows: { ...combined.deletedRows, ...result.deletedRows },
      insertedRows: { ...combined.insertedRows, ...result.insertedRows },
      updatedRows: { ...combined.updatedRows, ...result.updatedRows },
    }),
    { deletedRows: {}, insertedRows: {}, updatedRows: {} },
  );
  return {
    deletedRows: { ...studio.deletedRows, ...edge.deletedRows },
    insertedRows: { ...studio.insertedRows, ...edge.insertedRows },
    updatedRows: { ...studio.updatedRows, ...edge.updatedRows },
  };
}

function completedEdgePhaseFailure(input: {
  code: 'CLEAR_SITE_CONTENT_FAILED' | 'STUDIO_RESET_FAILED';
  action: 'clear_site_content' | 'reset_studio';
  cause: unknown;
}): StudioOperationalError {
  const operationalCause = input.cause instanceof StudioOperationalError
    ? input.cause
    : null;
  return new StudioOperationalError(input.code, {
    cause: operationalCause?.originalCause ?? input.cause,
    metadata: {
      ...operationalCause?.operationalMetadata,
      resource: 'DB',
      action: input.action,
      completed_resource: 'EDGE_DB',
    },
  });
}

export async function clearSiteContentWithEdge(
  input: CoordinatedClearInput,
  dependencies: ClearDependencies = {},
): Promise<DatabaseOperationResult> {
  const edgeResult = await (
    dependencies.clearEdge ?? clearEdgeCommentContent
  )({ edgeDb: input.edgeDb });
  const newsletterResult = await (
    dependencies.clearNewsletter ?? clearEdgeNewsletterContent
  )({ edgeDb: input.edgeDb });
  const formResult = await (
    dependencies.clearForms ?? clearEdgeFormContent
  )({ edgeDb: input.edgeDb });

  let studioResult: DatabaseOperationResult;
  try {
    studioResult = await (
      dependencies.clearStudio ?? clearSiteContent
    )({
      db: input.db,
      administratorId: input.administratorId,
      now: input.now,
      createRevision: input.createRevision,
    });
  } catch (error) {
    throw completedEdgePhaseFailure({
      code: 'CLEAR_SITE_CONTENT_FAILED',
      action: 'clear_site_content',
      cause: error,
    });
  }
  await drainQueuedMediaObjects({
    db: input.db,
    mediaBucket: input.mediaBucket,
    now: input.now,
    drain: dependencies.drainMediaObjects ?? drainMediaObjectDeletionQueue,
  });
  return mergeEffects(studioResult, edgeResult, newsletterResult, formResult);
}

export async function clearSiteContentWithoutEdge(
  input: StudioOnlyClearInput,
  dependencies: Pick<ClearDependencies, 'clearStudio' | 'drainMediaObjects'> = {},
): Promise<DatabaseOperationResult> {
  const studioResult = await (
    dependencies.clearStudio ?? clearSiteContent
  )({
    db: input.db,
    administratorId: input.administratorId,
    now: input.now,
    createRevision: input.createRevision,
  });
  await drainQueuedMediaObjects({
    db: input.db,
    mediaBucket: input.mediaBucket,
    now: input.now,
    drain: dependencies.drainMediaObjects ?? drainMediaObjectDeletionQueue,
  });
  return studioResult;
}

export async function resetStudioWithEdge(
  input: CoordinatedResetInput,
  dependencies: ResetDependencies = {},
): Promise<DatabaseOperationResult> {
  const edgeResult = await (
    dependencies.resetEdge ?? resetEdgeCommentRuntime
  )({ edgeDb: input.edgeDb, now: input.now });
  const newsletterResult = await (
    dependencies.resetNewsletter ?? resetEdgeNewsletterRuntime
  )({ edgeDb: input.edgeDb, now: input.now });
  const formResult = await (
    dependencies.resetForms ?? resetEdgeFormRuntime
  )({ edgeDb: input.edgeDb });

  let studioResult: DatabaseOperationResult;
  try {
    studioResult = await (
      dependencies.resetStudioDatabase ?? resetStudio
    )({
      db: input.db,
      administratorId: input.administratorId,
      now: input.now,
    });
  } catch (error) {
    throw completedEdgePhaseFailure({
      code: 'STUDIO_RESET_FAILED',
      action: 'reset_studio',
      cause: error,
    });
  }
  await drainQueuedMediaObjects({
    db: input.db,
    mediaBucket: input.mediaBucket,
    now: input.now,
    drain: dependencies.drainMediaObjects ?? drainMediaObjectDeletionQueue,
  });
  return mergeEffects(studioResult, edgeResult, newsletterResult, formResult);
}

export async function resetStudioWithoutEdge(
  input: StudioOnlyResetInput,
  dependencies: Pick<ResetDependencies, 'resetStudioDatabase' | 'drainMediaObjects'> = {},
): Promise<DatabaseOperationResult> {
  const studioResult = await (
    dependencies.resetStudioDatabase ?? resetStudio
  )({
    db: input.db,
    administratorId: input.administratorId,
    now: input.now,
  });
  await drainQueuedMediaObjects({
    db: input.db,
    mediaBucket: input.mediaBucket,
    now: input.now,
    drain: dependencies.drainMediaObjects ?? drainMediaObjectDeletionQueue,
  });
  return studioResult;
}
