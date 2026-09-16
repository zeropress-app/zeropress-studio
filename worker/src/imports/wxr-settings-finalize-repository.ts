import type {
  NormalizedWxrImportSettingsFinalizeRequest,
} from '../../../contracts/wxr-import';
import { StudioOperationalError } from '../lib/operational-error';
import {
  GENERAL_SETTINGS_REVISION_KEY,
  GENERAL_SETTINGS_STORAGE_KEYS,
  readGeneralSettings,
  serializeGeneralSettings,
} from '../settings/general-settings-repository';
import {
  publishedPageExists,
  readRoutingSettings,
  ROUTING_SETTINGS_REVISION_KEY,
  ROUTING_SETTINGS_STORAGE_KEYS,
  serializeRoutingSettings,
} from '../settings/routing-settings-repository';
import {
  prepareRevisionedSettingsUpdate,
  revisionExpectationGuard,
  revisionedSettingsUpdateApplied,
  type PreparedRevisionedSettingsUpdate,
} from '../settings/revisioned-settings-repository';

type SettingsResult = 'updated' | 'unchanged';

export type WxrSettingsFinalizeResult =
  | { kind: 'revision_conflict' }
  | { kind: 'front_page_not_found' }
  | {
      kind: 'completed';
      generalSettings: {
        result: SettingsResult;
        document: Awaited<ReturnType<typeof readGeneralSettings>>;
      };
      routingSettings: {
        result: SettingsResult;
        document: Awaited<ReturnType<typeof readRoutingSettings>>;
      };
    };

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sliceResults(
  results: readonly D1Result<unknown>[],
  offset: number,
  prepared: PreparedRevisionedSettingsUpdate | null,
): readonly D1Result<unknown>[] {
  return prepared
    ? results.slice(offset, offset + prepared.statements.length)
    : [];
}

export async function finalizeWxrSettings(input: {
  db: D1Database;
  request: NormalizedWxrImportSettingsFinalizeRequest;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<WxrSettingsFinalizeResult> {
  try {
    const [currentGeneral, currentRouting] = await Promise.all([
      readGeneralSettings({ db: input.db }),
      readRoutingSettings({ db: input.db }),
    ]);
    if (
      currentGeneral.revision
        !== input.request.general_settings.expected_revision
      || currentRouting.revision
        !== input.request.routing_settings.expected_revision
    ) return { kind: 'revision_conflict' };

    const generalChanged = !sameValue(
      currentGeneral.settings,
      input.request.general_settings.settings,
    );
    const routingChanged = !sameValue(
      currentRouting.settings,
      input.request.routing_settings.settings,
    );
    if (
      routingChanged
      && input.request.routing_settings.settings.front_page.type === 'page'
      && !await publishedPageExists(
        input.db,
        input.request.routing_settings.settings.front_page.page_id,
      )
    ) return { kind: 'front_page_not_found' };

    if (!generalChanged && !routingChanged) {
      return {
        kind: 'completed',
        generalSettings: { result: 'unchanged', document: currentGeneral },
        routingSettings: { result: 'unchanged', document: currentRouting },
      };
    }

    const now = input.now ?? new Date();
    const routingCurrentGuard = revisionExpectationGuard({
      revisionKey: ROUTING_SETTINGS_REVISION_KEY,
      settingKeys: Object.values(ROUTING_SETTINGS_STORAGE_KEYS),
      expectedRevision: currentRouting.revision,
    });
    const generalPrepared = generalChanged
      ? prepareRevisionedSettingsUpdate({
          db: input.db,
          revisionKey: GENERAL_SETTINGS_REVISION_KEY,
          settings: serializeGeneralSettings(
            input.request.general_settings.settings,
          ),
          expectedRevision: currentGeneral.revision,
          updatedBy: input.updatedBy,
          now,
          createRevision: input.createRevision,
          writeGuard: routingCurrentGuard,
        })
      : null;
    const generalGuard = revisionExpectationGuard({
      revisionKey: GENERAL_SETTINGS_REVISION_KEY,
      settingKeys: Object.values(GENERAL_SETTINGS_STORAGE_KEYS),
      expectedRevision: generalPrepared?.revision ?? currentGeneral.revision,
    });
    const routingPrepared = routingChanged
      ? prepareRevisionedSettingsUpdate({
          db: input.db,
          revisionKey: ROUTING_SETTINGS_REVISION_KEY,
          settings: serializeRoutingSettings(
            input.request.routing_settings.settings,
          ),
          expectedRevision: currentRouting.revision,
          updatedBy: input.updatedBy,
          now,
          createRevision: input.createRevision,
          writeGuard: generalGuard,
        })
      : null;
    const statements = [
      ...(generalPrepared?.statements ?? []),
      ...(routingPrepared?.statements ?? []),
    ];
    const results = await input.db.batch(statements);
    const generalApplied = generalPrepared
      ? revisionedSettingsUpdateApplied(
          generalPrepared,
          sliceResults(results, 0, generalPrepared),
        )
      : true;
    const routingOffset = generalPrepared?.statements.length ?? 0;
    const routingApplied = routingPrepared
      ? revisionedSettingsUpdateApplied(
          routingPrepared,
          sliceResults(results, routingOffset, routingPrepared),
        )
      : true;
    if (!generalApplied || !routingApplied) {
      if (generalApplied !== routingApplied && generalPrepared && routingPrepared) {
        throw new TypeError('D1 partially finalized WXR settings.');
      }
      return { kind: 'revision_conflict' };
    }

    return {
      kind: 'completed',
      generalSettings: generalPrepared
        ? {
            result: 'updated',
            document: {
              settings: input.request.general_settings.settings,
              revision: generalPrepared.revision,
              updated_at_iso: generalPrepared.updatedAtIso,
            },
          }
        : { result: 'unchanged', document: currentGeneral },
      routingSettings: routingPrepared
        ? {
            result: 'updated',
            document: {
              settings: input.request.routing_settings.settings,
              revision: routingPrepared.revision,
              updated_at_iso: routingPrepared.updatedAtIso,
            },
          }
        : { result: 'unchanged', document: currentRouting },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('WXR_IMPORT_DATABASE_WRITE_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'finalize_wxr_settings' },
    });
  }
}
