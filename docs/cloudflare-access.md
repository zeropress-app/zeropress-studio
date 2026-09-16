# Optional Cloudflare Access enforcement

Cloudflare Access is an optional infrastructure gate in front of Studio. Studio
authentication remains a separate second account boundary: enabling Access
does not create a Studio session, map an Access identity to a Studio role, or
replace password and MFA verification.

Studio can additionally require proof that each normal application request
passed through one reviewed Access application. This closes the fail-open case
where an operator intends to protect Studio with Access but an alternate route
or later policy mistake lets a request reach the Worker without Access.

## Configuration model

No Worker environment variable, service token, or Cloudflare API token is used
for this feature. In particular, do not add `CLOUDFLARE_API_TOKEN`, a team
domain, or an Access audience to Worker configuration.

The administrator configures the Access application and policy in Cloudflare,
then visits Studio through the protected HTTPS origin, signs in to Studio, and
unlocks Operations with the configured exact-IP and Operations-token boundary.
Only the token-unlocked Operations dashboard exposes the **Studio access**
page at `/system/operations/access`. It verifies the current
`Cf-Access-Jwt-Assertion` against the issuer's JWKS endpoint. Only after that
cryptographic verification may the administrator enable Studio enforcement.
Studio derives and stores the exact issuer, audience, and current HTTPS origin;
there are no editable identity fields or automatic Cloudflare configuration
writes.

The revisioned document uses two existing `studio_settings` rows:

- `cloudflare_access_requirement`
- `cloudflare_access_revision`

A fresh installation seeds the canonical `disabled` document. If both rows
are absent, enforcement is disabled. A partial, malformed, or internally
inconsistent document blocks normal application access until it is repaired
through Recovery.

## Worker enforcement

When the stored mode is `required`, Studio verifies all of the following:

- a bounded `Cf-Access-Jwt-Assertion` is present;
- the JWT uses `RS256`, has a key ID, and has Access application type `app`;
- the signature matches the constrained team JWKS endpoint;
- issuer, single audience, expiration, issued-at, and not-before claims are
  valid;
- issuer and audience exactly match the stored values;
- the request origin exactly matches the HTTPS origin captured at enable time.

Missing, expired, malformed, wrong-origin, wrong-issuer, wrong-audience, and
invalid-signature assertions return `403 CLOUDFLARE_ACCESS_REQUIRED`. A settings
read failure or a JWKS availability failure returns
`503 CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE`; it never falls back to normal
Studio authentication alone.

The gate covers normal `/api/*` requests and protected Studio-managed Media
delivery. These bootstrap and out-of-band control-plane paths are deliberately
excluded from the Studio-side requirement:

- `/api/system/status`
- `/api/system/install` and its child paths
- `/api/system/operations` and its child paths
- every request while `STUDIO_SITE_MODE` is `initial` or `recovery`

The exclusions do not bypass an Access application configured at Cloudflare.
Cloudflare may still reject the request before it reaches the Worker.
The operational Cloudflare Access settings endpoint is a deliberate child of
the Operations API exception, so it independently requires the Operations IP,
token, and administrator-session boundaries. When the stored requirement is
already enabled, that endpoint also re-verifies the current Access assertion;
the Operations prefix cannot be used to disable the requirement without Access
proof. The explicit recovery-mode disable workflow below remains the only
token-only repair exception.

Studio does not revalidate static asset requests in Worker code. Cloudflare
Access remains responsible for protecting the HTML and asset delivery route;
the Studio gate is a defense-in-depth check at stateful application boundaries,
not a replacement reverse proxy.

## Browser behavior

All same-origin Studio API clients use the common `studioFetch` transport. It
sends same-origin credentials and `X-Requested-With: XMLHttpRequest`, allowing
an outer Access layer to return a machine-readable `401` instead of an HTML
sign-in page when its session expires. The transport distinguishes that outer
response from Studio's JSON authentication errors.

If the interruption happens while the authenticated application is mounted,
Studio keeps the current route and unsaved client state mounted behind a
blocking prompt. Continuing reloads the page so Cloudflare Access can perform
its own authentication flow. Studio does not attempt to refresh, mint, inspect,
or store an Access cookie.

## Recovery and origin changes

If a required document is damaged, its JWKS is unavailable, Access is removed,
or Studio moves to a different origin, use this sequence:

1. Preserve a current Studio D1 backup.
2. Set `STUDIO_SITE_MODE=recovery` and open the independently protected
   Maintenance & Recovery surface.
3. Authenticate with the Operations IP and token boundary.
4. Run **Disable Cloudflare Access requirement** and type the exact
   `DISABLE CLOUDFLARE ACCESS` confirmation.
5. Return to operational mode only after checking that the intended outer
   Access application or alternate infrastructure boundary is correct.
6. To require Access again, visit the final protected HTTPS origin, sign in to
   Studio as an administrator, unlock Operations with its token, and enable it
   from **Studio access** at `/system/operations/access` so the current verified values
   are captured.

This recovery action overwrites only the two Studio settings rows with one
canonical disabled document. It does not change Cloudflare Access applications,
policies, sessions, DNS, or Worker routes. If the Cloudflare-side policy itself
prevents access to `/system/operations`, correct that infrastructure policy
before the Worker recovery route can be reached.

Logical Studio backup includes the revisioned settings document. Restoring a
backup to another hostname can therefore restore an old bound origin and fail
closed. Use the same Recovery action, then re-enable from the new protected
origin. Assertions, Access cookies, JWTs, identities, issuer values, audiences,
and bound origins are not written to operational logs.
