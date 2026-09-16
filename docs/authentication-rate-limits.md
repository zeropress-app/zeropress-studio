# Authentication rate limits

Studio uses the existing Cloudflare native IP limiter before authentication
work, then uses Studio D1 for authoritative fixed-window attempt budgets:

| Budget | Maximum | Shared identity |
| --- | --- | --- |
| Password sign-in | 5 attempts per 2 minutes | Lowercase, trimmed email, including unknown accounts |
| Sign-in IP | 20 attempts per 15 minutes | Password sign-in and passwordless Passkey options |
| Enrolled TOTP verification | 10 attempts per 5 minutes | User ID across sign-in and protected account changes |

A window starts with the first reservation. Each D1 UPSERT returns its own
updated count; password sign-in reserves both budgets in one atomic batch.
Both budgets are consumed even when one rejects the request. Counters saturate
at the limit plus one. Denied requests never extend the window. At expiry the
next request starts a new window, independently of garbage collection.

An attempt is reserved before password or TOTP verification. Successful,
incorrect, and replayed TOTP codes each consume one attempt. Success, a fresh
continuation token, a different IP, an authentication revision change, and
ordinary credential recovery do not clear the TOTP budget. Invalid request
bodies, invalid/expired continuations, and invalid user/revision pairs do not
consume that account's TOTP budget. New-factor enrollment confirmation is not
an attempt against an existing enrolled factor.

Rate-limited requests return `429 RATE_LIMIT_EXCEEDED` with `Retry-After` and
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. If both
password budgets deny, the response uses the later reset. The TOTP limit does
not set `users.locked_until` or block an independently permitted Passkey login.
After waiting, restart password sign-in if the continuation token has expired.
The existing TOTP time-step and single-use checks still apply.

Counters store scope-separated HMAC-SHA-256 subject digests under the stable
`STUDIO_AUTH_SECRET`, never raw emails or IP addresses. D1 errors or malformed
counter results stop authentication and return `503 SYSTEM_NOT_AVAILABLE`.
They log `AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE` once through the normal error
handler with DB/action context; expected denials are not operational errors.

Backups include authentication counters with their absolute expiry times.
The daily collector deletes expired rows only while the database is ready and
site mode is operational. For deletion and preservation rules, see
[Clear site content](maintenance-and-recovery.md#clear-site-content) and
[Reset Studio](maintenance-and-recovery.md#reset-studio).
