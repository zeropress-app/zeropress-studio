# Studio operational log catalog

This catalog lists the operational events emitted by ZeroPress Studio.
Field meanings, levels, recording boundaries, and
privacy requirements are defined by the
[operational logging policy](./operational-log-policy.md).

## Maintenance initiator context

After successful administrator re-verification, mutation events additionally
carry canonical `initiated_by_user_id` and `initiated_by_user_email` values
read from D1. A multi-request restore, Studio/Edge upgrade, or target
reconciliation uses the snapshot persisted when the operation began. Recovery
token-only operations and failed credential checks omit both fields. No event
uses `actor_type`, raw request email, passwords, tokens, MFA values, or
confirmation input.

## `AUDIT_WRITE_FAILED`

- Level: `warn`
- Message: `Audit record could not be saved`
- Expected context: `resource=DB`

## `AUDIT_IP_HASH_FAILED`

- Level: `warn`
- Message: `Audit IP hashing failed; the raw IP was omitted`
- Expected context: `component=web_crypto`

## `AUDIT_SNAPSHOT_FAILED`

- Level: `warn`
- Message: `Audit actor snapshot could not be read`
- Expected context: `resource=DB`

## `AUDIT_READ_FAILED`

- Level: `warn`
- Message: `Audit records could not be read`
- Expected context: `resource=DB`

## `AUDIT_RETENTION_FAILED`

- Level: `warn`
- Message: `Audit retention cleanup failed`
- Expected context: `resource=DB`

## `SITE_MODE_CONFIGURATION_INVALID`

- Level: `error`
- Message: `Studio site mode configuration is invalid`
- Guidance: `Set STUDIO_SITE_MODE to exactly one of initial, operational, maintenance, or recovery, then redeploy the Worker configuration.`
- Expected context: `component=worker_configuration`,
  `action=resolve_site_mode`, `reason=missing|invalid`

The configured value itself is not recorded.

## `AUTH_SECRET_NOT_CONFIGURED`

- Level: `error`
- Message: `Studio authentication secret is not configured`
- Guidance: `Create a unique STUDIO_AUTH_SECRET Worker secret containing 32–256 printable ASCII characters without spaces, then redeploy before installation or normal sign-in.`
- Expected context: `component=worker_configuration`,
  `action=resolve_auth_secret`

Only the resolved validity state is inspected. The secret is never returned or
recorded.

## `INSTALL_TOKEN_NOT_CONFIGURED`

- Level: `error`
- Message: `Studio install token is not configured`
- Guidance: `Create a STUDIO_INSTALL_TOKEN Worker secret containing 32–256 printable ASCII characters without spaces before opening the installer. Remove it after installation is complete.`
- Expected context: `component=worker_configuration`,
  `action=authorize_initial_installation`

This event is relevant only when the site is in `initial` mode and D1 is
uninstalled. No token value or token-derived metadata is recorded.

## `INSTALL_TOKEN_STILL_CONFIGURED`

- Level: `error`
- Message: `Studio install token remains configured after installation`
- Guidance: `Delete the STUDIO_INSTALL_TOKEN Worker secret binding instead of replacing it with a blank value, then redeploy the Worker configuration. Keep the token only while installing an uninstalled Studio database in initial mode.`
- Expected context: `component=worker_configuration`,
  `action=enforce_install_token_lifecycle`

An installed Studio treats any defined value, including an empty or malformed
value, as an invalid lifecycle configuration. The value and its format are not
recorded.

## `DATABASE_STATUS_QUERY_FAILED`

- Level: `error`
- Message: `Studio database status query failed`
- Guidance: `Verify the DB binding targets the Studio database and check Cloudflare D1 availability, then retry.`
- Expected context: `resource=DB`, `action=inspect_database_status`

## `DATABASE_UNINSTALLED`

- Level: `error`
- Message: `Studio database is not installed`
- Guidance: `Set STUDIO_SITE_MODE to initial, configure a STUDIO_INSTALL_TOKEN containing 32–256 printable ASCII characters without spaces, and redeploy the Worker configuration. Complete installation, remove STUDIO_INSTALL_TOKEN, then set STUDIO_SITE_MODE to operational and redeploy again.`
- Expected context: `resource=DB`, `action=resolve_system_access`

This event is emitted only when an uninstalled Studio D1 is paired with
`STUDIO_SITE_MODE=operational`. An uninstalled database in `initial` mode is
the expected installer state and does not emit this event.

## `DATABASE_UNMANAGED`

- Level: `error`
- Message: `Studio database schema is unmanaged`
- Guidance: `Verify the DB binding targets the Studio database. Back up unexpected data before replacing or installing the database.`
- Expected context: `resource=DB`, `action=inspect_database_status`

Table names are deliberately omitted.

## `DATABASE_SCHEMA_STATE_INVALID`

- Level: `error`
- Message: `Studio database schema state is invalid`
- Guidance: `Restore the Studio database from a known-good backup or use the supported lifecycle recovery flow before enabling normal operation.`
- Expected context: `resource=DB`, `action=inspect_database_status`,
  `reason=singleton_missing|malformed_row|incomplete_operation_state|stale_operation_state|lifecycle_failed`

## `INSTALL_ROUTE_RATE_LIMITER_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio installer rate limiter is unavailable`
- Guidance: `Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status before retrying installation.`
- Expected context: `resource=AUTH_ROUTE_RATE_LIMITER`,
  `action=limit_install_authentication_attempt`

## `INSTALL_TOKEN_VERIFICATION_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio install token verification is unavailable`
- Guidance: `Verify the deployed Worker runtime supports Web Crypto SHA-256, then redeploy before retrying installation.`
- Expected context: `component=web_crypto`,
  `action=verify_install_token`

The install token and its digest are never recorded.

## `PASSWORD_HASHING_NOT_AVAILABLE`

- Level: `error`
- Message: `Initial administrator password hashing is unavailable`
- Guidance: `Confirm the deployed Worker includes the Argon2id WASM assets, then retry installation.`
- Expected context: `component=argon2id`,
  `action=hash_initial_administrator_password`

The administrator password and generated hash are never recorded.

## `INITIAL_EDGE_SETUP_FAILED`

- Level: `error`
- Message: `Initial Edge database setup failed`
- Guidance: `Verify the EDGE_DB and EDGE_KV bindings and Cloudflare D1 availability. Studio DB remains uninstalled; retry initial installation after correcting the Edge resource.`
- Expected context: `resource=EDGE_DB`, `related_resource=EDGE_KV`,
  `action=prepare_initial_edge_database`, and a safe `reason`

The initial installer changes Edge D1 only after proving its application
catalog is empty. This failure occurs before the Studio DB install batch.

## `DATABASE_INSTALL_FAILED`

- Level: `error`
- Message: `Studio database installation failed`
- Guidance: `Check the DB binding and D1 availability. Confirm system status is still uninstalled before retrying; restore a backup if any unexpected schema remains.`
- Expected context: `resource=DB`, `action=install_database`,
  `target_schema_version=<number>`, `edge_database_status=installed|skipped_nonempty`,
  `edge_integration_mode=enabled|disabled`

## `DATABASE_INSTALL_VERIFICATION_FAILED`

- Level: `error`
- Message: `Studio database installation verification failed`
- Guidance: `Do not enable operational mode. Inspect system status and restore the D1 database from a known-good backup before retrying.`
- Expected context: `resource=DB`,
  `action=verify_database_installation`,
  `target_schema_version=<number>`

## `DATABASE_INSTALL_COMPLETED`

- Level: `info`
- Message: `Studio database installation completed`
- Guidance: `Remove STUDIO_INSTALL_TOKEN, set STUDIO_SITE_MODE to operational, and redeploy the Worker configuration.`
- Expected context: `resource=DB`, `action=install_database`,
  `schema_version=<number>`, `edge_database_status=installed|skipped_nonempty`,
  `edge_integration_mode=enabled|disabled`, and optional
  `existing_edge_database_state=<state>` when the existing database was
  preserved

No administrator identity is recorded. This event does not imply that the
site mode was changed automatically.

## `AUTH_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio authentication database query failed`
- Guidance: `Verify the DB binding targets the Studio database. If the database is uninstalled, set STUDIO_SITE_MODE to initial and complete installation; otherwise verify its schema lifecycle state.`
- Expected context: `resource=DB`,
  `action=authenticate_credentials`

## `CLIENT_IP_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio client IP is unavailable`
- Guidance: `Verify that Cloudflare supplies a valid CF-Connecting-IP header. For local connections, use Studio dev or preview with socket IP forwarding.`
- Expected context: `component=request`, `action=resolve_client_ip`,
  `method`, `pathname`

IP-based request limiting stops with `503 SYSTEM_NOT_AVAILABLE` when the
client IP cannot be determined. Header values are not recorded.

## `AUTH_ROUTE_RATE_LIMITER_NOT_AVAILABLE`

- Level: `error`
- Message: `Authentication route rate limiter is unavailable`
- Guidance: `Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status, then retry.`
- Expected context: `resource=AUTH_ROUTE_RATE_LIMITER`,
  `action=limit_login_route|limit_mfa_route|limit_passkey_sign_in_route`

## `AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE`

- Level: `error`
- Message: `Authentication rate-limit storage is unavailable`
- Guidance: `Verify the DB binding targets the Studio database, the auth_rate_limits table exists, and Cloudflare D1 is available, then retry.`
- Expected context: `resource=DB`,
  `action=consume_login_rate_limit|consume_passkey_sign_in_rate_limit|consume_totp_rate_limit|garbage_collect_auth_rate_limits`

## `PASSWORD_VERIFICATION_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio password verification is unavailable`
- Guidance: `Verify that users.password_hash contains a compatible Argon2id PHC string and confirm the deployed Worker includes the Argon2id WASM assets.`
- Expected context: `component=argon2id`, `action=verify_password`

## `AUTH_PASSWORD_HASHING_FAILED`

- Level: `error`
- Message: `Studio account password hashing failed`
- Guidance: `Confirm the deployed Worker includes the Argon2id WASM assets, then retry the protected password change or account setup operation.`
- Expected context: `component=argon2id`,
  `action=hash_changed_user_password|hash_pending_user_password|hash_user_setup_password`

Passwords and generated password hashes are never recorded.

## `AUTH_PASSWORD_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio account password update failed`
- Guidance: `Verify D1 availability and the current Studio users and sessions tables, then inspect the affected account state before retrying.`
- Expected context: `resource=DB`, `action=change_user_password`

Password changes rotate the account security revision and revoke every session
in one D1 batch. Password hashes, account identity, session IDs, and grants are
never recorded.

## `AUTH_MFA_CRYPTO_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio MFA cryptography is unavailable`
- Guidance: `Verify STUDIO_AUTH_SECRET is valid and the Worker runtime supports HKDF, AES-GCM, HMAC-SHA-1, and HMAC-SHA-256 before retrying.`
- Expected context: `component=web_crypto`, action identifying enrollment,
  management grant, TOTP-secret encryption, decryption, or proof verification

MFA secrets, codes, and sealed tokens are never recorded.

## `AUTH_MFA_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio MFA database query failed`
- Guidance: `Verify the DB binding and current Studio MFA tables, then retry authentication or account-security management.`
- Expected context: `resource=DB`, action identifying the failed MFA read,
  including management status or password re-confirmation

## `AUTH_MFA_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio MFA database write failed`
- Guidance: `Verify D1 availability and the current Studio MFA and sessions tables before retrying enrollment, authentication, or account-security management.`
- Expected context: `resource=DB`, action identifying enrollment, TOTP
  verification, or managed TOTP replacement

## `AUTH_WEBAUTHN_CONFIGURATION_INVALID`

- Level: `error`
- Message: `Studio WebAuthn request context is invalid`
- Guidance: `Serve Studio from HTTPS on its final hostname. Local development may use HTTP only on localhost or a loopback IP address.`
- Expected context: `component=webauthn`,
  `action=resolve_request_context|resolve_management_request_context|`
  `resolve_passkey_sign_in_request_context`

WebAuthn is bound to the exact request origin and hostname-derived RP ID.
Rejected request hostnames, credential IDs, and user identity are not logged.

## `AUTH_WEBAUTHN_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio WebAuthn database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio WebAuthn credential and challenge tables before retrying authentication.`
- Expected context: `resource=DB`, action identifying the failed credential
  or user-bound/discovery one-time challenge read

## `AUTH_WEBAUTHN_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio WebAuthn database write failed`
- Guidance: `Verify D1 availability and the current Studio WebAuthn credential, challenge, user, and session tables before retrying the security operation.`
- Expected context: `resource=DB`, action identifying challenge creation or
  consumption, credential registration, rename, removal, counter update, or
  scheduled challenge cleanup

Expected invalid assertions, browser cancellation, expired challenges, and
credential mismatch do not create operational logs. Credential IDs, public
keys, assertions, challenges, authenticator metadata, user identity, and
management grants are never recorded.

Passwordless Passkey Sign-in additionally normalizes unknown or inactive
accounts, unknown credentials, mismatched opaque user handles, expired or
replayed discovery challenges, counter conflicts, and invalid assertions to
`PASSKEY_SIGN_IN_FAILED`. These expected unauthenticated failures are not
logged, which avoids identity disclosure and attacker-controlled log
amplification.

## `AUTH_SESSION_CRYPTO_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio session cryptography is unavailable`
- Guidance: `Verify the deployed Worker runtime supports cryptographically secure random values and Web Crypto SHA-256, then retry authentication.`
- Expected context: `component=web_crypto`,
  `action=create_session_token|verify_session_token`

Opaque session secrets, their digests, cookies, and CSRF tokens are never
recorded.

## `AUTH_SESSION_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio session database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio sessions, authors, media, and site_settings schema, then retry the request.`
- Expected context: `resource=DB`,
  `action=resolve_session|list_sessions|read_account_avatar|validate_account_avatar`

## `AUTH_SESSION_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio session database write failed`
- Guidance: `Verify D1 availability and the current Studio sessions schema. Retry the affected sign-in, sign-out, or session-management action after database service is restored.`
- Expected context: `resource=DB`,
  `action=issue_session|update_session_activity|delete_invalid_session|revoke_session|revoke_other_sessions|revoke_all_user_sessions`

No user ID, IP address, User-Agent, session ID, token, digest, or CSRF value is
included in these operational events.

## `AUTH_SESSION_GARBAGE_COLLECTION_FAILED`

- Level: `error`
- Message: `Expired Studio session cleanup failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio sessions schema. Restore service and allow the next daily scheduled cleanup to retry.`
- Expected context: `resource=DB`, `action=garbage_collect_sessions`,
  `trigger=scheduled`

No session row data is logged. The scheduled invocation is rethrown after this
event so Cloudflare records the failed execution and the next daily trigger can
retry the cleanup.

## `AUTH_SESSION_GARBAGE_COLLECTION_COMPLETED`

- Level: `info`
- Message: `Expired Studio sessions deleted`
- Expected context: `resource=DB`, `action=garbage_collect_sessions`,
  `cutoff_at_iso`, `deleted_rows`

This event is emitted only when at least one expired row was removed. A
successful zero-row cleanup is intentionally silent.

## `AUTH_WEBAUTHN_CHALLENGE_GARBAGE_COLLECTION_COMPLETED`

- Level: `info`
- Message: `Expired Studio WebAuthn challenges deleted`
- Expected context: `resource=DB`,
  `action=garbage_collect_webauthn_challenges`, `cutoff_at_iso`,
  `deleted_rows`

This event is emitted only when at least one expired or consumed one-time
challenge row was removed. Challenge material and account identity are not
logged.

## `CONTENT_AUTOSAVE_GARBAGE_COLLECTION_FAILED`

- Level: `error`
- Message: `Expired Studio content autosave cleanup failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio post_autosaves and page_autosaves tables. Restore service and allow the next daily scheduled cleanup to retry.`
- Expected context: `resource=DB`,
  `action=garbage_collect_content_autosaves`

Autosave snapshots, content identities, user identities, hashes, and authored
content are never logged. The scheduled invocation is rethrown so the next
daily trigger can retry.

## `CONTENT_AUTOSAVE_GARBAGE_COLLECTION_COMPLETED`

- Level: `info`
- Message: `Expired Studio content autosaves deleted`
- Expected context: `resource=DB`,
  `action=garbage_collect_content_autosaves`, `cutoff_at_iso`, `deleted_rows`

This event is emitted only when at least one expired Post/Page autosave row was
removed. Successful zero-row cleanup is intentionally silent.

## `DASHBOARD_STUDIO_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Dashboard database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio posts, pages, and media tables, then reload Dashboard.`
- Expected context: `resource=DB`, `action=read_dashboard_studio_overview`

## `DASHBOARD_STUDIO_DATA_INVALID`

- Level: `error`
- Message: `Studio Dashboard data is invalid`
- Guidance: `Keep the current D1 backup, inspect the posts, pages, and media status or storage values, and restore canonical data before reloading Dashboard.`
- Expected context: `resource=DB`, `action=validate_dashboard_studio_overview`

## `DASHBOARD_EDGE_DATABASE_NOT_CONFIGURED`

- Level: `error`
- Message: `Studio Dashboard Edge database binding is not configured`
- Guidance: `Bind the reviewed ZeroPress Edge D1 database as EDGE_DB. Studio content remains available while the Edge overview is unavailable.`
- Expected context: `component=worker_binding`, `resource=EDGE_DB`,
  `action=read_dashboard_edge_overview`

## `DASHBOARD_EDGE_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Dashboard Edge overview query failed`
- Guidance: `Verify the EDGE_DB binding, D1 availability, and the current ZeroPress comment, Form, Newsletter, and mail settings tables. Studio content remains available while the Edge overview is unavailable.`
- Expected context: `resource=EDGE_DB`, `action=read_dashboard_edge_overview`

## `DASHBOARD_EDGE_DATA_INVALID`

- Level: `error`
- Message: `Studio Dashboard Edge data is invalid`
- Guidance: `Keep the current Edge D1 backup, inspect comment settings, mail settings, and content status values, and restore canonical data before reloading Dashboard.`
- Expected context: `resource=EDGE_DB`, `action=validate_dashboard_edge_overview`

Dashboard reads never log content, account identity, comment text, Form data,
subscriber identity, or mail credentials. Edge overview failures degrade only
that section; the Studio content overview remains available.

## `USER_SETUP_CRYPTO_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio user setup-token cryptography is unavailable`
- Guidance: `Verify the Worker runtime supports cryptographically secure random values and Web Crypto SHA-256 before retrying invitation or credential-recovery management.`
- Expected context: `component=web_crypto`, action identifying setup-token
  generation or digest verification

Setup bearer tokens, secret digests, setup URLs, and user identity are
never recorded.

## `USER_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio user management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio users, roles, setup tokens, MFA, and sessions tables before retrying.`
- Expected context: `resource=DB`, action identifying the failed user,
  setup-token, role, or administrator-safety read

## `USER_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio user management database write failed`
- Guidance: `Verify D1 availability and the current Studio user-management schema, then inspect the affected account state before retrying the operation.`
- Expected context: `resource=DB`, action identifying invitation creation,
  reissue or cancellation, credential recovery, inactive-account deletion,
  account setup, role/status mutation, or session revocation

Expected email/confirmation mismatches, expired setup links, invalid lifecycle
transitions, current-user deletion protection, and last-administrator
protection do not create operational logs. User identity, setup material,
password/MFA data, session identifiers, and management grants are never
recorded.

## `AUTHOR_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio author management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio authors and users tables before retrying.`
- Expected context: `resource=DB`, action identifying the failed author list,
  author read, or eligible-user read

## `AUTHOR_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio author data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected authors row and optional user link, and restore canonical values before retrying.`
- Expected context: `resource=DB`, `action=validate_author_data`

## `AUTHOR_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio author management database write failed`
- Guidance: `Verify D1 availability and the current Studio authors table, then reload Authors before retrying the operation.`
- Expected context: `resource=DB`, action identifying author creation,
  update, or deletion

Expected immutable-ID, user-link, not-found, and revision conflicts do not
create operational logs. Author IDs, display names, user identities, and
revision values are never recorded.

## `TAXONOMY_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio taxonomy management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio categories and tags tables before retrying.`
- Expected context: `resource=DB`, action identifying the failed Category/Tag
  list, identity read, or Preview Data taxonomy read

## `TAXONOMY_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio taxonomy data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected category or tag row, and restore canonical values before retrying.`
- Expected context: `resource=DB`, `action=validate_taxonomy_data`

## `TAXONOMY_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio taxonomy management database write failed`
- Guidance: `Verify D1 availability and the current Studio categories and tags tables, then reload Taxonomy before retrying the operation.`
- Expected context: `resource=DB`, action identifying Category/Tag creation,
  update, or deletion

Expected slug, not-found, revision, and referenced-term conflicts do not create
operational logs. Taxonomy IDs, names, slugs, descriptions, and revisions are
never recorded.

## `MEDIA_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Media management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio media, media_collections, posts, and pages tables before retrying.`
- Expected context: `resource=DB`, action identifying a Media or collection
  list, identity, usage, or Preview Data query

## `MEDIA_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio Media data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected Media or collection row and its references, and restore canonical metadata before retrying.`
- Expected context: `resource=DB`, `action=validate_media_data` or
  `action=validate_media_collection_data`

## `MEDIA_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Media management database write failed`
- Guidance: `Verify D1 availability and the current Studio media and media_collections tables, then reload Media before retrying the operation.`
- Expected context: `resource=DB`, action identifying Media registration,
  update, deletion, collection lifecycle, or bounded bulk movement

Expected duplicate source/name, not-found, revision, non-empty, and
in-use conflicts do not create operational logs. Media URLs, collection names,
alternative text, dimensions, internal IDs, and revisions are never recorded
by metadata-management failures. The
managed-object cleanup entries below may include the exact `uploads/` storage
key and internal Media ID needed for operator recovery; they never include file
contents or authored metadata.

## `MEDIA_UPLOAD_R2_BINDING_NOT_CONFIGURED`

- Level: `error`
- Message: `Studio managed Media storage is not configured`
- Guidance: `Bind the reviewed Studio R2 bucket as MEDIA_BUCKET. Keep managed uploads and R2-backed object deletion disabled until the binding is available.`

## `MEDIA_PREVIEW_R2_BINDING_NOT_CONFIGURED`

- Level: `error`
- Message: `Studio managed Media preview storage is not configured`
- Guidance: `Bind the reviewed Studio R2 bucket as MEDIA_BUCKET before using private Studio previews. A configured site.media_origin remains the public delivery path.`
- Expected context: `resource=MEDIA_BUCKET`,
  `action=read_media_preview_object`

## `MEDIA_PREVIEW_R2_READ_FAILED`

- Level: `error`
- Message: `Studio managed Media preview object read failed`
- Guidance: `Verify MEDIA_BUCKET targets the intended Studio bucket and check Cloudflare R2 availability, then reload Media. A configured site.media_origin remains independent from this private preview path.`
- Expected context: `resource=MEDIA_BUCKET`,
  `action=read_media_preview_object`

An absent Media row, unsupported image format, or missing R2 object is an
expected preview miss and does not create an operational log. During
development, private R2 previews require DB and MEDIA_BUCKET to be both local
or both explicitly remote. A disabled storage path does not log an R2 outage.

## `MEDIA_UPLOAD_STREAM_LENGTH_METADATA_LOST`

- Level: `error`
- Message: `Studio managed Media upload stream lost its declared length`
- Guidance: `This is a Studio upload-pipeline or Workers runtime integration failure, not evidence of an R2 binding outage. Update Studio to a build that passes the final upload body through FixedLengthStream immediately before MEDIA_BUCKET.put. If the deployed build already does so, preserve the operational code and runtime version and report a Workers runtime regression. The pending upload intent expires automatically.`
- Expected context: `resource=MEDIA_BUCKET`, `action=put_media_object`,
  `reason=final_stream_length_unknown`, exact `uploads/` storage key and internal
  Media ID

## `MEDIA_UPLOAD_SVG_SANITIZER_FAILED`

- Level: `error`
- Message: `Studio managed SVG sanitizer failed`
- Guidance: `Verify the deployed Studio bundle contains the reviewed @zeropress/svg-hush Workerd WASM artifact and matching zeropress-svg-v1 profile. The source SVG was not written to R2; retry only after restoring the reviewed Studio build.`
- Expected context: `resource=SVG_SANITIZER`,
  `action=sanitize_managed_svg_upload`

Malformed or policy-rejected SVG input returns the expected public
`MEDIA_UPLOAD_SVG_SANITIZATION_FAILED` error without an operational log. The
operational entry above is reserved for an unexpected sanitizer runtime or
integration failure and never includes source SVG bytes.

## `MEDIA_UPLOAD_R2_WRITE_FAILED`

- Level: `error`
- Message: `Studio managed Media object upload failed`
- Guidance: `Verify MEDIA_BUCKET still targets the intended bucket and check Cloudflare R2 service availability before retrying. The pending upload intent expires automatically.`

## `MEDIA_UPLOAD_COMPENSATION_DELETE_FAILED`

- Level: `warn`
- Message: `Studio could not immediately remove an uncommitted Media object`
- Guidance: `Inspect the recorded uploads/ storage key and the media_object_deletions queue. Restore R2 and D1 availability so scheduled cleanup can safely retry.`

## `MEDIA_UPLOAD_INTENT_GARBAGE_COLLECTION_FAILED`

- Level: `error`
- Message: `Expired Studio Media upload-intent cleanup failed`
- Guidance: `Verify D1 availability and the current media_upload_intents table, then allow the next daily scheduled cleanup to retry.`

## `MEDIA_UPLOAD_INTENT_GARBAGE_COLLECTION_COMPLETED`

- Level: `info`
- Message: `Expired Studio Media upload intents deleted`

## `MEDIA_OBJECT_CLEANUP_QUEUE_FAILED`

- Level: `error`
- Message: `Studio could not queue a managed Media object deletion`
- Guidance: `Verify D1 availability and the media_object_deletions table. Preserve the logged R2-backed storage key until a reviewed cleanup can be queued or completed.`

## `MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio managed Media deletion queue database operation failed`
- Guidance: `Verify D1 availability and the current media_object_deletions table, then allow the next scheduled cleanup to retry.`

## `MEDIA_OBJECT_CLEANUP_DEFERRED`

- Level: `warn`
- Message: `Studio deferred a managed Media object deletion`
- Guidance: `The Media metadata operation completed and the R2-backed key remains in media_object_deletions. Check R2 availability and allow scheduled cleanup to retry.`

## `MEDIA_OBJECT_CLEANUP_FAILED`

- Level: `error`
- Message: `Studio managed Media object cleanup failed`
- Guidance: `Check MEDIA_BUCKET and Cloudflare R2 availability. Pending R2-backed keys remain durable in media_object_deletions for the next daily retry.`

## `MEDIA_OBJECT_CLEANUP_COMPLETED`

- Level: `info`
- Message: `Studio managed Media objects deleted`

## `WXR_IMPORT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio WXR import database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio Author, taxonomy, Media, Post, Page, and Menu tables before retrying the same import file.`
- Expected context: `resource=DB`, action identifying the failed WXR core
  identity or relationship lookup

## `WXR_IMPORT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio WXR import database write failed`
- Guidance: `Completed content chunks may already be present, while final settings writes remain atomic. Verify D1 availability, then retry the same WXR file; deterministic upserts leave completed rows unchanged.`
- Expected context: `resource=DB`, action identifying the failed WXR Author,
  taxonomy, Media, Post, Page, Menu upsert, or final General/Routing settings
  write

Expected authored-slug, missing-reference, parent-cycle, Front Page, Menu
reference/limit, and concurrent-revision conflicts are bounded row results and
do not create operational logs. WXR file contents, source URLs, titles, author
identities, public IDs, and imported row data are never recorded.

## `WXR_COMMENT_IMPORT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio WXR comment import Edge query failed`
- Guidance: `Verify the EDGE_DB binding, D1 availability, and the current ZeroPress Edge comment target and comment schema before retrying the same WXR file.`
- Expected context: `resource=EDGE_DB`, action identifying the target or
  imported-comment identity lookup

## `WXR_COMMENT_IMPORT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio WXR comment import Edge write failed`
- Guidance: `Verify EDGE_DB availability and its current comment schema, then retry the same WXR file; deterministic imported-comment identities make a full retry safe.`
- Expected context: `resource=EDGE_DB`, `action=upsert_wxr_comments`

Missing targets, imported public-ID conflicts, and unavailable parents are
bounded row results and do not create operational logs. Comment bodies,
authors, email addresses, target identities, public IDs, source timestamps,
and complete WXR rows are never recorded.

## `CONTENT_SEARCH_INDEX_STATE_QUERY_FAILED`

- Level: `error`
- Message: `Studio content-search index state query failed`
- Guidance: `Keep canonical Post and Page content unchanged. Verify the DB binding and the content_search_index_state table, then use Maintenance & Recovery to rebuild the derived search index.`
- Expected context: `resource=DB`, one of
  `action=read_content_search_index_state`,
  `action=read_dashboard_content_search_index_state`, or an Operations status
  inspection action

The event contains the lifecycle failure classification only. Search input,
titles, snippets, content, public IDs, revisions, and operation IDs are not
recorded.

## `CONTENT_SEARCH_INDEX_QUERY_FAILED`

- Level: `error`
- Message: `Studio content-search index query failed`
- Guidance: `Keep canonical Post and Page content unchanged. Verify the FTS5 tables and D1 availability, then use Maintenance & Recovery to rebuild the derived search index.`
- Expected context: `resource=DB`, `action=search_posts|search_pages`

Neither the query tokens nor matched content/snippets are included.

## `CONTENT_SEARCH_INDEX_REBUILD_FAILED`

- Level: `error`
- Message: `Studio content-search index rebuild failed`
- Guidance: `Check the current index status and resume from its saved progress. Use Maintenance & Recovery for a forced restart or recovery. Canonical content remains unchanged by the rebuild.`
- Expected context: `resource=DB`, one of
  `action=start_content_search_index_rebuild`,
  `action=apply_content_search_index_rebuild_step`, plus the initiating
  administrator snapshot when established

The log may identify the safe lifecycle phase but never includes authored
content, search input, an FTS row, or a cursor/public ID.

## `CONTENT_SEARCH_INDEX_REBUILD_COMPLETED`

- Level: `info`
- Message: `Studio content-search index rebuild completed`
- Guidance: `The derived Post and Page search index passed row-count, revision-parity, and FTS integrity verification.`
- Expected context: `resource=DB`,
  `action=complete_content_search_index_rebuild`, processed Post/Page counts,
  and the initiating administrator snapshot

This confirms derived-index integrity, not any change to canonical content.

## `AI_BINDING_NOT_CONFIGURED`

- Level: `error`
- Message: `Studio Workers AI binding is not configured`
- Guidance: `Bind Workers AI as AI and redeploy the Worker configuration. Normal Post and Page editing remains available without AI generation.`
- Expected context: `resource=AI`, bounded
  `action=generate_excerpt|generate_post_draft|generate_post_edit|generate_page_draft|generate_image`, and target
  type (`post|page|media`)

The log never includes the user identity, title, brief, content, prompt
payload, excerpt, or model output.

## `AI_REQUEST_RATE_LIMITER_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio AI request rate limiter is unavailable`
- Guidance: `Verify the AI_REQUEST_RATE_LIMITER binding and Cloudflare Rate Limiting service status. Normal Post and Page editing remains available.`
- Expected context: `resource=AI_REQUEST_RATE_LIMITER`, bounded
  `action=limit_excerpt_generation|limit_post_draft_generation|limit_post_edit_generation|limit_page_draft_generation|limit_image_generation`,
  and target type

The rate-limit key and user identity are not logged.

## `AI_EXCERPT_GENERATION_FAILED`

- Level: `error`
- Message: `Studio AI excerpt generation failed`
- Guidance: `Verify Workers AI availability, account quota, and the configured model constant before retrying. Keep editing manually while the optional AI service is unavailable.`
- Expected context: `resource=AI`, `action=generate_excerpt`, target type, and
  a bounded `reason=request_failed|timeout`

Provider error text is intentionally omitted because it may contain echoed
authored input. The title, content, prompt payload, model output, excerpt, and
user identity are never recorded.

## `AI_EXCERPT_RESPONSE_INVALID`

- Level: `error`
- Message: `Studio AI excerpt response was invalid`
- Guidance: `Do not apply the generated result. Verify the configured model and prompt contract before retrying or continue editing the excerpt manually.`
- Expected context: `resource=AI`, `action=generate_excerpt`, and the bounded
  target type

The invalid model output and all authored source data are intentionally
omitted.

## `AI_POST_DRAFT_GENERATION_FAILED`

- Level: `error`
- Message: `Studio AI Post draft generation failed`
- Guidance: `Verify Workers AI availability, account quota, and the configured Post draft model constant before retrying. Keep writing manually while the optional AI service is unavailable.`
- Expected context: `resource=AI`, `action=generate_post_draft`,
  `target_type=post`, and a bounded `reason=request_failed|timeout`

Provider error text is intentionally omitted because it may contain echoed
authored input. The title, brief, prompt payload, model output, generated
fields, limiter key, and user identity are never recorded.

## `AI_POST_DRAFT_RESPONSE_INVALID`

- Level: `error`
- Message: `Studio AI Post draft response was invalid`
- Guidance: `Do not apply the generated result. Verify the configured model and Post draft prompt contract before retrying or continue writing manually.`
- Expected context: `resource=AI`, `action=generate_post_draft`, and
  `target_type=post`

The invalid model output and all authored source data are intentionally
omitted.

## `AI_POST_EDIT_GENERATION_FAILED`

- Level: `error`
- Message: `Studio AI Post edit generation failed`
- Guidance: `Verify Workers AI availability, account quota, and the configured Post edit model constant before retrying. The selected source and current editor draft remain unchanged.`
- Expected context: `resource=AI`, `action=generate_post_edit`,
  `target_type=post`, the Post internal ID, and bounded
  `reason=request_failed|timeout`

Provider error text is intentionally omitted because it may echo authored
input. The selection, surrounding context, author instruction, prompt, model
output, limiter key, and user identity are never recorded.

## `AI_POST_EDIT_RESPONSE_INVALID`

- Level: `error`
- Message: `Studio AI Post edit response was invalid`
- Guidance: `Do not apply the generated result. Verify the configured model and Post edit prompt contract before retrying or continue editing the Post manually.`
- Expected context: `resource=AI`, `action=generate_post_edit`,
  `target_type=post`, and the Post internal ID

The invalid model output and every authored input field are intentionally
omitted. Expected selection validation failures are API results and do not
create operational logs.

## `AI_PAGE_DRAFT_GENERATION_FAILED`

- Level: `error`
- Message: `Studio AI Page draft generation failed`
- Guidance: `Verify Workers AI availability, account quota, and the configured Page draft model constant before retrying. Keep writing manually while the optional AI service is unavailable.`
- Expected context: `resource=AI`, `action=generate_page_draft`,
  `target_type=page`, and a bounded `reason=request_failed|timeout`

Provider error text is intentionally omitted because it may contain echoed
authored input. The title, brief, preset, prompt payload, model output,
generated fields, limiter key, and user identity are never recorded.

## `AI_PAGE_DRAFT_RESPONSE_INVALID`

- Level: `error`
- Message: `Studio AI Page draft response was invalid`
- Guidance: `Do not apply the generated result. Verify the configured model and Page draft prompt contract before retrying or continue writing manually.`
- Expected context: `resource=AI`, `action=generate_page_draft`, and
  `target_type=page`

The invalid model output and all authored source data are intentionally
omitted.

## `AI_IMAGE_GENERATION_FAILED`

- Level: `error`
- Message: `Studio AI image generation failed`
- Guidance: `Inspect the provider status and code when available, then verify Workers AI availability, account quota, and the configured image model.`
- Expected context: `resource=AI`, `action=generate_image`,
  `target_type=media`, fixed model and prompt version, and bounded
  `reason=request_failed|timeout`, plus `provider_status` and numeric
  `provider_code` (1000–9999) when available

The verified FLUX content-screening rejection (HTTP 400, code 3030 and the
exact provider rejection description) returns `422 AI_IMAGE_CONTENT_REJECTED`
without an operational failure log. Other code-3030 responses remain provider
failures; the code alone does not identify content screening.

The prompt, provider error text and output bytes, limiter key, and user identity
are intentionally omitted.

## `AI_IMAGE_RESPONSE_INVALID`

- Level: `error`
- Message: `Studio AI image response was invalid`
- Guidance: `The generated bytes were not stored. Verify the configured image model and image-v1 output contract before retrying.`
- Expected context: `resource=AI`, `action=generate_image`,
  `target_type=media`, fixed model and prompt version

The invalid base64 or image bytes and authored prompt are never recorded.

## `AI_IMAGE_STORAGE_FAILED`

- Level: `error`
- Message: `Studio AI image could not be stored as managed Media`
- Guidance: `Verify the Studio DB and MEDIA_BUCKET bindings. A generated result is usable only after its immutable R2 object and Media row are both materialized.`
- Expected context: bounded `resource=DB|MEDIA_BUCKET`, related resource,
  `action=create_ai_image_upload_intent|store_ai_generated_media`, and a
  repository result reason

The generated bytes, prompt, user identity, upload ID, Media ID, storage key,
and limiter key are not included. R2 or D1 exceptions in the ordinary managed
upload path retain their existing dedicated operational codes.

## `POST_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Post management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio Post, relation, autosave, and saved-revision tables before retrying.`
- Expected context: `resource=DB`, action identifying the failed Post list,
  detail, editor-option, identity, saved-revision, or Preview Data query

## `POST_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio Post data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected Post, its relations, and any selected saved-revision snapshot, and restore canonical values before retrying.`
- Expected context: `resource=DB`, action identifying Post or saved-revision validation

## `POST_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Post management database write failed`
- Guidance: `Verify D1 availability and the current Studio Post, relation, autosave, and saved-revision tables, then reload Posts before retrying the operation.`
- Expected context: `resource=DB`, action identifying Post creation, update,
  saved-revision archival/restore, permanent deletion, or public-ID allocation

Expected slug, missing relation, not-found, revision, and not-in-trash
conflicts do not create operational logs. Post IDs, public IDs, titles, slugs,
content, excerpts, relationship IDs, and revisions are never recorded.

## `PAGE_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Page management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio pages, autosave, and saved-revision tables before retrying.`
- Expected context: `resource=DB`, action identifying the failed Page list,
  detail, parent-option, hierarchy, identity, saved-revision, or Preview Data query

## `PAGE_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio Page data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected Page, its parent chain, and any selected saved-revision snapshot, and restore canonical values before retrying.`
- Expected context: `resource=DB`, action identifying Page, hierarchy, or saved-revision validation

## `PAGE_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Page management database write failed`
- Guidance: `Verify D1 availability and the current Studio pages, autosave, and saved-revision tables, then reload Pages before retrying the operation.`
- Expected context: `resource=DB`, action identifying Page creation, update,
  saved-revision archival/restore, permanent deletion, or public-ID allocation

Expected sibling-slug, parent, cycle, child, not-found, revision, and
not-in-trash conflicts do not create operational logs. Page IDs, public IDs,
titles, slugs, paths, content, excerpts, parent IDs, and revisions are never
recorded.

## `MENU_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Menu management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio menus and referenced-content tables before retrying.`
- Expected context: `resource=DB`, action identifying Menu list, item option,
  reference, identity, or Preview Data reads

## `MENU_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio Menu data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected Menu row and canonical item tree, and restore valid data before retrying.`
- Expected context: `resource=DB`, `action=validate_menu_data`

## `MENU_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Menu management database write failed`
- Guidance: `Verify D1 availability and the current Studio menus table, then reload Menus before retrying the operation.`
- Expected context: `resource=DB`, action identifying Menu creation, update,
  or deletion

Expected ID, missing-reference, protected-menu, not-found, revision, and Menu
count conflicts do not create operational logs. Menu IDs, names, item labels,
URLs, references, metadata, and revisions are never recorded.

## `WIDGET_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Widget management database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio widget_areas and authors tables before retrying.`
- Expected context: `resource=DB`, action identifying Widget area list,
  Author option, profile reference, identity, or Preview Data reads

## `WIDGET_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `Studio Widget data is invalid`
- Guidance: `Keep the current D1 backup, inspect the affected Widget area row and canonical item list, and restore valid data before retrying.`
- Expected context: `resource=DB`, `action=validate_widget_data`

## `WIDGET_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Widget management database write failed`
- Guidance: `Verify D1 availability and the current Studio widget_areas table, then reload Widgets before retrying the operation.`
- Expected context: `resource=DB`, action identifying Widget area creation,
  save, or deletion

Expected ID, missing-Author, protected-area, not-found, revision, and Widget
area count conflicts do not create operational logs. Widget area
IDs, names, item values, Author identities, and revisions are never recorded.

## `STUDIO_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio interface settings database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio studio_settings table before retrying sign-in or Interface Settings.`
- Expected context: `resource=DB`, `action=read_interface_settings`

## `STUDIO_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio interface settings data is invalid`
- Guidance: `Keep the current D1 backup, inspect the interface locale rows and revision in studio_settings, and restore values supported by the deployed Studio build.`
- Expected context: `resource=DB`, `action=validate_interface_settings`

The public bootstrap endpoint fails closed at the API boundary when the
product-owned document is partial or malformed. The client falls back to the
English interface so an operator can still reach Studio. Stored locale values,
revisions, and administrator identities are not logged.

## `STUDIO_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio interface settings update failed`
- Guidance: `Verify D1 availability and the current Studio studio_settings table, then reload Interface Settings before retrying the update.`
- Expected context: `resource=DB`, `action=update_interface_settings`

A stale revision is an expected concurrency rejection and does not create an
operational log.

## `CLOUDFLARE_ACCESS_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Cloudflare Access settings database query failed`
- Guidance: `Keep Studio content unchanged. Verify D1 availability and the Cloudflare Access rows in studio_settings, then retry. Recovery mode bypasses this optional second-level gate.`
- Expected context: `resource=DB`,
  `action=read_cloudflare_access_settings`

## `CLOUDFLARE_ACCESS_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Cloudflare Access settings data is invalid`
- Guidance: `Keep Studio in recovery mode, inspect the revisioned Cloudflare Access document in studio_settings, and disable or restore one canonical document before returning to operational mode.`
- Expected context: `resource=DB`,
  `action=validate_cloudflare_access_settings`

When both settings rows are absent, Cloudflare Access enforcement is disabled. A
partial or malformed document fails closed in operational and maintenance
mode. The stored issuer, audience, bound origin, Access identity, JWT, and
settings revision are never written to operational logs.

## `CLOUDFLARE_ACCESS_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Cloudflare Access settings update failed`
- Guidance: `Verify D1 availability and the current studio_settings table, then reload Cloudflare Access settings before retrying the change.`
- Expected context: `resource=DB`,
  `action=update_cloudflare_access_settings`

Expected revision conflicts and attempts to enable without a verified Access
assertion do not create operational logs.

## `CLOUDFLARE_ACCESS_RECOVERY_COMPLETED`

- Level: `info`
- Message: `Cloudflare Access requirement recovery completed`
- Guidance: `Verify Studio remains reachable without Cloudflare Access, correct the Access application or policy, then enable the requirement again only from a request that Studio verifies.`
- Expected context: `resource=DB`,
  `action=disable_cloudflare_access_requirement`

This event records only that the Studio-side requirement was returned to its
canonical disabled state. It never records the previous issuer, audience,
origin, assertion, or identity.

## `CLOUDFLARE_ACCESS_VERIFICATION_FAILED`

- Level: `error`
- Message: `Cloudflare Access verification is unavailable`
- Guidance: `Keep Studio content unchanged. Verify Cloudflare Access and its team JWKS endpoint, or enter recovery mode and disable the second-level requirement before restoring operational mode.`
- Expected context: `component=cloudflare_access`,
  `action=verify_cloudflare_access_assertion`

The active-incident synchronizer emits this service-level failure once per
failure episode. Missing, expired, malformed, wrong-issuer, wrong-audience,
wrong-origin, and invalid-signature assertions are expected fail-closed
rejections and do not create operational logs. JWTs, identities, issuers, and
audiences are never logged.

## `EDGE_INTEGRATION_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Edge integration settings query failed`
- Guidance: `Verify the DB binding, D1 availability, and the edge_integration_mode and edge_integration_revision rows in studio_settings. Studio treats the integration as disabled until the document is repaired.`
- Expected context: `resource=DB`,
  `action=read_edge_integration_settings`

## `EDGE_INTEGRATION_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio Edge integration settings are invalid`
- Guidance: `Keep the current DB backup, inspect edge_integration_mode and edge_integration_revision in studio_settings, and restore one canonical revisioned document. Studio remains fail-closed with Edge integration disabled.`
- Expected context: `resource=DB`,
  `action=validate_edge_integration_settings`

## `EDGE_INTEGRATION_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Edge integration settings update failed`
- Guidance: `Verify D1 availability and the current Studio studio_settings table, then reload Edge Services before retrying the mode change.`
- Expected context: `resource=DB`,
  `action=update_edge_integration_settings`

Expected revision conflicts do not create operational logs.

## `EDGE_INTEGRATION_HEALTH_CHECK_FAILED`

- Level: `error`
- Message: `Studio Edge integration health check failed`
- Guidance: `Verify EDGE_DB and EDGE_KV bindings, Edge D1 availability, the reviewed Edge baseline and singleton seed rows, then retry from Edge Services. Studio content remains available.`
- Expected context: Edge health-check action and the affected binding, schema,
  singleton, or target parity reason

The inspection never repairs, deletes, or upgrades Edge data. It only decides
whether Studio may enable the integration or publish an Edge-dependent
Preview Data document.

## `EDGE_DATABASE_LIFECYCLE_FAILED`

- Level: `error`
- Message: `Edge database lifecycle operation failed`
- Guidance: `Keep EDGE_MAINTENANCE_MODE=true and retain the reviewed Edge SQL backup. Keep Studio in maintenance for install or adoption; an upgrade may be resumed from Operations in operational or maintenance mode. Verify the EDGE_DB binding, lifecycle state, and vendored artifact checksums before retrying the same operation.`
- Expected context: `resource=EDGE_DB` and the failed install, adoption, or
  forward-only upgrade action

## `EDGE_DATABASE_UPGRADE_STARTED`

- Level: `info`
- Message: `Edge database upgrade started`
- Guidance: `Keep EDGE_MAINTENANCE_MODE=true and retain the reviewed Edge SQL backup until the upgrade completes and Edge Services has been verified.`
- Expected context: `resource=EDGE_DB`, `action=upgrade_edge_database`, the
  resumable operation ID, and the initiating administrator identity

## `EDGE_DATABASE_LIFECYCLE_COMPLETED`

- Level: `info`
- Message: `Edge database lifecycle operation completed`
- Guidance: `Keep EDGE_MAINTENANCE_MODE=true until target reconciliation has completed and Edge Services reports that the integration can be enabled.`
- Expected context: `resource=EDGE_DB`, the completed lifecycle action, and
  the resulting schema version

## `EDGE_TARGET_RECONCILIATION_FAILED`

- Level: `error`
- Message: `Edge comment-target reconciliation failed`
- Guidance: `Keep STUDIO_SITE_MODE=maintenance and EDGE_MAINTENANCE_MODE=true. Retry the same operation ID; bounded steps are idempotent. Review orphan targets before deleting any target or its comments.`
- Expected context: `resource=DB`, `related_resource=EDGE_DB`, the current
  bounded reconciliation action, and a safe operation identifier when present

## `EDGE_TARGET_RECONCILIATION_COMPLETED`

- Level: `info`
- Message: `Edge comment-target reconciliation action completed`
- Guidance: `Verify the reported reconciliation state. Keep maintenance boundaries until final parity is complete; review orphan targets before deletion and verify Edge Services before resuming public writes.`
- Expected context: the completed bounded action, its safe operation ID, and
  the canonical initiating administrator snapshot

## `SITE_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio site settings database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.`
- Expected context: `resource=DB`, `action=read_general_settings`

## `SITE_SETTINGS_INCOMPLETE`

- Level: `warn`
- Message: `Studio General Settings document is incomplete`
- Guidance: `Use the authenticated General Settings recovery action to review and replace only missing fields with documented defaults. Restore a known-good backup instead if the former values must be preserved.`
- Expected context: `resource=DB`,
  `action=inspect_general_settings_recovery`, and the bounded list of missing
  field names

The settings screen returns a recovery plan without writing. A repair is a
separate authenticated action that rechecks the revision and missing-field
set, preserves every valid value, and atomically writes the complete document.
Settings values and revisions are not logged.

## `SITE_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio site settings data is invalid`
- Guidance: `Keep a current D1 backup. Restore a reviewed known-good database backup, or use Reset Studio from Maintenance & Recovery after preserving required data.`
- Expected context: `resource=DB`, `action=validate_general_settings`

This event indicates malformed, incorrectly typed, non-canonical, or
revision/timestamp-inconsistent product-owned rows rather than a recoverable
missing field. Studio does not offer a default-fill action for this state.
Stored setting values and administrator identity are not included in the log.

## `SITE_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio site settings update failed`
- Guidance: `Verify D1 availability and the current Studio site_settings table, then reload General Settings before retrying the update.`
- Expected context: `resource=DB`, `action=update_general_settings`

A stale revision is an expected concurrency rejection and does not create an
operational log. Setting values, revisions, and administrator identity are not
recorded.

## `SITE_OUTPUT_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio output settings database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.`
- Expected context: `resource=DB`, `action=read_output_settings`

## `SITE_OUTPUT_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio output settings data is invalid`
- Guidance: `Keep the current D1 backup, inspect the canonical Homepage and output rows and revision, and restore known-good values before retrying.`
- Expected context: `resource=DB`, `action=validate_output_settings`

This event identifies incomplete, incorrectly typed, non-canonical, or
revision-inconsistent product-owned output rows. Stored values and
administrator identity are not included in the log.

## `SITE_OUTPUT_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio output settings update failed`
- Guidance: `Verify D1 availability and the current Studio site_settings table, then reload Homepage and output before retrying the update.`
- Expected context: `resource=DB`, `action=update_output_settings`

A stale output-settings revision is an expected concurrency rejection and is
not logged. Setting values, revisions, and administrator identity are never
recorded.

## `SITE_NEWSLETTER_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Newsletter CTA settings query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.`
- Expected context: `resource=DB`, `action=read_newsletter_settings`

## `SITE_NEWSLETTER_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio Newsletter CTA settings are invalid`
- Guidance: `Keep the current D1 backup, inspect the canonical Newsletter CTA row and revision, and restore known-good values before retrying.`
- Expected context: `resource=DB`, `action=validate_newsletter_settings`

## `SITE_NEWSLETTER_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Newsletter CTA settings update failed`
- Guidance: `Verify D1 availability and the current Studio site_settings table, then reload Newsletter before retrying the update.`
- Expected context: `resource=DB`, `action=update_newsletter_settings`

CTA text and URLs, revisions, and administrator identity are never recorded.
A malformed public request or stale revision is an expected rejection and is
not logged.

## `MAIL_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio mail delivery settings query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.`
- Expected context: `resource=DB`, one of `action=read_mail_settings`,
  `action=read_mail_settings_for_update`,
  `action=read_mail_runtime_configuration`, or
  `action=read_mail_credential`

## `MAIL_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio mail delivery settings are invalid`
- Guidance: `Keep the current D1 backup, inspect the canonical mail settings rows and encrypted credential envelopes, and restore known-good values before retrying.`
- Expected context: `resource=DB`, `action=validate_mail_settings`

## `MAIL_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio mail delivery settings update failed`
- Guidance: `Verify D1 availability and the current Studio site_settings table, then reload Mail delivery before retrying the update.`
- Expected context: `resource=DB`, `action=update_mail_settings`

## `PUBLISHING_CREDENTIAL_CRYPTO_FAILED`

- Level: `error`
- Message: `Studio publishing credential encryption failed`
- Guidance: `Verify STUDIO_AUTH_SECRET matches the secret used to save Publishing settings, then replace the API token if needed.`

## `PUBLISHING_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio publishing settings query failed`
- Guidance: `Verify DB availability before retrying.`

## `PUBLISHING_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio publishing settings update failed`
- Guidance: `Verify DB availability before saving Publishing settings again.`

## `PUBLISHING_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio publishing settings are invalid`
- Guidance: `Restore valid Publishing settings from a database backup.`

## `PUBLISHING_PROVIDER_FAILED`

- Level: `error`
- Message: `GitHub publishing request failed`
- Guidance: `Review the Publishing connection settings. If the write result is unknown, check the latest GitHub file commit before publishing again.`

## `ANALYTICS_CREDENTIAL_CRYPTO_FAILED`

- Level: `error`
- Message: `Studio analytics credential encryption failed`
- Guidance: `Verify STUDIO_AUTH_SECRET matches the secret used to save Analytics settings, then replace the API token if needed.`

## `ANALYTICS_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio analytics settings query failed`
- Guidance: `Verify DB availability before retrying.`

## `ANALYTICS_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio analytics settings update failed`
- Guidance: `Verify DB availability before saving Analytics settings again.`

## `ANALYTICS_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio analytics settings are invalid`
- Guidance: `Restore valid Analytics settings from a database backup.`

## `ANALYTICS_PROVIDER_FAILED`

- Level: `error`
- Message: `Cloudflare Web Analytics query failed`
- Guidance: `Review the Analytics connection settings and retry.`

## `ANALYTICS_CACHE_FAILED`

- Level: `warn`
- Message: `Studio analytics cache is unavailable`

## `MAIL_CREDENTIAL_CRYPTO_FAILED`

- Level: `error`
- Message: `Studio mail credential cryptography failed`
- Guidance: `Verify STUDIO_AUTH_SECRET has not been lost or rotated and the Worker runtime supports HKDF and AES-GCM. Replace the provider credential after restoring a stable installation secret.`
- Expected context: `resource=STUDIO_AUTH_SECRET`, one of
  `action=encrypt_mail_credential` or `action=decrypt_mail_credential`

## `MAIL_PROVIDER_REQUEST_FAILED`

- Level: `error`
- Message: `Studio mail provider request failed`
- Guidance: `Check the selected provider service status and the Worker outbound request path, then retry connection verification or test delivery. Use a fresh provider credential only if the provider reports it is invalid.`
- Expected context: `service=resend|cloudflare`,
  `action=verify_credential|send_mail`, bounded status/reason metadata

## `MAIL_PROVIDER_RESPONSE_INVALID`

- Level: `error`
- Message: `Studio mail provider returned an invalid response`
- Guidance: `Verify the selected provider API is compatible with this Studio release, then inspect provider status and retry. Do not log or expose response bodies that may contain account details.`
- Expected context: `service=resend|cloudflare`,
  `action=verify_credential|send_mail`, bounded reason metadata

Mail credentials, sender and recipient addresses, subjects, message bodies,
provider response bodies, account IDs, setting revisions, and administrator
identity are never recorded. Expected credential rejection and other bounded
provider 4xx responses return stable API errors without an operational log.

## `FORM_EDGE_DATABASE_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress Forms database binding is not configured`
- Guidance: `Bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before using Form runtime or submission management.`
- Expected context: `component=worker_binding`, `resource=EDGE_DB`,
  `action=resolve_form_edge_database`

No database identifier or configuration value is recorded.

## `FORM_EDGE_CACHE_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress Forms cache binding is not configured`
- Guidance: `Bind EDGE_KV to the KV namespace used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before changing a public Form definition.`
- Expected context: `component=worker_binding`, `resource=EDGE_KV`,
  `action=resolve_form_edge_cache`

## `FORM_EDGE_CACHE_INVALIDATION_FAILED`

- Level: `error`
- Message: `ZeroPress Forms public cache invalidation failed`
- Guidance: `The EDGE_DB update may already be complete. Verify EDGE_KV availability and delete the matching form-info:v2 cache key or wait for its five-minute expiry before testing the public Form endpoint.`
- Expected context: `resource=EDGE_KV`, `action=invalidate_form_info`

The Form slug and complete cache key are intentionally omitted. This event
means the Edge D1 mutation may already be visible to uncached requests.

## `FORM_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `ZeroPress Forms management query failed`
- Guidance: `Verify EDGE_DB availability and the current ZeroPress Edge Form tables before reloading Forms management.`
- Expected context: `resource=EDGE_DB`, bounded management `action`

## `FORM_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `ZeroPress Forms management data is invalid`
- Guidance: `Keep the EDGE_DB backup, inspect the affected Form, field, submission, value, or mail-settings row, and restore canonical values before retrying.`
- Expected context: `resource=EDGE_DB`, bounded validation `action`

## `FORM_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `ZeroPress Forms management update failed`
- Guidance: `Verify EDGE_DB availability and the current ZeroPress Edge Form tables, then reload the affected Form view before retrying.`
- Expected context: `resource=EDGE_DB`, bounded management `action`

Form and submission IDs, recipient or submitter email addresses, field
values, source URLs, authored copy, and revision timestamps are never logged.
Expected missing rows, duplicate slugs, stale revisions, protected deletion,
and malformed requests are not operational events.

## `NEWSLETTER_EDGE_DATABASE_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress Newsletter database binding is not configured`
- Guidance: `Bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before using Newsletter runtime or subscriber management.`
- Expected context: `component=worker_binding`, `resource=EDGE_DB`,
  `action=resolve_newsletter_edge_database`

No database identifier or configuration value is recorded.

## `NEWSLETTER_EDGE_CACHE_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress Newsletter cache binding is not configured`
- Guidance: `Bind EDGE_KV to the KV namespace used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before changing Newsletter presentation fields.`
- Expected context: `component=worker_binding`, `resource=EDGE_KV`,
  `action=resolve_newsletter_edge_cache`

## `NEWSLETTER_EDGE_CACHE_INVALIDATION_FAILED`

- Level: `error`
- Message: `ZeroPress Newsletter public cache invalidation failed`
- Guidance: `The EDGE_DB update may already be complete. Verify EDGE_KV availability and delete the matching newsletter-info:v1 cache key or wait for its five-minute expiry before testing the public Newsletter endpoint.`
- Expected context: `resource=EDGE_KV`,
  `action=invalidate_newsletter_info`

The Newsletter slug and complete cache key are intentionally omitted. This
event means the Edge D1 mutation may already be visible to uncached requests.

## `NEWSLETTER_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `ZeroPress Newsletter management query failed`
- Guidance: `Verify EDGE_DB availability and the current ZeroPress Edge Newsletter tables before reloading Newsletter management.`
- Expected context: `resource=EDGE_DB`, bounded management `action`

## `NEWSLETTER_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `ZeroPress Newsletter management data is invalid`
- Guidance: `Keep the EDGE_DB backup, inspect the affected Newsletter list, field, subscription, suppression, or mail-settings row, and restore canonical values before retrying.`
- Expected context: `resource=EDGE_DB`, bounded validation `action`

## `NEWSLETTER_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `ZeroPress Newsletter management update failed`
- Guidance: `Verify EDGE_DB availability and the current ZeroPress Edge Newsletter tables, then reload the affected Newsletter view before retrying.`
- Expected context: `resource=EDGE_DB`, bounded management `action`

Newsletter and subscription IDs, email addresses, field values, source URLs,
suppression notes, authored copy, and revision timestamps are never logged.
Expected missing rows, stale revisions, and malformed requests are not
operational events.

## `NEWSLETTER_POST_NOTIFICATION_QUEUE_FAILED`

- Level: `error`
- Message: `Studio could not queue a Post subscriber notification`
- Guidance: `Verify the MAIL_QUEUE producer binding and its configured Queue, then retry the explicit subscriber notification from the unchanged published Post revision.`
- Expected context: `resource=MAIL_QUEUE`,
  `action=queue_post_notification`; a missing binding also includes
  `component=worker_binding`

This event never records Post IDs, revisions, titles, excerpts, paths,
Newsletter IDs, recipient counts, subscription IDs, or email addresses.

## `EDGE_MAIL_QUEUE_CONFIGURATION_NOT_AVAILABLE`

- Level: `error`
- Message: `Studio mail queue delivery configuration is unavailable`
- Guidance: `Open Mail delivery, save a complete provider credential and sender configuration, send a successful test email, then enable Newsletter confirmation.`
- Expected context: `resource=DB`,
  `action=resolve_mail_delivery_configuration`, `trigger=queue`,
  bounded message type, attempt, and disposition

## `EDGE_MAIL_QUEUE_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio mail queue database query failed`
- Guidance: `Verify DB and EDGE_DB availability and the current Newsletter, Form, recipient, and mail queue source tables. The queue will retry the message automatically.`
- Expected context: `resource=DB|EDGE_DB`, bounded queue `action`,
  `trigger=queue`, bounded message type, attempt, and disposition

## `EDGE_MAIL_QUEUE_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio mail queue delivery-state update failed`
- Guidance: `Verify EDGE_DB availability and newsletter_subscriptions. The provider may already have accepted the message; preserve the idempotency context and allow the queue retry before intervening.`
- Expected context: `resource=EDGE_DB`, bounded queue `action`,
  `trigger=queue`, bounded message type, attempt, and disposition

## `EDGE_MAIL_QUEUE_MESSAGE_INVALID`

- Level: `warn`
- Message: `Studio discarded an invalid Edge mail queue message`
- Guidance: `Verify the ZeroPress Edge producer and Studio consumer use contract_version 1 of the same reviewed queue-message contract before sending additional jobs. Keep public Edge writes stopped and drain legacy jobs with their compatible consumer before an incompatible rollout.`
- Expected context: `trigger=queue`, `queue=mail`, attempt,
  `disposition=discard`

## `EDGE_MAIL_QUEUE_PROCESSING_FAILED`

- Level: `error`
- Message: `Studio Edge mail queue message processing failed`
- Guidance: `Inspect the bounded reason or error, verify the Edge database lifecycle, mail provider, DB, EDGE_DB, and queue consumer configuration, then allow the scheduled retry or re-enable delivery after correction.`
- Expected context: `trigger=queue`, `queue=mail`, and
  `disposition=retry`. A batch-level lifecycle preflight includes only bounded
  `reason=edge_database_<state>` and `message_count`; a parsed-message failure
  instead includes bounded message type and attempt.

Queue logs never include message IDs, subscription or submission IDs, tokens,
token hashes, email addresses, sender configuration, subjects, message bodies,
field values, provider response bodies, or encrypted credentials. Invalid jobs
are acknowledged to avoid a poison-message loop, but only after the Edge
database lifecycle is current. A non-current lifecycle is checked before
message parsing and retries the entire batch unchanged. Valid transient failures
retry without a per-message override; the consumer configuration owns the retry
delay and limit and records an exhausted message as a failed Queue deletion.

## `SITE_MEDIA_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Media settings database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying.`
- Expected context: `resource=DB`, `action=read_media_settings`

## `SITE_MEDIA_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio Media settings data is invalid`
- Guidance: `Keep the current D1 backup, inspect the canonical Media Settings rows and revision, and restore known-good values before retrying.`
- Expected context: `resource=DB`, `action=validate_media_settings`

## `SITE_MEDIA_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Media settings update failed`
- Guidance: `Verify D1 availability and the current Studio site_settings table, then reload Media Settings before retrying the update.`
- Expected context: `resource=DB`, `action=update_media_settings`

A stale revision or invalid origin/mode combination is an expected public
rejection and is not logged. Media origins, revisions, and administrator
identity are never recorded.

## `SITE_BRANDING_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Site Branding database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_assets, media, and site_settings tables before retrying.`
- Expected context: `resource=DB`, `action=read_site_branding`

## `SITE_BRANDING_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio Site Branding data is invalid`
- Guidance: `Keep the current D1 backup, inspect the Site Branding revision and selected Media rows, and restore canonical values before retrying.`
- Expected context: `resource=DB`, `action=validate_site_branding`

## `SITE_BRANDING_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Site Branding update failed`
- Guidance: `Verify D1 availability and the current Studio site_assets, media, and site_settings tables, then reload Site Branding before retrying.`
- Expected context: `resource=DB`, `action=update_site_branding`

Missing or incompatible Media and stale revisions are expected public
rejections and are not logged. An empty Media origin is valid and is not an
error condition. Media URLs, internal Media IDs, alternative text, revisions,
and administrator identity are never recorded.

## `CUSTOM_CODE_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio Custom Code database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_custom_code table before retrying.`
- Expected context: `resource=DB`, `action=read_custom_code_settings`

## `CUSTOM_CODE_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio Custom Code data is invalid`
- Guidance: `Keep the current D1 backup, inspect the site_custom_code singleton and revision, and restore canonical values before retrying.`
- Expected context: `resource=DB`, `action=validate_custom_code_settings`

This event identifies a malformed singleton, activation flag, source, revision,
or timestamp. Custom source, revision, and administrator identity are never
included in the log.

## `CUSTOM_CODE_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio Custom Code update failed`
- Guidance: `Verify D1 availability and the current Studio site_custom_code table, then reload Custom Code before retrying the update.`
- Expected context: `resource=DB`, `action=update_custom_code_settings`

A stale revision and an invalid authored request are expected public
rejections and do not create operational logs. Custom source, revisions, and
administrator identity are never recorded.

## `SITE_ROUTING_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio URL and Homepage settings database query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings and pages tables before retrying.`
- Expected context: `resource=DB`, one of
  `action=read_routing_settings`, `action=list_routing_page_options`

## `SITE_ROUTING_SETTINGS_INCOMPLETE`

- Level: `warn`
- Message: `Studio URL and Homepage settings document is incomplete`
- Guidance: `Use the authenticated URL and Homepage recovery action to review missing fields and their defaults. Restore a known-good backup instead if the former URL policy must be preserved.`
- Expected context: `resource=DB`,
  `action=inspect_routing_settings_recovery`, and the bounded list of missing
  setting groups

The URL and Homepage screen returns the exact proposed defaults without
writing. The explicit repair rechecks the revision and missing groups before
atomically replacing the complete document. URL patterns, selected Page IDs,
and revisions are not logged.

## `SITE_ROUTING_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `Studio URL and Homepage settings data is invalid`
- Guidance: `Keep a current D1 backup. Restore a reviewed known-good database backup, or use Reset Studio from Maintenance & Recovery after preserving required data.`
- Expected context: `resource=DB`, one of
  `action=validate_routing_settings`, `action=resolve_preview_front_page`

This event identifies an incorrectly typed, non-canonical, or
revision/timestamp-inconsistent routing document, or a selected Front Page
that can no longer be projected. A merely missing setting group uses the
separate bounded recovery flow. Stored patterns, Page IDs, revisions, and
administrator identity are not included in the log.

## `SITE_ROUTING_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio URL and Homepage settings update failed`
- Guidance: `Verify D1 availability and the current Studio site_settings and pages tables, then reload URLs and Homepage before retrying the update.`
- Expected context: `resource=DB`, `action=update_routing_settings`

A stale revision, malformed request, root route collision, or missing selected
Page is an expected public rejection and is not logged. Setting values,
revisions, Page identities, and administrator identity are never recorded.

## `COMMENT_EDGE_DATABASE_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress comments database binding is not configured`
- Guidance: `If Studio Edge integration is enabled, bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, keep it local in default development modes, and redeploy before using Edge-backed management, Preview Data, Clear Content, or Reset Studio. Otherwise disable Studio Edge integration from Edge Services.`
- Expected context: `component=worker_binding`, `resource=EDGE_DB`,
  `action=resolve_comment_edge_database`

No resource identifier or configuration value is recorded.

## `COMMENT_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `ZeroPress comment settings query failed`
- Guidance: `Verify the EDGE_DB binding, D1 availability, and the current ZeroPress Edge comment schema before retrying.`
- Expected context: `resource=EDGE_DB`, `action=read_comment_settings`

## `COMMENT_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `ZeroPress comment settings are invalid`
- Guidance: `Keep the EDGE_DB backup, inspect edge_comment_settings, its request secret keyset, and its optional Supabase public configuration, then restore canonical values before retrying.`
- Expected context: `resource=EDGE_DB`, one of
  `action=validate_comment_settings`,
  `action=validate_comment_request_secrets`

The keyset, API URL, Supabase project URL, publishable key, and stored row are
never included in metadata.

## `COMMENT_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `ZeroPress comment settings update failed`
- Guidance: `Verify EDGE_DB availability and the current ZeroPress Edge comment schema, then reload Comment Settings before retrying.`
- Expected context: `resource=EDGE_DB`, `action=update_comment_settings`

## `COMMENT_REQUEST_SECURITY_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Comment request security query failed`
- Guidance: `Verify EDGE_DB availability and the current edge_comment_settings table, then reload Comment Request Security before retrying.`
- Expected context: `resource=EDGE_DB`,
  `action=read_comment_request_security`

No request secret, serialized keyset, revision, or key identifier is recorded.

## `COMMENT_REQUEST_SECURITY_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Comment request security update failed`
- Guidance: `Keep the current EDGE_DB backup, reload Comment Request Security, and retry the same rotate or reset action after verifying D1 availability.`
- Expected context: `resource=EDGE_DB`,
  `action=update_comment_request_security`

The mutation uses the opaque keyset revision for concurrency but does not log
that revision or any key material.

## `COMMENT_REQUEST_SECURITY_CRYPTO_FAILED`

- Level: `error`
- Message: `Comment request security cryptography failed`
- Guidance: `Verify that the Worker runtime supports secure random generation and Web Crypto SHA-256, then retry the lifecycle action.`
- Expected context: `component=web_crypto`, one of
  `action=describe_comment_request_security`,
  `action=describe_updated_comment_request_security`,
  `action=rotate_comment_request_security`,
  `action=reset_comment_request_security`

No generated key identifier, secret, serialized keyset, or revision is
recorded.

## `EDGE_SECURITY_DATABASE_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress Edge security database binding is not configured`
- Guidance: `Bind EDGE_DB to the D1 database used by this installation’s ZeroPress Edge Worker, then redeploy before managing public request security.`
- Expected context: `component=worker_binding`, `resource=EDGE_DB`,
  `action=resolve_edge_security_database`

No binding identifier or configuration value is recorded.

## `EDGE_SECURITY_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `ZeroPress Edge public request security query failed`
- Guidance: `Verify EDGE_DB availability and the current edge_runtime_settings table before reloading Edge Security.`
- Expected context: `resource=EDGE_DB`,
  `action=read_edge_security_settings`

## `EDGE_SECURITY_SETTINGS_DATA_INVALID`

- Level: `error`
- Message: `ZeroPress Edge public request security settings are invalid`
- Guidance: `Keep the EDGE_DB backup, apply the reviewed ZeroPress Edge baseline and seed artifacts if needed, and restore a canonical id=1 edge_runtime_settings row before retrying.`
- Expected context: `resource=EDGE_DB`,
  `action=validate_edge_security_settings`, `reason=missing_row|invalid_row|write_verification_failed`,
  and an `invalidFields` list for a malformed row when available

The Turnstile sitekey, verification modes, retention value, stored row, and
revision are never included in operational metadata. The secret key is not a
Studio setting and can never be recorded by this path.

## `EDGE_SECURITY_SETTINGS_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `ZeroPress Edge public request security update failed`
- Guidance: `Verify EDGE_DB availability and the current edge_runtime_settings table, then reload Edge Security before retrying.`
- Expected context: `resource=EDGE_DB`,
  `action=update_edge_security_settings`

## `COMMENT_MANAGEMENT_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `ZeroPress comment management query failed`
- Guidance: `Verify EDGE_DB availability and the current comments and edge_comment_targets tables before reloading Comments.`
- Expected context: `resource=EDGE_DB`, one of
  `action=list_managed_comments`, `action=read_managed_comment`,
  `action=read_comment_mutation_identity`,
  `action=read_comment_bulk_mutation_identities`,
  `action=list_comment_target_options`,
  `action=read_comment_authoring_target`,
  `action=resolve_comment_reply_parent`

Comment IDs, public IDs, author information, search terms and comment content
are not included in operational metadata.

## `COMMENT_TARGET_METADATA_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio comment target metadata query failed`
- Guidance: `Verify the DB binding and current Studio Post and Page tables before reloading Comments.`
- Expected context: `resource=DB`, one of
  `action=read_comment_target_metadata`,
  `action=list_comment_target_options`,
  `action=read_comment_authoring_target`

## `COMMENT_MANAGEMENT_DATA_INVALID`

- Level: `error`
- Message: `ZeroPress comment moderation data is invalid`
- Guidance: `Keep the EDGE_DB and Studio DB backups, inspect the affected comment and target rows, and restore canonical values before moderating comments.`
- Expected context: one of
  `resource=EDGE_DB`, `action=validate_managed_comment`;
  `resource=DB`, `action=validate_comment_target_metadata`

Stored comment content, author identity, network metadata and target identity
are not copied into the log.

## `COMMENT_MANAGEMENT_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `ZeroPress comment management write failed`
- Guidance: `Verify EDGE_DB availability and the current comment schema, then reload Comments before retrying the comment action.`
- Expected context: `resource=EDGE_DB`, one of
  `action=update_managed_comment`,
  `action=permanently_delete_comment_subtree`,
  `action=bulk_moderate_comment_status`,
  `action=bulk_permanently_delete_comment_subtrees`,
  `action=create_studio_comment`

Expected not-found and optimistic-concurrency rejections are not logged.

## `COMMENT_TARGET_SOURCE_DATA_INVALID`

- Level: `error`
- Message: `Studio comment target source data is invalid`
- Guidance: `Keep the DB backup, inspect the affected Post or Page public ID, status, and allow-comments value, then retry target reconciliation from Maintenance & Recovery.`
- Expected context: `resource=DB`,
  `action=validate_comment_target_projection`, `targetType=post|page`

## `COMMENT_TARGET_PROJECTION_WRITE_FAILED`

- Level: `error`
- Message: `ZeroPress comment target projection failed`
- Guidance: `Verify EDGE_DB and edge_comment_targets, preserve queued outbox rows, then use bounded target reconciliation in Maintenance & Recovery. Existing target upserts and deletes are idempotent.`
- Expected context: `resource=EDGE_DB`, one of
  `action=sync_comment_target`, `action=delete_comment_target`,
  `action=sync_comment_targets`; optional
  `targetType=post|page` and
  positive `publicId`

## `COMMENT_TARGET_OUTBOX_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Studio comment-target outbox query failed`
- Guidance: `Verify the DB binding, D1 availability, and edge_comment_target_projection_outbox schema. Preserve queued rows and retry after Studio DB service is restored.`
- Expected context: `resource=DB`, action identifying an outbox count, claim,
  mode, or lease read

## `COMMENT_TARGET_OUTBOX_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Studio comment-target outbox write failed`
- Guidance: `Preserve the Studio DB and queued outbox rows, verify D1 availability and the current Studio schema, then retry the bounded drain after the lease expires. An Edge upsert or delete may already be complete and is safe to repeat.`
- Expected context: `resource=DB`, action identifying an outbox lease, release,
  or acknowledgement write

## `COMMENT_TARGET_OUTBOX_DRAIN_FAILED`

- Level: `error`
- Message: `Studio comment-target projection drain failed`
- Guidance: `Keep Edge integration enabled, verify EDGE_DB and edge_comment_targets, then retry pending projections from Edge Services. Canonical Studio content is already safe in DB.`
- Expected context: `resource=EDGE_DB`, action identifying Edge projection or
  Studio acknowledgement; bounded drain metadata may include aggregate event
  counts or the code-owned batch limit. WXR dependency barriers may identify
  `drain_comment_target_projection_after_wxr_chunk` or
  `drain_comment_target_projection_before_wxr_comments`.

Outbox failures preserve their events for idempotent retry. Target identity,
content titles, and authored content are not logged.

## `COMMENT_REQUEST_TOKEN_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `ZeroPress comment request-token query failed`
- Guidance: `Verify EDGE_DB availability and the current edge_comment_targets and edge_comment_settings tables before regenerating Preview Data.`
- Expected context: `resource=EDGE_DB`,
  `action=read_comment_target_nonces`, `targetCount`

## `COMMENT_TARGET_NOT_PROJECTED`

- Level: `error`
- Message: `A Preview Data comment target is not projected`
- Guidance: `Keep EDGE_MAINTENANCE_MODE=true, set Studio to maintenance mode, run Edge target reconciliation from Maintenance & Recovery, and regenerate Preview Data. Do not publish a payload missing the target-bound token.`
- Expected context: `resource=EDGE_DB`,
  `action=create_comment_request_token`, `targetType=post|page`,
  positive `targetPublicId`

## `COMMENT_REQUEST_SECRETS_NOT_CONFIGURED`

- Level: `error`
- Message: `ZeroPress comment request-token secrets are not configured`
- Guidance: `Open Comment Settings, initialize Comment Request Security, and then regenerate Preview Data.`
- Expected context: `resource=EDGE_DB`,
  `action=create_comment_request_tokens`

The generated or missing secret value is never recorded.

## `COMMENT_REQUEST_TOKEN_CRYPTO_FAILED`

- Level: `error`
- Message: `ZeroPress comment request-token signing failed`
- Guidance: `Verify the Worker runtime supports Web Crypto HMAC-SHA-256 and that the Edge request-token keyset is valid before regenerating Preview Data.`
- Expected context: `component=web_crypto`,
  `action=sign_comment_request_tokens`, `targetCount`

## `PREVIEW_DATA_SETTINGS_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Preview Data settings query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio site_settings table before retrying Preview Data generation.`
- Expected context: `resource=DB`, `action=read_preview_data_settings`

The projected setting values and revisions are not recorded. General or output
documents that are readable but malformed retain their more specific
`SITE_SETTINGS_DATA_INVALID`, `SITE_OUTPUT_SETTINGS_DATA_INVALID`, or
`SITE_ROUTING_SETTINGS_DATA_INVALID` events.

## `PREVIEW_DATA_SUMMARY_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Preview Data summary query failed`
- Guidance: `Verify the DB binding, D1 availability, and the current Studio content tables before retrying the Preview Data summary.`
- Expected context: `resource=DB`, `action=read_preview_data_summary`

The count-only `/publish` entry request does not generate Preview Data or read
stored content bodies.

## `PREVIEW_DATA_SUMMARY_DATA_INVALID`

- Level: `error`
- Message: `Preview Data summary is invalid`
- Guidance: `Inspect the current Studio content tables and count query result before retrying the Preview Data summary.`
- Expected context: `resource=DB`, `action=validate_preview_data_summary`

No count value is returned when the aggregate row does not satisfy the strict
summary response contract.

## `PREVIEW_DATA_PROJECTION_INVALID`

- Level: `error`
- Message: `Preview Data v0.7 projection failed contract validation`
- Guidance: `Inspect firstIssueCode and firstIssuePath in this log, correct the corresponding stored Studio data or projection implementation, and regenerate Preview Data. Do not publish the rejected payload.`
- Expected context: `component=preview-data-validator`,
  `action=validate_preview_data_projection`, `contractVersion=0.7`,
  `issueCount`, optional
  `firstIssueCode`, optional `firstIssuePath`

This is an implementation or stored-data incident. The invalid payload,
setting values, revisions and user identity are never included in the log.

## `DATABASE_BACKUP_EXPORT_FAILED`

- Level: `error`
- Message: `Studio SQL backup generation failed`
- Guidance: `Keep the current site mode, verify the selected D1 binding and availability, then retry. Use Studio logical backup for the Studio DB because native D1 export does not support its virtual tables; review native export only for a separate target without virtual tables.`
- Expected context: `resource=DB|EDGE_DB`,
  `action=export_database_backup`, `database=studio|edge`,
  `mode=structure_and_data|structure_only|data_only`

SQL, row contents, schema text, artifact checksum, and credentials are never
logged. Maintenance-mode export includes the shared canonical initiator
context; recovery-mode token-only export does not.

## `DATABASE_BACKUP_EXPORT_COMPLETED`

- Level: `info`
- Message: `Studio SQL backup generation completed`
- Guidance: `Store the downloaded artifact securely and verify it before making destructive database or deployment changes. R2 objects are not included.`
- Expected context: `resource=DB|EDGE_DB`,
  `action=export_database_backup`, `database=studio|edge`, backup `mode`,
  `table_count`

The event confirms artifact generation, not external storage or a future
restore test. It contains no filename or database contents.

## `DATABASE_UPGRADE_REQUIRED`

- Level: `warn`
- Message: `Studio database schema upgrade is required`
- Guidance: `If administrator access is available, set STUDIO_SITE_MODE to maintenance and redeploy the Worker configuration. If access must be recovered first, use recovery mode and Recover administrator, then switch to maintenance. In Maintenance & Recovery, create and safely store a reviewed Studio DB backup and run Studio database upgrade. Keep maintenance mode enabled until validation succeeds.`
- Expected context: `resource=DB`, `action=inspect_database_status`,
  `schema_version`, `target_schema_version`

This is a persistent operator-action state rather than an attempted upgrade
failure. Status inspection deduplicates the warning within a Worker isolate.
No schema SQL, administrator identity, credentials, or stored content is
logged.

## `DATABASE_UPGRADE_FAILED`

- Level: `error`
- Message: `Studio database schema upgrade failed`
- Guidance: `Keep STUDIO_SITE_MODE in maintenance. The failed step was rolled back and the stored schema version remains the retry boundary; inspect the selected artifact and D1 availability, then retry the same step. Restore the reviewed backup if failure persists.`
- Expected context: `resource=DB`,
  `action=inspect_schema_upgrade|start_schema_upgrade|apply_schema_upgrade_step`, and when known
  `step_id`

Each patch and its lifecycle-version update share one D1 batch. A failure does
not advance the stored version, so the same step is the safe retry boundary.
SQL and administrator credentials are never logged. Start and step failures
include the initiating administrator snapshot when it has been established.

## `DATABASE_UPGRADE_STEP_COMPLETED`

- Level: `info`
- Message: `Studio database schema upgrade step completed`
- Guidance: `Keep STUDIO_SITE_MODE in maintenance and continue with the next reported schema step. Do not enable operational mode until the final completion event and application checks succeed.`
- Expected context: `resource=DB`, `action=upgrade_studio_database`,
  `step_id`, `schema_version`, `target_schema_version`

## `DATABASE_UPGRADE_COMPLETED`

- Level: `info`
- Message: `Studio database schema upgrade completed`
- Guidance: `Confirm the schema is current and review this completion event, then set STUDIO_SITE_MODE to operational. Test sign-in and key Studio flows, keep the pre-upgrade backup until they succeed, and return to maintenance if validation fails.`
- Expected context: `resource=DB`, `action=upgrade_studio_database`,
  `step_id`, `schema_version`, `target_schema_version`

This event confirms the schema upgrade completed. It does not change site mode.

## `DATABASE_RESTORE_FAILED`

- Level: `error`
- Message: `Studio SQL database restore failed`
- Guidance: `Keep STUDIO_SITE_MODE in maintenance or recovery. The failed request was rolled back, but prior restore chunks may remain; inspect the selected binding and restart from the reviewed artifact unless final verification completed.`
- Expected context: `resource=DB|EDGE_DB`,
  `action=restore_database|restore_database_chunk|finalize_database_restore`,
  `database=studio|edge`, and when known restore `mode` or `chunk_index`

This operational event is emitted only after artifact and access preflight
reaches the D1 restore boundary. Expected malformed, mismatched, unsupported,
or over-limit artifacts return stable API errors without an operational log.
SQL and artifact contents are never logged.

## `DATABASE_RESTORE_COMPLETED`

- Level: `info`
- Message: `Studio SQL database restore completed`
- Guidance: `Verify the restored database lifecycle and application behavior before changing STUDIO_SITE_MODE. Restore R2 objects separately when required.`
- Expected context: `resource=DB|EDGE_DB`, `action=restore_database`,
  `database=studio|edge`, restore `mode`, `table_count`, `statement_count`

Completion means all ordered chunks and final schema-object, row-count, and
foreign-key checks succeeded and the restore journal was removed. It does not
imply that site mode changed or that R2 was restored.

## `OPERATIONS_CONFIGURATION_INVALID`

- Level: `error`
- Message: `Maintenance and Recovery configuration is invalid`
- Guidance: `Configure a comma-separated exact-IP allowlist in STUDIO_OPERATIONS_ALLOWED_IPS and create a STUDIO_OPERATIONS_TOKEN secret containing 32–256 printable ASCII characters without spaces. Remove the allowlist variable to disable Maintenance and Recovery.`
- Expected context: `component=worker_configuration`,
  `action=resolve_operations_access`,
  `reason=allowed_ips_empty|allowed_ip_invalid|token_missing|token_too_short|token_invalid`

Secret values and the rejected configuration value are never recorded.

## `OPERATIONS_AUTH_RATE_LIMITER_NOT_AVAILABLE`

- Level: `error`
- Message: `Maintenance and Recovery authentication rate limiter is unavailable`
- Guidance: `Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status before retrying Operations authentication.`
- Expected context: `resource=AUTH_ROUTE_RATE_LIMITER`,
  `action=limit_operations_authentication_attempt`

## `OPERATIONS_TOKEN_VERIFICATION_NOT_AVAILABLE`

- Level: `error`
- Message: `Maintenance and Recovery token verification is unavailable`
- Guidance: `Verify the deployed Worker runtime supports Web Crypto SHA-256, then redeploy before retrying the operation.`
- Expected context: `component=web_crypto`,
  `action=verify_operations_token`

The operations token and its digest are never recorded.

## `OPERATIONS_ADMIN_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Maintenance administrator authorization query failed`
- Guidance: `Verify the DB binding targets an installed Studio database and that the users, roles, and user_roles schema is available.`
- Expected context: `resource=DB`,
  `action=authorize_operations_administrator`

No administrator email, ID, password, or password hash is recorded.

## `ADMINISTRATOR_RECOVERY_DATABASE_QUERY_FAILED`

- Level: `error`
- Message: `Administrator recovery database query failed`
- Guidance: `Keep STUDIO_SITE_MODE in recovery and verify the DB binding, users, roles, user_roles, and MFA tables before retrying.`
- Expected context: `resource=DB`,
  `action=list_recoverable_administrators|inspect_recovery_administrator_bootstrap`

## `ADMINISTRATOR_RECOVERY_PASSWORD_HASHING_FAILED`

- Level: `error`
- Message: `Recovered administrator password hashing failed`
- Guidance: `Confirm the deployed Worker includes the Argon2id WASM assets, then retry administrator recovery.`
- Expected context: `component=argon2id`,
  `action=hash_recovered_administrator_password|hash_bootstrap_recovery_administrator_password`

## `ADMINISTRATOR_RECOVERY_DATABASE_WRITE_FAILED`

- Level: `error`
- Message: `Administrator recovery database write failed`
- Guidance: `Keep STUDIO_SITE_MODE in recovery, inspect D1 availability, and restore the backup if administrator credentials or MFA state are uncertain.`
- Expected context: `resource=DB`,
  `action=recover_administrator_access|bootstrap_recovery_administrator`

## `ADMINISTRATOR_RECOVERY_COMPLETED`

- Level: `info`
- Message: `Administrator access recovery completed`
- Guidance: `Set STUDIO_SITE_MODE to operational and verify mandatory MFA sign-in. Return to recovery if another correction is needed; after success, rotate the operations token.`
- Expected context: `resource=DB`,
  either `action=recover_administrator`, `mfa_reset=<boolean>` or
  `action=bootstrap_recovery_administrator`,
  `created_user_id=<opaque user id>`, `administrator_count_before=0`,
  `mfa_enrolled=true`

No initiator identity or credential is recorded because administrator recovery
is authorized only by the out-of-band operations boundary. The selected
recovery target is not an initiator.

## `MAINTENANCE_OPERATION_STARTED`

- Level: `info`
- Message: `Studio maintenance operation started`
- Guidance: `Keep the relevant resource backup until a matching completion event is recorded and the resulting Studio state is verified.`
- Expected context: `resource=DB|EDGE_DB`,
  `action=clear_site_content|reset_studio|uninstall_studio|recover_administrator|bootstrap_recovery_administrator|restore_database|upgrade_studio_database`;
  `related_resource=EDGE_DB` for Clear and Reset only when Studio Edge
  integration is enabled; `database` and `mode` for restore;
  `from_schema_version`, `target_schema_version`, and `step_count` for upgrade

This external Worker event is intentionally emitted after all authorization
checks but before the destructive D1 batch. It remains available when an
uninstall removes every database-resident Studio record. Authenticated actions
include the shared canonical initiator context; token-only recovery actions do
not.

## `EDGE_INTEGRATION_MODE_CHANGED`

- Level: `info`
- Message: `Studio Edge integration mode changed`
- Guidance: `Verify the effective Edge Services state before exporting Preview Data or resuming public Edge writes.`
- Expected context: `resource=DB`,
  `action=enable_edge_integration|disable_edge_integration`,
  `mode=enabled|disabled`, and the resulting low-cardinality `effective_state`

The event includes the canonical initiator context but no credentials,
confirmation text, target identity, or Edge row content. Disabling never
inspects Edge; enabling has already passed the normal strict health boundary
before this event is emitted.

## `MAINTENANCE_EDGE_COMMENT_LIFECYCLE_FAILED`

- Level: `error`
- Message: `Maintenance Edge comment lifecycle operation failed`
- Guidance: `Keep the DB and EDGE_DB backups, keep the current site mode, and retry the same maintenance action. The Edge phase is idempotent; if verification fails repeatedly, inspect comments, edge_comment_targets, and edge_comment_settings before restoring data.`
- Expected context: `resource=EDGE_DB`,
  `action=clear_edge_comment_content|reset_edge_comment_runtime`,
  `phase=mutation|verification`

The Edge batch either clears every comment target, or clears targets and
restores only the Studio-owned comment presentation fields. It does not record
comment or target identities, row content, request secrets, or authentication
configuration. Repeating the same phase after an uncertain response is safe.

## `MAINTENANCE_EDGE_NEWSLETTER_LIFECYCLE_FAILED`

- Level: `error`
- Message: `Maintenance Edge Newsletter lifecycle operation failed`
- Guidance: `Keep the DB and EDGE_DB backups and keep the current site mode. Retry the same maintenance action; if verification fails repeatedly, inspect the Edge Newsletter tables and edge_mail_settings before restoring data.`
- Expected context: `resource=EDGE_DB`,
  `action=clear_edge_newsletter_content|reset_edge_newsletter_runtime`,
  `phase=mutation|verification`

Clear Content removes subscriber, subscription, and submitted field-value rows
while preserving list definitions, signup fields, suppressions, and runtime
configuration. Reset additionally removes all list configuration and
suppressions, creates one canonical `default` list, and disables Newsletter
confirmation without changing Form notification delivery. Neither event logs
email addresses, list IDs, field values, tokens, or suppression content.

## `MAINTENANCE_EDGE_FORM_LIFECYCLE_FAILED`

- Level: `error`
- Message: `Maintenance Edge Form lifecycle operation failed`
- Guidance: `Keep the DB and EDGE_DB backups and keep the current site mode. Retry the same maintenance action; if verification fails repeatedly, inspect forms, form_fields, form_submissions, and form_submission_values before restoring data.`
- Expected context: `resource=EDGE_DB`,
  `action=clear_edge_form_content|reset_edge_form_runtime`,
  `phase=mutation|verification`

Clear Content removes Form submissions and their value snapshots while
preserving Form and field definitions and notification recipient choices. Reset
removes every Form definition, field, submission, and value. No
default Form is created. Neither event logs Form IDs, recipients, submitters,
field values, source URLs, or request metadata.

## `CLEAR_SITE_CONTENT_FAILED`

- Level: `error`
- Message: `Studio site content clearing failed`
- Guidance: `Keep Studio in its current site mode, inspect the DB status and schema, and retry the same action. If completed_resource=EDGE_DB is present, Edge comment, Form, and Newsletter content phases already completed and are safe to repeat.`
- Expected context: `resource=DB`, `action=clear_site_content`, optional
  `completed_resource=EDGE_DB`

## `CLEAR_SITE_CONTENT_COMPLETED`

- Level: `info`
- Message: `Studio site content clearing completed`
- Guidance: `Verify the empty content state before starting a new import or publishing workflow.`
- Expected context: `resource=DB`, `action=clear_site_content`,
  `related_resource=EDGE_DB` only when Studio Edge integration is enabled,
  `affected_table_count=<number>`,
  `effects={deleted_rows,inserted_rows,updated_rows}`. Each effects map reports
  direct row counts by operator-relevant table; internal projection-outbox rows
  are intentionally omitted.

## `STUDIO_RESET_FAILED`

- Level: `error`
- Message: `Studio reset failed`
- Guidance: `Keep STUDIO_SITE_MODE in maintenance, inspect the DB status and schema, and retry the same action. If completed_resource=EDGE_DB is present, the Edge comment, Form, and Newsletter resets already completed and are safe to repeat.`
- Expected context: `resource=DB`, `action=reset_studio`, optional
  `completed_resource=EDGE_DB`

## `STUDIO_RESET_COMPLETED`

- Level: `info`
- Message: `Studio reset completed`
- Guidance: `Set STUDIO_SITE_MODE to operational and verify the preserved administrator can complete MFA sign-in. Return to maintenance if validation fails.`
- Expected context: `resource=DB`, `action=reset_studio`,
  `related_resource=EDGE_DB` only when Studio Edge integration is enabled,
  `affected_table_count=<number>`,
  `effects={deleted_rows,inserted_rows,updated_rows}`. Each effects map reports
  direct row counts by operator-relevant table; internal projection-outbox rows
  are intentionally omitted.

## `STUDIO_UNINSTALL_PREVIEW_FAILED`

- Level: `error`
- Message: `Studio uninstall preview failed`
- Guidance: `Keep STUDIO_SITE_MODE in maintenance, verify the DB binding and exact Studio-owned table set, then retry the preview before uninstalling.`
- Expected context: `resource=DB`, `action=preview_uninstall_studio`

## `STUDIO_UNINSTALL_FAILED`

- Level: `error`
- Message: `Studio uninstall failed`
- Guidance: `Keep STUDIO_SITE_MODE in maintenance, inspect system status, and restore the database backup before retrying. Do not run the install flow over an unexpected partial schema.`
- Expected context: `resource=DB`, `action=uninstall_studio`

## `STUDIO_UNINSTALL_COMPLETED`

- Level: `info`
- Message: `Studio uninstall completed`
- Guidance: `To reinstall, set STUDIO_SITE_MODE to initial, configure STUDIO_INSTALL_TOKEN, redeploy the Worker configuration, and open the installer.`
- Expected context: `resource=DB`, `action=uninstall_studio`,
  `affected_table_count=<number>`,
  `effects={deleted_rows,inserted_rows,updated_rows}`. Each effects map reports
  direct row counts by operator-relevant table; internal projection-outbox rows
  are intentionally omitted.

## `EDGE_DATABASE_UNINSTALL_PREVIEW_FAILED`

- Level: `error`
- Message: `Edge database uninstall preview failed`
- Guidance: `Keep STUDIO_SITE_MODE=maintenance and EDGE_MAINTENANCE_MODE=true. Verify the EDGE_DB binding, managed lifecycle state, and reviewed Edge backup before retrying.`
- Expected context: `resource=EDGE_DB`,
  `action=preview_uninstall_edge_database`

Expected rejections such as enabled Studio integration, a non-ready Edge
schema, missing acknowledgements, invalid credentials, or stale state are API
responses and do not emit this operational failure.

## `EDGE_DATABASE_UNINSTALL_FAILED`

- Level: `error`
- Message: `Edge database uninstall failed`
- Guidance: `Keep STUDIO_SITE_MODE=maintenance and EDGE_MAINTENANCE_MODE=true. Preserve the Edge backup, inspect the lifecycle state, and do not install over an unexpected partial schema.`
- Expected context: `resource=EDGE_DB`,
  `action=uninstall_edge_database`

## `EDGE_DATABASE_UNINSTALL_COMPLETED`

- Level: `info`
- Message: `Edge database uninstall completed`
- Guidance: `Keep Studio Edge integration disabled. The D1 resource, bindings, KV entries, and external queue remain outside this schema operation; use the normal Edge install flow if the service is needed again.`
- Expected context: `resource=EDGE_DB`,
  `action=uninstall_edge_database`, `removed_table_count=<number>`

Only the aggregate removed-table count is logged. The UI response—not the
operational log—contains the copyable table-by-table pre-drop row-count report.

## `UNHANDLED_STUDIO_API_ERROR`

- Level: `error`
- Message: `Unhandled Studio API error`
- Guidance: omitted because the error is not classified
- Expected context: request method and pathname

This fallback identifies a code defect or an operational boundary that has not
yet been classified.
