import { StudioOperationalError } from '../lib/operational-error';
import type { EdgeCommentLifecycleResult } from './edge-comment-lifecycle';

export const EDGE_FORM_EFFECT_KEYS = {
  forms: 'EDGE_DB.forms',
  fields: 'EDGE_DB.form_fields',
  submissions: 'EDGE_DB.form_submissions',
  values: 'EDGE_DB.form_submission_values',
} as const;

type CountRow = {
  forms_count?: unknown;
  fields_count?: unknown;
  submissions_count?: unknown;
  values_count?: unknown;
};

type VerificationRow = CountRow;

function failure(input: {
  cause: unknown;
  action: 'clear_edge_form_content' | 'reset_edge_form_runtime';
  phase: 'mutation' | 'verification';
}) {
  return new StudioOperationalError('MAINTENANCE_EDGE_FORM_LIFECYCLE_FAILED', {
    cause: input.cause,
    metadata: {
      resource: 'EDGE_DB',
      action: input.action,
      phase: input.phase,
    },
  });
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`EDGE_DB returned an invalid ${name}.`);
  }
  return Number(value);
}

const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM forms) AS forms_count,
    (SELECT COUNT(*) FROM form_fields) AS fields_count,
    (SELECT COUNT(*) FROM form_submissions) AS submissions_count,
    (SELECT COUNT(*) FROM form_submission_values) AS values_count
`;

function deletedRows(initial: CountRow, reset: boolean) {
  return {
    [EDGE_FORM_EFFECT_KEYS.values]: count(initial.values_count, 'Form value count'),
    [EDGE_FORM_EFFECT_KEYS.submissions]: count(initial.submissions_count, 'Form submission count'),
    ...(reset ? {
      [EDGE_FORM_EFFECT_KEYS.fields]: count(initial.fields_count, 'Form field count'),
      [EDGE_FORM_EFFECT_KEYS.forms]: count(initial.forms_count, 'Form count'),
    } : {}),
  };
}

export async function clearEdgeFormContent(input: {
  edgeDb: D1Database;
}): Promise<EdgeCommentLifecycleResult> {
  const action = 'clear_edge_form_content' as const;
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(COUNT_SQL),
      input.edgeDb.prepare('DELETE FROM form_submission_values'),
      input.edgeDb.prepare('DELETE FROM form_submissions'),
    ]);
  } catch (error) {
    throw failure({ cause: error, action, phase: 'mutation' });
  }
  const initial = results[0]?.results?.[0] as CountRow | undefined;
  try {
    const verification = await input.edgeDb.prepare(COUNT_SQL)
      .first<VerificationRow>();
    if (
      !initial
      || !verification
      || count(verification.submissions_count, 'remaining Form submission count') !== 0
      || count(verification.values_count, 'remaining Form value count') !== 0
      || count(verification.forms_count, 'preserved Form count')
        !== count(initial.forms_count, 'initial Form count')
      || count(verification.fields_count, 'preserved Form field count')
        !== count(initial.fields_count, 'initial Form field count')
    ) throw new TypeError('EDGE_DB Form content verification failed.');
    return {
      deletedRows: deletedRows(initial, false),
      insertedRows: {},
      updatedRows: {},
    };
  } catch (error) {
    throw failure({ cause: error, action, phase: 'verification' });
  }
}

export async function resetEdgeFormRuntime(input: {
  edgeDb: D1Database;
}): Promise<EdgeCommentLifecycleResult> {
  const action = 'reset_edge_form_runtime' as const;
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(COUNT_SQL),
      input.edgeDb.prepare('DELETE FROM form_submission_values'),
      input.edgeDb.prepare('DELETE FROM form_submissions'),
      input.edgeDb.prepare('DELETE FROM form_fields'),
      input.edgeDb.prepare('DELETE FROM forms'),
    ]);
  } catch (error) {
    throw failure({ cause: error, action, phase: 'mutation' });
  }
  const initial = results[0]?.results?.[0] as CountRow | undefined;
  try {
    const verification = await input.edgeDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM forms) AS forms_count,
        (SELECT COUNT(*) FROM form_fields) AS fields_count,
        (SELECT COUNT(*) FROM form_submissions) AS submissions_count,
        (SELECT COUNT(*) FROM form_submission_values) AS values_count
    `).first<VerificationRow>();
    if (
      !initial
      || !verification
      || count(verification.forms_count, 'remaining Form count') !== 0
      || count(verification.fields_count, 'remaining Form field count') !== 0
      || count(verification.submissions_count, 'remaining Form submission count') !== 0
      || count(verification.values_count, 'remaining Form value count') !== 0
    ) throw new TypeError('EDGE_DB Form reset verification failed.');
    return {
      deletedRows: deletedRows(initial, true),
      insertedRows: {},
      updatedRows: {},
    };
  } catch (error) {
    throw failure({ cause: error, action, phase: 'verification' });
  }
}
