import {
  getLogErrorType,
  logError,
  logInfo,
  logWarn,
} from './log';

type OperationalLogDefinition = {
  level: 'error' | 'warn' | 'info';
  message: string;
  guidance?: string;
};

export const OPERATIONAL_LOG_DEFINITIONS = {
  AUDIT_WRITE_FAILED: { level: 'warn', message: 'Audit record could not be saved' },
  AUDIT_IP_HASH_FAILED: { level: 'warn', message: 'Audit IP hashing failed; the raw IP was omitted' },
  AUDIT_SNAPSHOT_FAILED: { level: 'warn', message: 'Audit actor snapshot could not be read' },
  AUDIT_READ_FAILED: { level: 'warn', message: 'Audit records could not be read' },
  AUDIT_RETENTION_FAILED: { level: 'warn', message: 'Audit retention cleanup failed' },

  SITE_MODE_CONFIGURATION_INVALID: {
    level: 'error',
    message: 'Studio site mode configuration is invalid',
    guidance: 'Set STUDIO_SITE_MODE to exactly one of initial, operational, maintenance, or recovery, then redeploy the Worker configuration.',
  },
  AUTH_SECRET_NOT_CONFIGURED: {
    level: 'error',
    message: 'Studio authentication secret is not configured',
    guidance: 'Create a unique STUDIO_AUTH_SECRET Worker secret containing 32–256 printable ASCII characters without spaces, then redeploy before installation or normal sign-in.',
  },
  INSTALL_TOKEN_NOT_CONFIGURED: {
    level: 'error',
    message: 'Studio install token is not configured',
    guidance: 'Create a STUDIO_INSTALL_TOKEN Worker secret containing 32–256 printable ASCII characters without spaces before opening the installer. Remove it after installation is complete.',
  },
  INSTALL_TOKEN_STILL_CONFIGURED: {
    level: 'error',
    message: 'Studio install token remains configured after installation',
    guidance: 'Delete the STUDIO_INSTALL_TOKEN Worker secret binding instead of replacing it with a blank value, then redeploy the Worker configuration. Keep the token only while installing an uninstalled Studio database in initial mode.',
  },
  DATABASE_STATUS_QUERY_FAILED: {
    level: 'error',
    message: 'Studio database status query failed',
    guidance: 'Verify the DB binding targets the Studio database and check Cloudflare D1 availability, then retry.',
  },
  DATABASE_UNINSTALLED: {
    level: 'error',
    message: 'Studio database is not installed',
    guidance: 'Set STUDIO_SITE_MODE to initial, configure a STUDIO_INSTALL_TOKEN containing 32–256 printable ASCII characters without spaces, and redeploy the Worker configuration. Complete installation, remove STUDIO_INSTALL_TOKEN, then set STUDIO_SITE_MODE to operational and redeploy again.',
  },
  DATABASE_UNMANAGED: {
    level: 'error',
    message: 'Studio database schema is unmanaged',
    guidance: 'Verify the DB binding targets the Studio database. Back up unexpected data before replacing or installing the database.',
  },
  DATABASE_SCHEMA_STATE_INVALID: {
    level: 'error',
    message: 'Studio database schema state is invalid',
    guidance: 'Restore the Studio database from a known-good backup or use the supported lifecycle recovery flow before enabling normal operation.',
  },
  INSTALL_ROUTE_RATE_LIMITER_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio installer rate limiter is unavailable',
    guidance: 'Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status before retrying installation.',
  },
  INSTALL_TOKEN_VERIFICATION_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio install token verification is unavailable',
    guidance: 'Verify the deployed Worker runtime supports Web Crypto SHA-256, then redeploy before retrying installation.',
  },
  PASSWORD_HASHING_NOT_AVAILABLE: {
    level: 'error',
    message: 'Initial administrator password hashing is unavailable',
    guidance: 'Confirm the deployed Worker includes the Argon2id WASM assets, then retry installation.',
  },
  INITIAL_EDGE_SETUP_FAILED: {
    level: 'error',
    message: 'Initial Edge database setup failed',
    guidance: 'Verify the EDGE_DB and EDGE_KV bindings and Cloudflare D1 availability. Studio DB remains uninstalled; retry initial installation after correcting the Edge resource.',
  },
  DATABASE_INSTALL_FAILED: {
    level: 'error',
    message: 'Studio database installation failed',
    guidance: 'Check the DB binding and D1 availability. Confirm system status is still uninstalled before retrying; restore a backup if any unexpected schema remains.',
  },
  DATABASE_INSTALL_VERIFICATION_FAILED: {
    level: 'error',
    message: 'Studio database installation verification failed',
    guidance: 'Do not enable operational mode. Inspect system status and restore the D1 database from a known-good backup before retrying.',
  },
  DATABASE_INSTALL_COMPLETED: {
    level: 'info',
    message: 'Studio database installation completed',
    guidance: 'Remove STUDIO_INSTALL_TOKEN, set STUDIO_SITE_MODE to operational, and redeploy the Worker configuration.',
  },
  AUTH_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio authentication database query failed',
    guidance: 'Verify the DB binding targets the Studio database. If the database is uninstalled, set STUDIO_SITE_MODE to initial and complete installation; otherwise verify its schema lifecycle state.',
  },
  CLIENT_IP_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio client IP is unavailable',
    guidance: 'Verify that Cloudflare supplies a valid CF-Connecting-IP header. For local connections, use Studio dev or preview with socket IP forwarding.',
  },
  AUTH_ROUTE_RATE_LIMITER_NOT_AVAILABLE: {
    level: 'error',
    message: 'Authentication route rate limiter is unavailable',
    guidance: 'Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status, then retry.',
  },
  AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE: {
    level: 'error',
    message: 'Authentication rate-limit storage is unavailable',
    guidance: 'Verify the DB binding targets the Studio database, the auth_rate_limits table exists, and Cloudflare D1 is available, then retry.',
  },
  PASSWORD_VERIFICATION_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio password verification is unavailable',
    guidance: 'Verify that users.password_hash contains a compatible Argon2id PHC string and confirm the deployed Worker includes the Argon2id WASM assets.',
  },
  AUTH_PASSWORD_HASHING_FAILED: {
    level: 'error',
    message: 'Studio account password hashing failed',
    guidance: 'Confirm the deployed Worker includes the Argon2id WASM assets, then retry the protected password change or account setup operation.',
  },
  AUTH_PASSWORD_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio account password update failed',
    guidance: 'Verify D1 availability and the current Studio users and sessions tables, then inspect the affected account state before retrying.',
  },
  AUTH_MFA_CRYPTO_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio MFA cryptography is unavailable',
    guidance: 'Verify STUDIO_AUTH_SECRET is valid and the Worker runtime supports HKDF, AES-GCM, HMAC-SHA-1, and HMAC-SHA-256 before retrying.',
  },
  AUTH_MFA_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio MFA database query failed',
    guidance: 'Verify the DB binding and current Studio MFA tables, then retry authentication or account-security management.',
  },
  AUTH_MFA_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio MFA database write failed',
    guidance: 'Verify D1 availability and the current Studio MFA and sessions tables before retrying enrollment, authentication, or account-security management.',
  },
  AUTH_WEBAUTHN_CONFIGURATION_INVALID: {
    level: 'error',
    message: 'Studio WebAuthn request context is invalid',
    guidance: 'Serve Studio from HTTPS on its final hostname. Local development may use HTTP only on localhost or a loopback IP address.',
  },
  AUTH_WEBAUTHN_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio WebAuthn database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio WebAuthn credential and challenge tables before retrying authentication.',
  },
  AUTH_WEBAUTHN_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio WebAuthn database write failed',
    guidance: 'Verify D1 availability and the current Studio WebAuthn credential, challenge, user, and session tables before retrying the security operation.',
  },
  AUTH_SESSION_CRYPTO_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio session cryptography is unavailable',
    guidance: 'Verify the deployed Worker runtime supports cryptographically secure random values and Web Crypto SHA-256, then retry authentication.',
  },
  AUTH_SESSION_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio session database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio sessions, authors, media, and site_settings schema, then retry the request.',
  },
  AUTH_SESSION_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio session database write failed',
    guidance: 'Verify D1 availability and the current Studio sessions schema. Retry the affected sign-in, sign-out, or session-management action after database service is restored.',
  },
  AUTH_SESSION_GARBAGE_COLLECTION_FAILED: {
    level: 'error',
    message: 'Expired Studio session cleanup failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio sessions schema. Restore service and allow the next daily scheduled cleanup to retry.',
  },
  AUTH_SESSION_GARBAGE_COLLECTION_COMPLETED: {
    level: 'info',
    message: 'Expired Studio sessions deleted',
  },
  AUTH_WEBAUTHN_CHALLENGE_GARBAGE_COLLECTION_COMPLETED: {
    level: 'info',
    message: 'Expired Studio WebAuthn challenges deleted',
  },
  CONTENT_AUTOSAVE_GARBAGE_COLLECTION_FAILED: {
    level: 'error',
    message: 'Expired Studio content autosave cleanup failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio post_autosaves and page_autosaves tables. Restore service and allow the next daily scheduled cleanup to retry.',
  },
  CONTENT_AUTOSAVE_GARBAGE_COLLECTION_COMPLETED: {
    level: 'info',
    message: 'Expired Studio content autosaves deleted',
  },
  DASHBOARD_STUDIO_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Dashboard database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio posts, pages, and media tables, then reload Dashboard.',
  },
  DASHBOARD_STUDIO_DATA_INVALID: {
    level: 'error',
    message: 'Studio Dashboard data is invalid',
    guidance: 'Keep the current D1 backup, inspect the posts, pages, and media status or storage values, and restore canonical data before reloading Dashboard.',
  },
  DASHBOARD_EDGE_DATABASE_NOT_CONFIGURED: {
    level: 'error',
    message: 'Studio Dashboard Edge database binding is not configured',
    guidance: 'Bind the reviewed ZeroPress Edge D1 database as EDGE_DB. Studio content remains available while the Edge overview is unavailable.',
  },
  DASHBOARD_EDGE_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Dashboard Edge overview query failed',
    guidance: 'Verify the EDGE_DB binding, D1 availability, and the current ZeroPress comment, Form, Newsletter, and mail settings tables. Studio content remains available while the Edge overview is unavailable.',
  },
  DASHBOARD_EDGE_DATA_INVALID: {
    level: 'error',
    message: 'Studio Dashboard Edge data is invalid',
    guidance: 'Keep the current Edge D1 backup, inspect comment settings, mail settings, and content status values, and restore canonical data before reloading Dashboard.',
  },
  USER_SETUP_CRYPTO_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio user setup-token cryptography is unavailable',
    guidance: 'Verify the Worker runtime supports cryptographically secure random values and Web Crypto SHA-256 before retrying invitation or credential-recovery management.',
  },
  USER_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio user management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio users, roles, setup tokens, MFA, and sessions tables before retrying.',
  },
  USER_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio user management database write failed',
    guidance: 'Verify D1 availability and the current Studio user-management schema, then inspect the affected account state before retrying the operation.',
  },
  AUTHOR_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio author management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio authors and users tables before retrying.',
  },
  AUTHOR_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio author data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected authors row and optional user link, and restore canonical values before retrying.',
  },
  AUTHOR_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio author management database write failed',
    guidance: 'Verify D1 availability and the current Studio authors table, then reload Authors before retrying the operation.',
  },
  TAXONOMY_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio taxonomy management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio categories and tags tables before retrying.',
  },
  TAXONOMY_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio taxonomy data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected category or tag row, and restore canonical values before retrying.',
  },
  TAXONOMY_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio taxonomy management database write failed',
    guidance: 'Verify D1 availability and the current Studio categories and tags tables, then reload Taxonomy before retrying the operation.',
  },
  MEDIA_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Media management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio media, media_collections, posts, and pages tables before retrying.',
  },
  MEDIA_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio Media data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected Media or collection row and its references, and restore canonical metadata before retrying.',
  },
  MEDIA_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Media management database write failed',
    guidance: 'Verify D1 availability and the current Studio media and media_collections tables, then reload Media before retrying the operation.',
  },
  MEDIA_UPLOAD_R2_BINDING_NOT_CONFIGURED: {
    level: 'error',
    message: 'Studio managed Media storage is not configured',
    guidance: 'Bind the reviewed Studio R2 bucket as MEDIA_BUCKET. Keep managed uploads and R2-backed object deletion disabled until the binding is available.',
  },
  MEDIA_PREVIEW_R2_BINDING_NOT_CONFIGURED: {
    level: 'error',
    message: 'Studio managed Media preview storage is not configured',
    guidance: 'Bind the reviewed Studio R2 bucket as MEDIA_BUCKET before using private Studio previews. A configured site.media_origin remains the public delivery path.',
  },
  MEDIA_PREVIEW_R2_READ_FAILED: {
    level: 'error',
    message: 'Studio managed Media preview object read failed',
    guidance: 'Verify MEDIA_BUCKET targets the intended Studio bucket and check Cloudflare R2 availability, then reload Media. A configured site.media_origin remains independent from this private preview path.',
  },
  MEDIA_UPLOAD_STREAM_LENGTH_METADATA_LOST: {
    level: 'error',
    message: 'Studio managed Media upload stream lost its declared length',
    guidance: 'This is a Studio upload-pipeline or Workers runtime integration failure, not evidence of an R2 binding outage. Update Studio to a build that passes the final upload body through FixedLengthStream immediately before MEDIA_BUCKET.put. If the deployed build already does so, preserve the operational code and runtime version and report a Workers runtime regression. The pending upload intent expires automatically.',
  },
  MEDIA_UPLOAD_SVG_SANITIZER_FAILED: {
    level: 'error',
    message: 'Studio managed SVG sanitizer failed',
    guidance: 'Verify the deployed Studio bundle contains the reviewed @zeropress/svg-hush Workerd WASM artifact and matching zeropress-svg-v1 profile. The source SVG was not written to R2; retry only after restoring the reviewed Studio build.',
  },
  MEDIA_UPLOAD_R2_WRITE_FAILED: {
    level: 'error',
    message: 'Studio managed Media object upload failed',
    guidance: 'Verify MEDIA_BUCKET still targets the intended bucket and check Cloudflare R2 service availability before retrying. The pending upload intent expires automatically.',
  },
  MEDIA_UPLOAD_COMPENSATION_DELETE_FAILED: {
    level: 'warn',
    message: 'Studio could not immediately remove an uncommitted Media object',
    guidance: 'Inspect the recorded uploads/ storage key and the media_object_deletions queue. Restore R2 and D1 availability so scheduled cleanup can safely retry.',
  },
  MEDIA_UPLOAD_INTENT_GARBAGE_COLLECTION_FAILED: {
    level: 'error',
    message: 'Expired Studio Media upload-intent cleanup failed',
    guidance: 'Verify D1 availability and the current media_upload_intents table, then allow the next daily scheduled cleanup to retry.',
  },
  MEDIA_UPLOAD_INTENT_GARBAGE_COLLECTION_COMPLETED: {
    level: 'info',
    message: 'Expired Studio Media upload intents deleted',
  },
  MEDIA_OBJECT_CLEANUP_QUEUE_FAILED: {
    level: 'error',
    message: 'Studio could not queue a managed Media object deletion',
    guidance: 'Verify D1 availability and the media_object_deletions table. Preserve the logged R2-backed storage key until a reviewed cleanup can be queued or completed.',
  },
  MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio managed Media deletion queue database operation failed',
    guidance: 'Verify D1 availability and the current media_object_deletions table, then allow the next scheduled cleanup to retry.',
  },
  MEDIA_OBJECT_CLEANUP_DEFERRED: {
    level: 'warn',
    message: 'Studio deferred a managed Media object deletion',
    guidance: 'The Media metadata operation completed and the R2-backed key remains in media_object_deletions. Check R2 availability and allow scheduled cleanup to retry.',
  },
  MEDIA_OBJECT_CLEANUP_FAILED: {
    level: 'error',
    message: 'Studio managed Media object cleanup failed',
    guidance: 'Check MEDIA_BUCKET and Cloudflare R2 availability. Pending R2-backed keys remain durable in media_object_deletions for the next daily retry.',
  },
  MEDIA_OBJECT_CLEANUP_COMPLETED: {
    level: 'info',
    message: 'Studio managed Media objects deleted',
  },
  WXR_IMPORT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio WXR import database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio Author, taxonomy, Media, Post, Page, and Menu tables before retrying the same import file.',
  },
  WXR_IMPORT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio WXR import database write failed',
    guidance: 'Completed content chunks may already be present, while final settings writes remain atomic. Verify D1 availability, then retry the same WXR file; deterministic upserts leave completed rows unchanged.',
  },
  WXR_COMMENT_IMPORT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio WXR comment import Edge query failed',
    guidance: 'Verify the EDGE_DB binding, D1 availability, and the current ZeroPress Edge comment target and comment schema before retrying the same WXR file.',
  },
  WXR_COMMENT_IMPORT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio WXR comment import Edge write failed',
    guidance: 'Verify EDGE_DB availability and its current comment schema, then retry the same WXR file; deterministic imported-comment identities make a full retry safe.',
  },
  CONTENT_SEARCH_INDEX_STATE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio content-search index state query failed',
    guidance: 'Keep canonical Post and Page content unchanged. Verify the DB binding and the content_search_index_state table, then use Maintenance & Recovery to rebuild the derived search index.',
  },
  CONTENT_SEARCH_INDEX_QUERY_FAILED: {
    level: 'error',
    message: 'Studio content-search index query failed',
    guidance: 'Keep canonical Post and Page content unchanged. Verify the FTS5 tables and D1 availability, then use Maintenance & Recovery to rebuild the derived search index.',
  },
  CONTENT_SEARCH_INDEX_REBUILD_FAILED: {
    level: 'error',
    message: 'Studio content-search index rebuild failed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance or recovery. Canonical content remains authoritative; inspect the reported index phase and resume or explicitly restart the checkpointed rebuild.',
  },
  CONTENT_SEARCH_INDEX_REBUILD_COMPLETED: {
    level: 'info',
    message: 'Studio content-search index rebuild completed',
    guidance: 'The derived Post and Page search index passed row-count, revision-parity, and FTS integrity verification.',
  },
  AI_BINDING_NOT_CONFIGURED: {
    level: 'error',
    message: 'Studio Workers AI binding is not configured',
    guidance: 'Bind Workers AI as AI and redeploy the Worker configuration. Normal Post and Page editing remains available without AI generation.',
  },
  AI_REQUEST_RATE_LIMITER_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio AI request rate limiter is unavailable',
    guidance: 'Verify the AI_REQUEST_RATE_LIMITER binding and Cloudflare Rate Limiting service status. Normal Post and Page editing remains available.',
  },
  AI_EXCERPT_GENERATION_FAILED: {
    level: 'error',
    message: 'Studio AI excerpt generation failed',
    guidance: 'Verify Workers AI availability, account quota, and the configured model constant before retrying. Keep editing manually while the optional AI service is unavailable.',
  },
  AI_EXCERPT_RESPONSE_INVALID: {
    level: 'error',
    message: 'Studio AI excerpt response was invalid',
    guidance: 'Do not apply the generated result. Verify the configured model and prompt contract before retrying or continue editing the excerpt manually.',
  },
  AI_POST_DRAFT_GENERATION_FAILED: {
    level: 'error',
    message: 'Studio AI Post draft generation failed',
    guidance: 'Verify Workers AI availability, account quota, and the configured Post draft model constant before retrying. Keep writing manually while the optional AI service is unavailable.',
  },
  AI_POST_DRAFT_RESPONSE_INVALID: {
    level: 'error',
    message: 'Studio AI Post draft response was invalid',
    guidance: 'Do not apply the generated result. Verify the configured model and Post draft prompt contract before retrying or continue writing manually.',
  },
  AI_POST_EDIT_GENERATION_FAILED: {
    level: 'error',
    message: 'Studio AI Post edit generation failed',
    guidance: 'Verify Workers AI availability, account quota, and the configured Post edit model constant before retrying. The selected source and current editor draft remain unchanged.',
  },
  AI_POST_EDIT_RESPONSE_INVALID: {
    level: 'error',
    message: 'Studio AI Post edit response was invalid',
    guidance: 'Do not apply the generated result. Verify the configured model and Post edit prompt contract before retrying or continue editing the Post manually.',
  },
  AI_PAGE_DRAFT_GENERATION_FAILED: {
    level: 'error',
    message: 'Studio AI Page draft generation failed',
    guidance: 'Verify Workers AI availability, account quota, and the configured Page draft model constant before retrying. Keep writing manually while the optional AI service is unavailable.',
  },
  AI_PAGE_DRAFT_RESPONSE_INVALID: {
    level: 'error',
    message: 'Studio AI Page draft response was invalid',
    guidance: 'Do not apply the generated result. Verify the configured model and Page draft prompt contract before retrying or continue writing manually.',
  },
  AI_IMAGE_GENERATION_FAILED: {
    level: 'error',
    message: 'Studio AI image generation failed',
    guidance: 'Inspect the provider status and code when available, then verify Workers AI availability, account quota, and the configured image model.',
  },
  AI_IMAGE_RESPONSE_INVALID: {
    level: 'error',
    message: 'Studio AI image response was invalid',
    guidance: 'The generated bytes were not stored. Verify the configured image model and image-v1 output contract before retrying.',
  },
  AI_IMAGE_STORAGE_FAILED: {
    level: 'error',
    message: 'Studio AI image could not be stored as managed Media',
    guidance: 'Verify the Studio DB and MEDIA_BUCKET bindings. A generated result is usable only after its immutable R2 object and Media row are both materialized.',
  },
  POST_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Post management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio Post, relation, autosave, and saved-revision tables before retrying.',
  },
  POST_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio Post data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected Post, its relations, and any selected saved-revision snapshot, and restore canonical values before retrying.',
  },
  POST_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Post management database write failed',
    guidance: 'Verify D1 availability and the current Studio Post, relation, autosave, and saved-revision tables, then reload Posts before retrying the operation.',
  },
  PAGE_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Page management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio pages, autosave, and saved-revision tables before retrying.',
  },
  PAGE_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio Page data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected Page, its parent chain, and any selected saved-revision snapshot, and restore canonical values before retrying.',
  },
  PAGE_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Page management database write failed',
    guidance: 'Verify D1 availability and the current Studio pages, autosave, and saved-revision tables, then reload Pages before retrying the operation.',
  },
  MENU_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Menu management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio menus and referenced-content tables before retrying.',
  },
  MENU_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio Menu data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected Menu row and canonical item tree, and restore valid data before retrying.',
  },
  MENU_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Menu management database write failed',
    guidance: 'Verify D1 availability and the current Studio menus table, then reload Menus before retrying the operation.',
  },
  WIDGET_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Widget management database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio widget_areas and authors tables before retrying.',
  },
  WIDGET_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'Studio Widget data is invalid',
    guidance: 'Keep the current D1 backup, inspect the affected Widget area row and canonical item list, and restore valid data before retrying.',
  },
  WIDGET_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Widget management database write failed',
    guidance: 'Verify D1 availability and the current Studio widget_areas table, then reload Widgets before retrying the operation.',
  },
  STUDIO_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio interface settings database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio studio_settings table before retrying sign-in or Interface Settings.',
  },
  STUDIO_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio interface settings data is invalid',
    guidance: 'Keep the current D1 backup, inspect the interface locale rows and revision in studio_settings, and restore values supported by the deployed Studio build.',
  },
  STUDIO_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio interface settings update failed',
    guidance: 'Verify D1 availability and the current Studio studio_settings table, then reload Interface Settings before retrying the update.',
  },
  CLOUDFLARE_ACCESS_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Cloudflare Access settings database query failed',
    guidance: 'Keep Studio content unchanged. Verify D1 availability and the Cloudflare Access rows in studio_settings, then retry. Recovery mode bypasses this optional second-level gate.',
  },
  CLOUDFLARE_ACCESS_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Cloudflare Access settings data is invalid',
    guidance: 'Keep Studio in recovery mode, inspect the revisioned Cloudflare Access document in studio_settings, and disable or restore one canonical document before returning to operational mode.',
  },
  CLOUDFLARE_ACCESS_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Cloudflare Access settings update failed',
    guidance: 'Verify D1 availability and the current studio_settings table, then reload Cloudflare Access settings before retrying the change.',
  },
  CLOUDFLARE_ACCESS_RECOVERY_COMPLETED: {
    level: 'info',
    message: 'Cloudflare Access requirement recovery completed',
    guidance: 'Verify Studio remains reachable without Cloudflare Access, correct the Access application or policy, then enable the requirement again only from a request that Studio verifies.',
  },
  CLOUDFLARE_ACCESS_VERIFICATION_FAILED: {
    level: 'error',
    message: 'Cloudflare Access verification is unavailable',
    guidance: 'Keep Studio content unchanged. Verify Cloudflare Access and its team JWKS endpoint, or enter recovery mode and disable the second-level requirement before restoring operational mode.',
  },
  EDGE_INTEGRATION_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Edge integration settings query failed',
    guidance: 'Verify the DB binding, D1 availability, and the edge_integration_mode and edge_integration_revision rows in studio_settings. Studio treats the integration as disabled until the document is repaired.',
  },
  EDGE_INTEGRATION_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio Edge integration settings are invalid',
    guidance: 'Keep the current DB backup, inspect edge_integration_mode and edge_integration_revision in studio_settings, and restore one canonical revisioned document. Studio remains fail-closed with Edge integration disabled.',
  },
  EDGE_INTEGRATION_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Edge integration settings update failed',
    guidance: 'Verify D1 availability and the current Studio studio_settings table, then reload Edge Services before retrying the mode change.',
  },
  EDGE_INTEGRATION_HEALTH_CHECK_FAILED: {
    level: 'error',
    message: 'Studio Edge integration health check failed',
    guidance: 'Verify EDGE_DB and EDGE_KV bindings, Edge D1 availability, the reviewed Edge baseline and singleton seed rows, then retry from Edge Services. Studio content remains available.',
  },
  EDGE_DATABASE_LIFECYCLE_FAILED: {
    level: 'error',
    message: 'Edge database lifecycle operation failed',
    guidance: 'Keep EDGE_MAINTENANCE_MODE=true and retain the reviewed Edge SQL backup. Keep Studio in maintenance for install or adoption; an upgrade may be resumed from Operations in operational or maintenance mode. Verify the EDGE_DB binding, lifecycle state, and vendored artifact checksums before retrying the same operation.',
  },
  EDGE_DATABASE_UPGRADE_STARTED: {
    level: 'info',
    message: 'Edge database upgrade started',
    guidance: 'Keep EDGE_MAINTENANCE_MODE=true and retain the reviewed Edge SQL backup until the upgrade completes and Edge Services has been verified.',
  },
  EDGE_DATABASE_LIFECYCLE_COMPLETED: {
    level: 'info',
    message: 'Edge database lifecycle operation completed',
    guidance: 'Keep EDGE_MAINTENANCE_MODE=true until target reconciliation has completed and Edge Services reports that the integration can be enabled.',
  },
  EDGE_TARGET_RECONCILIATION_FAILED: {
    level: 'error',
    message: 'Edge comment-target reconciliation failed',
    guidance: 'Keep STUDIO_SITE_MODE=maintenance and EDGE_MAINTENANCE_MODE=true. Retry the same operation ID; bounded steps are idempotent. Review orphan targets before deleting any target or its comments.',
  },
  EDGE_TARGET_RECONCILIATION_COMPLETED: {
    level: 'info',
    message: 'Edge comment-target reconciliation action completed',
    guidance: 'Verify the reported reconciliation state. Keep maintenance boundaries until final parity is complete; review orphan targets before deletion and verify Edge Services before resuming public writes.',
  },
  SITE_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio site settings database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.',
  },
  SITE_SETTINGS_INCOMPLETE: {
    level: 'warn',
    message: 'Studio General Settings document is incomplete',
    guidance: 'Use the authenticated General Settings recovery action to review and replace only missing fields with documented defaults. Restore a known-good backup instead if the former values must be preserved.',
  },
  SITE_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio site settings data is invalid',
    guidance: 'Keep a current D1 backup. Restore a reviewed known-good database backup, or use Reset Studio from Maintenance & Recovery after preserving required data.',
  },
  SITE_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio site settings update failed',
    guidance: 'Verify D1 availability and the current Studio site_settings table, then reload General Settings before retrying the update.',
  },
  SITE_OUTPUT_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio output settings database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.',
  },
  SITE_OUTPUT_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio output settings data is invalid',
    guidance: 'Keep the current D1 backup, inspect the canonical Homepage and output rows and revision, and restore known-good values before retrying.',
  },
  SITE_OUTPUT_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio output settings update failed',
    guidance: 'Verify D1 availability and the current Studio site_settings table, then reload Homepage and output before retrying the update.',
  },
  SITE_NEWSLETTER_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Newsletter CTA settings query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.',
  },
  SITE_NEWSLETTER_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio Newsletter CTA settings are invalid',
    guidance: 'Keep the current D1 backup, inspect the canonical Newsletter CTA row and revision, and restore known-good values before retrying.',
  },
  SITE_NEWSLETTER_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Newsletter CTA settings update failed',
    guidance: 'Verify D1 availability and the current Studio site_settings table, then reload Newsletter before retrying the update.',
  },
  MAIL_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio mail delivery settings query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.',
  },
  MAIL_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio mail delivery settings are invalid',
    guidance: 'Keep the current D1 backup, inspect the canonical mail settings rows and encrypted credential envelopes, and restore known-good values before retrying.',
  },
  MAIL_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio mail delivery settings update failed',
    guidance: 'Verify D1 availability and the current Studio site_settings table, then reload Mail delivery before retrying the update.',
  },
  PUBLISHING_CREDENTIAL_CRYPTO_FAILED: {
    level: 'error',
    message: 'Studio publishing credential encryption failed',
    guidance: 'Verify STUDIO_AUTH_SECRET matches the secret used to save Publishing settings, then replace the API token if needed.',
  },
  PUBLISHING_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio publishing settings query failed',
    guidance: 'Verify DB availability before retrying.',
  },
  PUBLISHING_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio publishing settings update failed',
    guidance: 'Verify DB availability before saving Publishing settings again.',
  },
  PUBLISHING_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio publishing settings are invalid',
    guidance: 'Restore valid Publishing settings from a database backup.',
  },
  PUBLISHING_PROVIDER_FAILED: {
    level: 'error',
    message: 'GitHub publishing request failed',
    guidance: 'Review the Publishing connection settings. If the write result is unknown, check the latest GitHub file commit before publishing again.',
  },
  ANALYTICS_CREDENTIAL_CRYPTO_FAILED: {
    level: 'error',
    message: 'Studio analytics credential encryption failed',
    guidance: 'Verify STUDIO_AUTH_SECRET matches the secret used to save Analytics settings, then replace the API token if needed.',
  },
  ANALYTICS_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio analytics settings query failed',
    guidance: 'Verify DB availability before retrying.',
  },
  ANALYTICS_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio analytics settings update failed',
    guidance: 'Verify DB availability before saving Analytics settings again.',
  },
  ANALYTICS_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio analytics settings are invalid',
    guidance: 'Restore valid Analytics settings from a database backup.',
  },
  ANALYTICS_PROVIDER_FAILED: {
    level: 'error',
    message: 'Cloudflare Web Analytics query failed',
    guidance: 'Review the Analytics connection settings and retry.',
  },
  ANALYTICS_CACHE_FAILED: {
    level: 'warn',
    message: 'Studio analytics cache is unavailable',
  },
  MAIL_CREDENTIAL_CRYPTO_FAILED: {
    level: 'error',
    message: 'Studio mail credential cryptography failed',
    guidance: 'Verify STUDIO_AUTH_SECRET has not been lost or rotated and the Worker runtime supports HKDF and AES-GCM. Replace the provider credential after restoring a stable installation secret.',
  },
  MAIL_PROVIDER_REQUEST_FAILED: {
    level: 'error',
    message: 'Studio mail provider request failed',
    guidance: 'Check the selected provider service status and the Worker outbound request path, then retry connection verification or test delivery. Use a fresh provider credential only if the provider reports it is invalid.',
  },
  MAIL_PROVIDER_RESPONSE_INVALID: {
    level: 'error',
    message: 'Studio mail provider returned an invalid response',
    guidance: 'Verify the selected provider API is compatible with this Studio release, then inspect provider status and retry. Do not log or expose response bodies that may contain account details.',
  },
  FORM_EDGE_DATABASE_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress Forms database binding is not configured',
    guidance: 'Bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before using Form runtime or submission management.',
  },
  FORM_EDGE_CACHE_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress Forms cache binding is not configured',
    guidance: 'Bind EDGE_KV to the KV namespace used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before changing a public Form definition.',
  },
  FORM_EDGE_CACHE_INVALIDATION_FAILED: {
    level: 'error',
    message: 'ZeroPress Forms public cache invalidation failed',
    guidance: 'The EDGE_DB update may already be complete. Verify EDGE_KV availability and delete the matching form-info:v2 cache key or wait for its five-minute expiry before testing the public Form endpoint.',
  },
  FORM_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'ZeroPress Forms management query failed',
    guidance: 'Verify EDGE_DB availability and the current ZeroPress Edge Form tables before reloading Forms management.',
  },
  FORM_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'ZeroPress Forms management data is invalid',
    guidance: 'Keep the EDGE_DB backup, inspect the affected Form, field, submission, value, or mail-settings row, and restore canonical values before retrying.',
  },
  FORM_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'ZeroPress Forms management update failed',
    guidance: 'Verify EDGE_DB availability and the current ZeroPress Edge Form tables, then reload the affected Form view before retrying.',
  },
  NEWSLETTER_EDGE_DATABASE_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress Newsletter database binding is not configured',
    guidance: 'Bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before using Newsletter runtime or subscriber management.',
  },
  NEWSLETTER_EDGE_CACHE_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress Newsletter cache binding is not configured',
    guidance: 'Bind EDGE_KV to the KV namespace used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before changing Newsletter presentation fields.',
  },
  NEWSLETTER_EDGE_CACHE_INVALIDATION_FAILED: {
    level: 'error',
    message: 'ZeroPress Newsletter public cache invalidation failed',
    guidance: 'The EDGE_DB update may already be complete. Verify EDGE_KV availability and delete the matching newsletter-info:v1 cache key or wait for its five-minute expiry before testing the public Newsletter endpoint.',
  },
  NEWSLETTER_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'ZeroPress Newsletter management query failed',
    guidance: 'Verify EDGE_DB availability and the current ZeroPress Edge Newsletter tables before reloading Newsletter management.',
  },
  NEWSLETTER_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'ZeroPress Newsletter management data is invalid',
    guidance: 'Keep the EDGE_DB backup, inspect the affected Newsletter list, field, subscription, suppression, or mail-settings row, and restore canonical values before retrying.',
  },
  NEWSLETTER_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'ZeroPress Newsletter management update failed',
    guidance: 'Verify EDGE_DB availability and the current ZeroPress Edge Newsletter tables, then reload the affected Newsletter view before retrying.',
  },
  NEWSLETTER_POST_NOTIFICATION_QUEUE_FAILED: {
    level: 'error',
    message: 'Studio could not queue a Post subscriber notification',
    guidance: 'Verify the MAIL_QUEUE producer binding and its configured Queue, then retry the explicit subscriber notification from the unchanged published Post revision.',
  },
  EDGE_MAIL_QUEUE_CONFIGURATION_NOT_AVAILABLE: {
    level: 'error',
    message: 'Studio mail queue delivery configuration is unavailable',
    guidance: 'Open Mail delivery, save a complete provider credential and sender configuration, send a successful test email, then enable Newsletter confirmation.',
  },
  EDGE_MAIL_QUEUE_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio mail queue database query failed',
    guidance: 'Verify DB and EDGE_DB availability and the current Newsletter, Form, recipient, and mail queue source tables. The queue will retry the message automatically.',
  },
  EDGE_MAIL_QUEUE_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio mail queue delivery-state update failed',
    guidance: 'Verify EDGE_DB availability and newsletter_subscriptions. The provider may already have accepted the message; preserve the idempotency context and allow the queue retry before intervening.',
  },
  EDGE_MAIL_QUEUE_MESSAGE_INVALID: {
    level: 'warn',
    message: 'Studio discarded an invalid Edge mail queue message',
    guidance: 'Verify the ZeroPress Edge producer and Studio consumer use contract_version 1 of the same reviewed queue-message contract before sending additional jobs. Keep public Edge writes stopped and drain legacy jobs with their compatible consumer before an incompatible rollout.',
  },
  EDGE_MAIL_QUEUE_PROCESSING_FAILED: {
    level: 'error',
    message: 'Studio Edge mail queue message processing failed',
    guidance: 'Inspect the bounded reason or error, verify the Edge database lifecycle, mail provider, DB, EDGE_DB, and queue consumer configuration, then allow the scheduled retry or re-enable delivery after correction.',
  },
  SITE_MEDIA_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Media settings database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.',
  },
  SITE_MEDIA_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio Media settings data is invalid',
    guidance: 'Keep the current D1 backup, inspect the canonical Media Settings rows and revision, and restore known-good values before retrying.',
  },
  SITE_MEDIA_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Media settings update failed',
    guidance: 'Verify D1 availability and the current Studio site_settings table, then reload Media Settings before retrying the update.',
  },
  SITE_BRANDING_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Site Branding database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_assets, media, and site_settings tables before retrying.',
  },
  SITE_BRANDING_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio Site Branding data is invalid',
    guidance: 'Keep the current D1 backup, inspect the Site Branding revision and selected Media rows, and restore canonical values before retrying.',
  },
  SITE_BRANDING_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Site Branding update failed',
    guidance: 'Verify D1 availability and the current Studio site_assets, media, and site_settings tables, then reload Site Branding before retrying.',
  },
  CUSTOM_CODE_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio Custom Code database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_custom_code table before retrying.',
  },
  CUSTOM_CODE_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio Custom Code data is invalid',
    guidance: 'Keep the current D1 backup, inspect the site_custom_code singleton and revision, and restore canonical values before retrying.',
  },
  CUSTOM_CODE_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio Custom Code update failed',
    guidance: 'Verify D1 availability and the current Studio site_custom_code table, then reload Custom Code before retrying the update.',
  },
  SITE_ROUTING_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio URL and Homepage settings database query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings and pages tables before retrying.',
  },
  SITE_ROUTING_SETTINGS_INCOMPLETE: {
    level: 'warn',
    message: 'Studio URL and Homepage settings document is incomplete',
    guidance: 'Use the authenticated URL and Homepage recovery action to review missing fields and their defaults. Restore a known-good backup instead if the former URL policy must be preserved.',
  },
  SITE_ROUTING_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'Studio URL and Homepage settings data is invalid',
    guidance: 'Keep a current D1 backup. Restore a reviewed known-good database backup, or use Reset Studio from Maintenance & Recovery after preserving required data.',
  },
  SITE_ROUTING_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio URL and Homepage settings update failed',
    guidance: 'Verify D1 availability and the current Studio site_settings and pages tables, then reload URLs and Homepage before retrying the update.',
  },
  COMMENT_EDGE_DATABASE_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress comments database binding is not configured',
    guidance: 'If Studio Edge integration is enabled, bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before using Edge-backed management, Preview Data, Clear Content, or Reset Studio. Otherwise disable Studio Edge integration from Edge Services.',
  },
  COMMENT_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'ZeroPress comment settings query failed',
    guidance: 'Verify the EDGE_DB binding, D1 availability, and the current ZeroPress Edge comment schema before retrying.',
  },
  COMMENT_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'ZeroPress comment settings are invalid',
    guidance: 'Keep the EDGE_DB backup, inspect edge_comment_settings, its request secret keyset, and its optional Supabase public configuration, then restore canonical values before retrying.',
  },
  COMMENT_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'ZeroPress comment settings update failed',
    guidance: 'Verify EDGE_DB availability and the current ZeroPress Edge comment schema, then reload Comment Settings before retrying.',
  },
  COMMENT_REQUEST_SECURITY_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Comment request security query failed',
    guidance: 'Verify EDGE_DB availability and the current edge_comment_settings table, then reload Comment Request Security before retrying.',
  },
  COMMENT_REQUEST_SECURITY_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Comment request security update failed',
    guidance: 'Keep the current EDGE_DB backup, reload Comment Request Security, and retry the same rotate or reset action after verifying D1 availability.',
  },
  COMMENT_REQUEST_SECURITY_CRYPTO_FAILED: {
    level: 'error',
    message: 'Comment request security cryptography failed',
    guidance: 'Verify that the Worker runtime supports secure random generation and Web Crypto SHA-256, then retry the lifecycle action.',
  },
  EDGE_SECURITY_DATABASE_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress Edge security database binding is not configured',
    guidance: 'Bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, then redeploy before managing public request security.',
  },
  EDGE_SECURITY_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'ZeroPress Edge public request security query failed',
    guidance: 'Verify EDGE_DB availability and the current edge_runtime_settings table before reloading Edge Security.',
  },
  EDGE_SECURITY_SETTINGS_DATA_INVALID: {
    level: 'error',
    message: 'ZeroPress Edge public request security settings are invalid',
    guidance: 'Keep the EDGE_DB backup, apply the reviewed ZeroPress Edge baseline and seed artifacts if needed, and restore a canonical id=1 edge_runtime_settings row before retrying.',
  },
  EDGE_SECURITY_SETTINGS_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'ZeroPress Edge public request security update failed',
    guidance: 'Verify EDGE_DB availability and the current edge_runtime_settings table, then reload Edge Security before retrying.',
  },
  COMMENT_MANAGEMENT_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'ZeroPress comment management query failed',
    guidance: 'Verify EDGE_DB availability and the current comments and edge_comment_targets tables before reloading Comments.',
  },
  COMMENT_TARGET_METADATA_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio comment target metadata query failed',
    guidance: 'Verify the DB binding and current Studio Post and Page tables before reloading Comments.',
  },
  COMMENT_MANAGEMENT_DATA_INVALID: {
    level: 'error',
    message: 'ZeroPress comment moderation data is invalid',
    guidance: 'Keep the EDGE_DB and Studio DB backups, inspect the affected comment and target rows, and restore canonical values before moderating comments.',
  },
  COMMENT_MANAGEMENT_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'ZeroPress comment management write failed',
    guidance: 'Verify EDGE_DB availability and the current comment schema, then reload Comments before retrying the comment action.',
  },
  COMMENT_TARGET_SOURCE_DATA_INVALID: {
    level: 'error',
    message: 'Studio comment target source data is invalid',
    guidance: 'Keep the DB backup, inspect the affected Post or Page public ID, status, and allow-comments value, then retry target reconciliation from Maintenance & Recovery.',
  },
  COMMENT_TARGET_PROJECTION_WRITE_FAILED: {
    level: 'error',
    message: 'ZeroPress comment target projection failed',
    guidance: 'Verify EDGE_DB and edge_comment_targets, preserve queued outbox rows, then use bounded target reconciliation in Maintenance & Recovery. Existing target upserts and deletes are idempotent.',
  },
  COMMENT_TARGET_OUTBOX_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Studio comment-target outbox query failed',
    guidance: 'Verify the DB binding, D1 availability, and edge_comment_target_projection_outbox schema. Preserve queued rows and retry after Studio DB service is restored.',
  },
  COMMENT_TARGET_OUTBOX_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Studio comment-target outbox write failed',
    guidance: 'Preserve the Studio DB and queued outbox rows, verify D1 availability and the current Studio schema, then retry the bounded drain after the lease expires. An Edge upsert or delete may already be complete and is safe to repeat.',
  },
  COMMENT_TARGET_OUTBOX_DRAIN_FAILED: {
    level: 'error',
    message: 'Studio comment-target projection drain failed',
    guidance: 'Keep Edge integration enabled, verify EDGE_DB and edge_comment_targets, then retry pending projections from Edge Services. Canonical Studio content is already safe in DB.',
  },
  COMMENT_REQUEST_TOKEN_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'ZeroPress comment request-token query failed',
    guidance: 'Verify EDGE_DB availability and the current edge_comment_targets and edge_comment_settings tables before regenerating Preview Data.',
  },
  COMMENT_TARGET_NOT_PROJECTED: {
    level: 'error',
    message: 'A Preview Data comment target is not projected',
    guidance: 'Keep EDGE_MAINTENANCE_MODE=true, set Studio to maintenance mode, run Edge target reconciliation from Maintenance & Recovery, and regenerate Preview Data. Do not publish a payload missing the target-bound token.',
  },
  COMMENT_REQUEST_SECRETS_NOT_CONFIGURED: {
    level: 'error',
    message: 'ZeroPress comment request-token secrets are not configured',
    guidance: 'Open Comment Settings, initialize Comment Request Security, and then regenerate Preview Data.',
  },
  COMMENT_REQUEST_TOKEN_CRYPTO_FAILED: {
    level: 'error',
    message: 'ZeroPress comment request-token signing failed',
    guidance: 'Verify the Worker runtime supports Web Crypto HMAC-SHA-256 and that the Edge request-token keyset is valid before regenerating Preview Data.',
  },
  PREVIEW_DATA_SETTINGS_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Preview Data settings query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying Preview Data generation.',
  },
  PREVIEW_DATA_SUMMARY_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Preview Data summary query failed',
    guidance: 'Verify the DB binding, D1 availability, and the current Studio content tables before retrying the Preview Data summary.',
  },
  PREVIEW_DATA_SUMMARY_DATA_INVALID: {
    level: 'error',
    message: 'Preview Data summary is invalid',
    guidance: 'Inspect the current Studio content tables and count query result before retrying the Preview Data summary.',
  },
  PREVIEW_DATA_PROJECTION_INVALID: {
    level: 'error',
    message: 'Preview Data v0.7 projection failed contract validation',
    guidance: 'Inspect firstIssueCode and firstIssuePath in this log, correct the corresponding stored Studio data or projection implementation, and regenerate Preview Data. Do not publish the rejected payload.',
  },
  DATABASE_BACKUP_EXPORT_FAILED: {
    level: 'error',
    message: 'Studio SQL backup generation failed',
    guidance: 'Keep the current site mode, verify the selected D1 binding and availability, then retry. Use Studio logical backup for the Studio DB because native D1 export does not support its virtual tables; review native export only for a separate target without virtual tables.',
  },
  DATABASE_BACKUP_EXPORT_COMPLETED: {
    level: 'info',
    message: 'Studio SQL backup generation completed',
    guidance: 'Store the downloaded artifact securely and verify it before making destructive database or deployment changes. R2 objects are not included.',
  },
  DATABASE_UPGRADE_REQUIRED: {
    level: 'warn',
    message: 'Studio database schema upgrade is required',
    guidance: 'If administrator access is available, set STUDIO_SITE_MODE to maintenance and redeploy the Worker configuration. If access must be recovered first, use recovery mode and Recover administrator, then switch to maintenance. In Maintenance & Recovery, create and safely store a reviewed Studio DB backup and run Studio database upgrade. Keep maintenance mode enabled until validation succeeds.',
  },
  DATABASE_UPGRADE_FAILED: {
    level: 'error',
    message: 'Studio database schema upgrade failed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance. The failed step was rolled back and the stored schema version remains the retry boundary; inspect the selected artifact and D1 availability, then retry the same step. Restore the reviewed backup if failure persists.',
  },
  DATABASE_UPGRADE_STEP_COMPLETED: {
    level: 'info',
    message: 'Studio database schema upgrade step completed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance and continue with the next reported schema step. Do not enable operational mode until the final completion event and application checks succeed.',
  },
  DATABASE_UPGRADE_COMPLETED: {
    level: 'info',
    message: 'Studio database schema upgrade completed',
    guidance: 'Confirm the schema is current and review this completion event, then set STUDIO_SITE_MODE to operational. Test sign-in and key Studio flows, keep the pre-upgrade backup until they succeed, and return to maintenance if validation fails.',
  },
  DATABASE_RESTORE_FAILED: {
    level: 'error',
    message: 'Studio SQL database restore failed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance or recovery. The failed request was rolled back, but prior restore chunks may remain; inspect the selected binding and restart from the reviewed artifact unless final verification completed.',
  },
  DATABASE_RESTORE_COMPLETED: {
    level: 'info',
    message: 'Studio SQL database restore completed',
    guidance: 'Verify the restored database lifecycle and application behavior before changing STUDIO_SITE_MODE. Restore R2 objects separately when required.',
  },
  OPERATIONS_CONFIGURATION_INVALID: {
    level: 'error',
    message: 'Maintenance and Recovery configuration is invalid',
    guidance: 'Configure a comma-separated exact-IP allowlist in STUDIO_OPERATIONS_ALLOWED_IPS and create a STUDIO_OPERATIONS_TOKEN secret containing 32–256 printable ASCII characters without spaces. Remove the allowlist variable to disable Maintenance and Recovery.',
  },
  OPERATIONS_AUTH_RATE_LIMITER_NOT_AVAILABLE: {
    level: 'error',
    message: 'Maintenance and Recovery authentication rate limiter is unavailable',
    guidance: 'Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status before retrying Operations authentication.',
  },
  OPERATIONS_TOKEN_VERIFICATION_NOT_AVAILABLE: {
    level: 'error',
    message: 'Maintenance and Recovery token verification is unavailable',
    guidance: 'Verify the deployed Worker runtime supports Web Crypto SHA-256, then redeploy before retrying the operation.',
  },
  OPERATIONS_ADMIN_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Maintenance administrator authorization query failed',
    guidance: 'Verify the DB binding targets an installed Studio database and that the users, roles, and user_roles schema is available.',
  },
  ADMINISTRATOR_RECOVERY_DATABASE_QUERY_FAILED: {
    level: 'error',
    message: 'Administrator recovery database query failed',
    guidance: 'Keep STUDIO_SITE_MODE in recovery and verify the DB binding, users, roles, user_roles, and MFA tables before retrying.',
  },
  ADMINISTRATOR_RECOVERY_PASSWORD_HASHING_FAILED: {
    level: 'error',
    message: 'Recovered administrator password hashing failed',
    guidance: 'Confirm the deployed Worker includes the Argon2id WASM assets, then retry administrator recovery.',
  },
  ADMINISTRATOR_RECOVERY_DATABASE_WRITE_FAILED: {
    level: 'error',
    message: 'Administrator recovery database write failed',
    guidance: 'Keep STUDIO_SITE_MODE in recovery, inspect D1 availability, and restore the backup if administrator credentials or MFA state are uncertain.',
  },
  ADMINISTRATOR_RECOVERY_COMPLETED: {
    level: 'info',
    message: 'Administrator access recovery completed',
    guidance: 'Set STUDIO_SITE_MODE to operational and verify mandatory MFA sign-in. Return to recovery if another correction is needed; after success, rotate the operations token.',
  },
  MAINTENANCE_OPERATION_STARTED: {
    level: 'info',
    message: 'Studio maintenance operation started',
    guidance: 'Keep the relevant resource backup until a matching completion event is recorded and the resulting Studio state is verified.',
  },
  EDGE_INTEGRATION_MODE_CHANGED: {
    level: 'info',
    message: 'Studio Edge integration mode changed',
    guidance: 'Verify the effective Edge Services state before exporting Preview Data or resuming public Edge writes.',
  },
  MAINTENANCE_EDGE_COMMENT_LIFECYCLE_FAILED: {
    level: 'error',
    message: 'Maintenance Edge comment lifecycle operation failed',
    guidance: 'Keep the DB and EDGE_DB backups, keep the current site mode, and retry the same maintenance action. The Edge phase is idempotent; if verification fails repeatedly, inspect comments, edge_comment_targets, and edge_comment_settings before restoring data.',
  },
  MAINTENANCE_EDGE_NEWSLETTER_LIFECYCLE_FAILED: {
    level: 'error',
    message: 'Maintenance Edge Newsletter lifecycle operation failed',
    guidance: 'Keep the DB and EDGE_DB backups and keep the current site mode. Retry the same maintenance action; if verification fails repeatedly, inspect the Edge Newsletter tables and edge_mail_settings before restoring data.',
  },
  MAINTENANCE_EDGE_FORM_LIFECYCLE_FAILED: {
    level: 'error',
    message: 'Maintenance Edge Form lifecycle operation failed',
    guidance: 'Keep the DB and EDGE_DB backups and keep the current site mode. Retry the same maintenance action; if verification fails repeatedly, inspect forms, form_fields, form_submissions, and form_submission_values before restoring data.',
  },
  CLEAR_SITE_CONTENT_FAILED: {
    level: 'error',
    message: 'Studio site content clearing failed',
    guidance: 'Keep Studio in its current site mode, inspect the DB status and schema, and retry the same action. If completed_resource=EDGE_DB is present, Edge comment, Form, and Newsletter content phases already completed and are safe to repeat.',
  },
  CLEAR_SITE_CONTENT_COMPLETED: {
    level: 'info',
    message: 'Studio site content clearing completed',
    guidance: 'Verify the empty content state before starting a new import or publishing workflow.',
  },
  STUDIO_RESET_FAILED: {
    level: 'error',
    message: 'Studio reset failed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance, inspect the DB status and schema, and retry the same action. If completed_resource=EDGE_DB is present, the Edge comment, Form, and Newsletter resets already completed and are safe to repeat.',
  },
  STUDIO_RESET_COMPLETED: {
    level: 'info',
    message: 'Studio reset completed',
    guidance: 'Set STUDIO_SITE_MODE to operational and verify the preserved administrator can complete MFA sign-in. Return to maintenance if validation fails.',
  },
  STUDIO_UNINSTALL_PREVIEW_FAILED: {
    level: 'error',
    message: 'Studio uninstall preview failed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance, verify the DB binding and exact Studio-owned table set, then retry the preview before uninstalling.',
  },
  STUDIO_UNINSTALL_FAILED: {
    level: 'error',
    message: 'Studio uninstall failed',
    guidance: 'Keep STUDIO_SITE_MODE in maintenance, inspect system status, and restore the database backup before retrying. Do not run the install flow over an unexpected partial schema.',
  },
  STUDIO_UNINSTALL_COMPLETED: {
    level: 'info',
    message: 'Studio uninstall completed',
    guidance: 'To reinstall, set STUDIO_SITE_MODE to initial, configure STUDIO_INSTALL_TOKEN, redeploy the Worker configuration, and open the installer.',
  },
  EDGE_DATABASE_UNINSTALL_PREVIEW_FAILED: {
    level: 'error',
    message: 'Edge database uninstall preview failed',
    guidance: 'Keep STUDIO_SITE_MODE=maintenance and EDGE_MAINTENANCE_MODE=true. Verify the EDGE_DB binding, managed lifecycle state, and reviewed Edge backup before retrying.',
  },
  EDGE_DATABASE_UNINSTALL_FAILED: {
    level: 'error',
    message: 'Edge database uninstall failed',
    guidance: 'Keep STUDIO_SITE_MODE=maintenance and EDGE_MAINTENANCE_MODE=true. Preserve the Edge backup, inspect the lifecycle state, and do not install over an unexpected partial schema.',
  },
  EDGE_DATABASE_UNINSTALL_COMPLETED: {
    level: 'info',
    message: 'Edge database uninstall completed',
    guidance: 'Keep Studio Edge integration disabled. The D1 resource, bindings, KV entries, and external queue remain outside this schema operation; use the normal Edge install flow if the service is needed again.',
  },
  UNHANDLED_STUDIO_API_ERROR: {
    level: 'error',
    message: 'Unhandled Studio API error',
  },
} as const satisfies Record<string, OperationalLogDefinition>;

export type OperationalLogCode = keyof typeof OPERATIONAL_LOG_DEFINITIONS;
export type OperationalLogMetadata = Record<string, unknown>;

type OperationalFailureOptions = {
  cause?: unknown;
  metadata?: OperationalLogMetadata;
};

const RESERVED_METADATA_KEYS = new Set([
  'code',
  'errorMessage',
  'errorType',
  'guidance',
]);

function sanitizeOperationalMetadata(
  metadata: OperationalLogMetadata | undefined,
): OperationalLogMetadata {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_METADATA_KEYS.has(key)),
  );
}

export class StudioOperationalError extends Error {
  readonly code: OperationalLogCode;
  readonly operationalMetadata: OperationalLogMetadata;
  readonly originalCause: unknown;

  constructor(
    code: OperationalLogCode,
    options: OperationalFailureOptions = {},
  ) {
    const definition: OperationalLogDefinition = OPERATIONAL_LOG_DEFINITIONS[code];
    super(
      definition.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'StudioOperationalError';
    this.code = code;
    this.operationalMetadata = sanitizeOperationalMetadata(options.metadata);
    this.originalCause = options.cause;
  }
}

export function logOperationalFailure(
  code: OperationalLogCode,
  options: OperationalFailureOptions = {},
): void {
  const definition: OperationalLogDefinition = OPERATIONAL_LOG_DEFINITIONS[code];
  const metadata = {
    code,
    ...sanitizeOperationalMetadata(options.metadata),
    errorType: options.cause === undefined
      ? undefined
      : getLogErrorType(options.cause),
    guidance: definition.guidance,
  };

  if (definition.level === 'warn') {
    logWarn(definition.message, metadata);
    return;
  }

  if (definition.level === 'info') {
    logInfo(definition.message, metadata);
    return;
  }

  logError(definition.message, metadata);
}

export function logStudioOperationalError(
  error: StudioOperationalError,
  requestMetadata?: OperationalLogMetadata,
): void {
  logOperationalFailure(error.code, {
    cause: error.originalCause,
    metadata: {
      ...error.operationalMetadata,
      ...requestMetadata,
    },
  });
}
