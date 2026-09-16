import {
  BRANDING_SETTINGS_INITIAL_REVISION,
  brandingMediaAssetSchema,
  materializeSiteBrandingSettingsDefaults,
  siteBrandingDocumentSchema,
  siteBrandingSlots,
  type BrandingMediaAsset,
  type BrandingMediaFormat,
  type SiteBrandingDocument,
  type SiteBrandingSettings,
} from '../../../contracts/branding-settings';
import {
  isR2MediaPreviewSafeImage,
  mediaIdSchema,
  mediaLocationSchema,
  type MediaLocation,
} from '../../../contracts/media';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  MEDIA_SETTINGS_READ_KEYS,
  materializeMediaSettingsDocument,
} from './media-settings-repository';
import {
  createSettingsRevision,
  type StoredSettingRow,
} from './revisioned-settings-repository';

const BRANDING_REVISION_KEY = 'site_branding_revision';
const FAVICON_MIME_TYPES = new Set([
  'image/png',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

type SiteAssetRow = {
  slot: unknown;
  media_id: unknown;
  alt_text: unknown;
  updated_at_iso: unknown;
  kind: unknown;
  filename: unknown;
  mime_type: unknown;
  storage_type: unknown;
  storage_key: unknown;
  external_url: unknown;
  revision: unknown;
};

type CandidateRow = Omit<SiteAssetRow, 'slot' | 'alt_text' | 'updated_at_iso'>;

type SelectionIssue =
  | 'media_not_found'
  | 'media_type_not_allowed';

export type UpdateSiteBrandingResult =
  | { kind: 'completed'; document: SiteBrandingDocument }
  | { kind: 'revision_conflict' }
  | { kind: 'media_not_found' }
  | { kind: 'media_type_not_allowed' };

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('SITE_BRANDING_SETTINGS_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_site_branding' },
  });
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'SITE_BRANDING_SETTINGS_DATABASE_QUERY_FAILED',
    { cause: error, metadata: { resource: 'DB', action } },
  );
}

function writeFailure(error: unknown): StudioOperationalError {
  return new StudioOperationalError(
    'SITE_BRANDING_SETTINGS_DATABASE_WRITE_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action: 'update_site_branding' },
    },
  );
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function rowLocation(row: Pick<
  SiteAssetRow,
  'storage_type' | 'storage_key' | 'external_url'
>): MediaLocation {
  const parsed = mediaLocationSchema.safeParse(row.storage_type === 'external'
    ? { type: 'external', url: row.external_url }
    : { type: 'r2', key: row.storage_key });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function mediaFormat(mimeType: string): BrandingMediaFormat {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/svg+xml') return 'svg';
  if (mimeType === 'image/x-icon' || mimeType === 'image/vnd.microsoft.icon') {
    return 'ico';
  }
  return 'other_image';
}

function mediaPreviewUrl(
  row: CandidateRow,
  location: MediaLocation,
  mediaOrigin: string,
): string | null {
  if (location.type === 'external') return location.url;
  if (mediaOrigin) return `${mediaOrigin}/${location.key}`;
  if (!isR2MediaPreviewSafeImage(
    String(row.mime_type),
    location.key,
  )) return null;
  const mediaId = mediaIdSchema.safeParse(row.media_id);
  const revision = settingsRevisionSchema.safeParse(row.revision);
  if (!mediaId.success || !revision.success) throw dataInvalid();
  return `/api/media/${mediaId.data}/preview?revision=${revision.data}`;
}

function parseBrandingMedia(
  row: CandidateRow,
  mediaOrigin: string,
): BrandingMediaAsset {
  if (row.kind !== 'image') throw dataInvalid();
  const location = rowLocation(row);
  const parsed = brandingMediaAssetSchema.safeParse({
    id: row.media_id,
    filename: row.filename,
    mime_type: row.mime_type,
    location,
    format: mediaFormat(String(row.mime_type)),
    preview_url: mediaPreviewUrl(row, location, mediaOrigin),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseStoredSettingsRows(
  rows: readonly unknown[],
): StoredSettingRow[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw dataInvalid();
    const candidate = row as Record<string, unknown>;
    if (
      typeof candidate.key !== 'string'
      || typeof candidate.value !== 'string'
      || typeof candidate.type !== 'string'
      || typeof candidate.updated_at_iso !== 'string'
    ) throw dataInvalid();
    return {
      key: candidate.key,
      value: candidate.value,
      type: candidate.type,
      updated_at_iso: candidate.updated_at_iso,
    };
  });
}

export function materializeSiteBrandingDocument(input: {
  settingRows: readonly StoredSettingRow[];
  assetRows: readonly SiteAssetRow[];
}): SiteBrandingDocument {
  const byKey = new Map(input.settingRows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(BRANDING_REVISION_KEY);
  const mediaDocument = materializeMediaSettingsDocument(
    input.settingRows.filter((row) => (
      (MEDIA_SETTINGS_READ_KEYS as readonly string[]).includes(row.key)
    )),
  );
  if (!revisionRow) {
    if (input.assetRows.length > 0) throw dataInvalid();
    return siteBrandingDocumentSchema.parse({
      settings: materializeSiteBrandingSettingsDefaults(),
      selected_assets: {
        icon: null,
        icon_dark: null,
        apple_touch_icon: null,
        logo: null,
      },
      revision: BRANDING_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
  }
  if (
    revisionRow.type !== 'string'
    || !settingsRevisionSchema.safeParse(revisionRow.value).success
    || revisionRow.value === BRANDING_SETTINGS_INITIAL_REVISION
  ) throw dataInvalid();

  const rowsBySlot = new Map<string, SiteAssetRow>();
  for (const row of input.assetRows) {
    if (
      typeof row.slot !== 'string'
      || !(siteBrandingSlots as readonly string[]).includes(row.slot)
      || rowsBySlot.has(row.slot)
      || row.updated_at_iso !== revisionRow.updated_at_iso
    ) throw dataInvalid();
    rowsBySlot.set(row.slot, row);
  }
  const readAsset = (slot: string): BrandingMediaAsset | null => {
    const row = rowsBySlot.get(slot);
    return row
      ? parseBrandingMedia(row, mediaDocument.settings.media_origin)
      : null;
  };
  const icon = readAsset('favicon');
  const iconDark = readAsset('favicon_dark');
  const appleTouchIcon = readAsset('apple_touch_icon');
  const logo = readAsset('logo');
  if ([icon, iconDark, appleTouchIcon].some(
    (asset) => asset && !FAVICON_MIME_TYPES.has(asset.mime_type),
  )) throw dataInvalid();
  const logoRow = rowsBySlot.get('logo');
  if (logoRow && logoRow.alt_text !== null && typeof logoRow.alt_text !== 'string') {
    throw dataInvalid();
  }
  if ([...rowsBySlot.entries()].some(
    ([slot, row]) => slot !== 'logo' && row.alt_text !== null,
  )) throw dataInvalid();

  const parsed = siteBrandingDocumentSchema.safeParse({
    settings: {
      favicon: {
        icon_media_id: icon?.id ?? null,
        icon_dark_media_id: iconDark?.id ?? null,
        apple_touch_icon_media_id: appleTouchIcon?.id ?? null,
      },
      logo: {
        media_id: logo?.id ?? null,
        alt: typeof logoRow?.alt_text === 'string' ? logoRow.alt_text : '',
      },
    },
    selected_assets: {
      icon,
      icon_dark: iconDark,
      apple_touch_icon: appleTouchIcon,
      logo,
    },
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

export async function readSiteBranding(input: {
  db: D1Database;
}): Promise<SiteBrandingDocument> {
  const settingKeys = [
    BRANDING_REVISION_KEY,
    ...MEDIA_SETTINGS_READ_KEYS,
  ];
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT key, value, type, updated_at_iso
        FROM site_settings
        WHERE key IN (${settingKeys.map(() => '?').join(', ')})
      `).bind(...settingKeys),
      input.db.prepare(`
        SELECT
          site_assets.slot,
          site_assets.media_id,
          site_assets.alt_text,
          site_assets.updated_at_iso,
          media.kind,
          media.filename,
          media.mime_type,
          media.storage_type,
          media.storage_key,
          media.external_url,
          media.revision
        FROM site_assets
        LEFT JOIN media ON media.id = site_assets.media_id
        ORDER BY site_assets.slot
      `),
    ]);
    if (!Array.isArray(results[0]?.results) || !Array.isArray(results[1]?.results)) {
      throw new TypeError('D1 returned invalid Site Branding rows.');
    }
    return materializeSiteBrandingDocument({
      settingRows: parseStoredSettingsRows(results[0].results),
      assetRows: results[1].results as SiteAssetRow[],
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_site_branding');
  }
}

function selectedMediaIds(settings: SiteBrandingSettings): string[] {
  return [...new Set([
    settings.favicon.icon_media_id,
    settings.favicon.icon_dark_media_id,
    settings.favicon.apple_touch_icon_media_id,
    settings.logo.media_id,
  ].filter((id): id is string => id !== null))];
}

async function validateSelection(input: {
  db: D1Database;
  settings: SiteBrandingSettings;
}): Promise<SelectionIssue | null> {
  const ids = selectedMediaIds(input.settings);
  if (ids.length === 0) return null;
  const result = await input.db.prepare(`
    SELECT id AS media_id, kind, filename, mime_type, storage_type,
           storage_key, external_url, revision
    FROM media
    WHERE id IN (${ids.map(() => '?').join(', ')})
  `).bind(...ids).all<CandidateRow>();
  const rows = result.results ?? [];
  if (rows.length !== ids.length) return 'media_not_found';
  const byId = new Map(rows.map((row) => [row.media_id, row]));
  const faviconIds = [
    input.settings.favicon.icon_media_id,
    input.settings.favicon.icon_dark_media_id,
    input.settings.favicon.apple_touch_icon_media_id,
  ].filter((id): id is string => id !== null);
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.kind !== 'image') return 'media_type_not_allowed';
  }
  for (const id of faviconIds) {
    const row = byId.get(id);
    if (!row || !FAVICON_MIME_TYPES.has(String(row.mime_type))) {
      return 'media_type_not_allowed';
    }
  }
  return null;
}

function siteAssetConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /site asset must reference compatible (?:public )?image media|foreign key constraint failed/iu
    .test(message);
}

export async function updateSiteBranding(input: {
  db: D1Database;
  settings: SiteBrandingSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<UpdateSiteBrandingResult> {
  try {
    const current = await readSiteBranding({ db: input.db });
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const issue = await validateSelection({
      db: input.db,
      settings: input.settings,
    });
    if (issue) return { kind: issue };

    const nextRevision = settingsRevisionSchema.parse(
      (input.createRevision ?? createSettingsRevision)(),
    );
    if (
      nextRevision === BRANDING_SETTINGS_INITIAL_REVISION
      || nextRevision === input.expectedRevision
    ) throw new TypeError('Site Branding revision must advance.');
    const nowIso = (input.now ?? new Date()).toISOString();
    const revisionStatement = input.db.prepare(`
      INSERT INTO site_settings (
        key, value, type, updated_by, updated_at_iso
      )
      SELECT ?, ?, 'string', ?, ?
      WHERE (
        (
          ? = ?
          AND NOT EXISTS (
            SELECT 1 FROM site_settings WHERE key = ?
          )
          AND NOT EXISTS (SELECT 1 FROM site_assets)
        )
        OR EXISTS (
          SELECT 1 FROM site_settings
          WHERE key = ? AND type = 'string' AND value = ?
        )
      )
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        type = 'string',
        updated_by = excluded.updated_by,
        updated_at_iso = excluded.updated_at_iso
      WHERE site_settings.type = 'string'
        AND site_settings.value = ?
    `).bind(
      BRANDING_REVISION_KEY,
      nextRevision,
      input.updatedBy,
      nowIso,
      input.expectedRevision,
      BRANDING_SETTINGS_INITIAL_REVISION,
      BRANDING_REVISION_KEY,
      BRANDING_REVISION_KEY,
      input.expectedRevision,
      input.expectedRevision,
    );
    const statements: D1PreparedStatement[] = [
      revisionStatement,
      input.db.prepare(`
        DELETE FROM site_assets
        WHERE EXISTS (
          SELECT 1 FROM site_settings
          WHERE key = ? AND type = 'string' AND value = ?
        )
      `).bind(BRANDING_REVISION_KEY, nextRevision),
    ];
    const selections = [
      ['favicon', input.settings.favicon.icon_media_id, null],
      ['favicon_dark', input.settings.favicon.icon_dark_media_id, null],
      ['apple_touch_icon', input.settings.favicon.apple_touch_icon_media_id, null],
      [
        'logo',
        input.settings.logo.media_id,
        input.settings.logo.alt || null,
      ],
    ] as const;
    for (const [slot, mediaId, altText] of selections) {
      if (!mediaId) continue;
      statements.push(input.db.prepare(`
        INSERT INTO site_assets (
          slot, media_id, alt_text, updated_by, updated_at_iso
        )
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM site_settings
          WHERE key = ? AND type = 'string' AND value = ?
        )
      `).bind(
        slot,
        mediaId,
        altText,
        input.updatedBy,
        nowIso,
        BRANDING_REVISION_KEY,
        nextRevision,
      ));
    }
    const results = await input.db.batch(statements);
    if (readChanges(results[0]) !== 1) return { kind: 'revision_conflict' };
    if (results.slice(2).some((result) => readChanges(result) !== 1)) {
      throw new TypeError('D1 returned an incomplete Site Branding batch.');
    }
    return {
      kind: 'completed',
      document: await readSiteBranding({ db: input.db }),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (siteAssetConstraint(error)) {
      try {
        const issue = await validateSelection({
          db: input.db,
          settings: input.settings,
        });
        if (issue) return { kind: issue };
      } catch {
        // The original write failure remains the authoritative diagnostic.
      }
    }
    throw writeFailure(error);
  }
}

export function projectSiteBranding(
  document: SiteBrandingDocument,
): {
  favicon?: {
    icon?: string;
    icon_dark?: string;
    svg?: string;
    png?: string;
    apple_touch_icon?: string;
  };
  logo?: { src: string; alt?: string };
} {
  const previewSource = (asset: BrandingMediaAsset): string => (
    asset.location.type === 'external'
      ? asset.location.url
      : `/${asset.location.key}`
  );
  const favicon: {
    icon?: string;
    icon_dark?: string;
    svg?: string;
    png?: string;
    apple_touch_icon?: string;
  } = {};
  const icon = document.selected_assets.icon;
  if (icon) {
    const key = icon.format === 'svg'
      ? 'svg'
      : icon.format === 'png'
        ? 'png'
        : 'icon';
    favicon[key] = previewSource(icon);
  }
  if (document.selected_assets.icon_dark) {
    favicon.icon_dark = previewSource(document.selected_assets.icon_dark);
  }
  if (document.selected_assets.apple_touch_icon) {
    favicon.apple_touch_icon = previewSource(
      document.selected_assets.apple_touch_icon,
    );
  }
  const logo = document.selected_assets.logo;
  return {
    ...(Object.keys(favicon).length > 0 ? { favicon } : {}),
    ...(logo
      ? {
          logo: {
            src: previewSource(logo),
            ...(document.settings.logo.alt
              ? { alt: document.settings.logo.alt }
              : {}),
          },
        }
      : {}),
  };
}
