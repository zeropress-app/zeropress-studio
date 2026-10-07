# Passkeys and FIDO metadata

Passkeys and security keys are optional authentication methods alongside the
required authenticator app. **My Account → Account security → Passkeys** shows
each credential's hostname, authenticator model, FIDO certification, and the
attestation result recorded at registration.

These are separate facts. An AAGUID identifies a claimed model; a name or a
certified model in the FIDO Metadata Service (MDS) does not prove that a
particular registration came from that model. **Available here** means the
credential's RP ID matches the current Studio hostname.

Administrators can enable **Only allow authenticators with verified FIDO
certification** under **Site Settings → Studio security**. It is off by default.
When enabled, new registrations from every user require FIDO certification
(legacy FIDO Certified or L1 and above), verified model attestation, and no
applicable unresolved security report. The policy can exclude platform
passkeys that supply no attestation or only self-attestation, including
Windows Hello registrations. It does not enforce hardware-only keys.

Changing this policy requires account reauthentication. Existing passkeys
continue to sign in, authorize protected actions, and be removed. Credentials
registered before verification records were introduced show **No verification
record**; model metadata never retroactively verifies a registration.

## Included metadata

Studio bundles a verified [FIDO MDS](https://fidoalliance.org/metadata/) snapshot.
For authenticators not listed in MDS, Studio uses authenticator and passkey
provider names from
[`aaguid.json`](https://github.com/passkeydeveloper/passkey-authenticator-aaguids/blob/main/aaguid.json).
Supplemental names confer no certification or trust. Unlisted models have
**No certification information**. Key protection is shown only when MDS
explicitly describes it; backup state and transport do not identify hardware.

For missing names, see the upstream project's
[contribution guide](https://github.com/passkeydeveloper/passkey-authenticator-aaguids#contributing).
It asks passkey providers to submit their AAGUIDs through pull requests; users
can ask their provider to contribute an entry. Accepted additions and
corrections appear in Studio once included in a metadata update and a Studio
release, rather than immediately after the upstream change.

Metadata is fixed for a Studio release. Its displayed reference date determines
which MDS reports apply, and passing `nextUpdate` does not change registration
behavior or trigger a warning. New or recently changed models may not be
represented until Studio is updated. Registration signatures, challenge,
origin, user verification, and certificate validity/revocation checks still
apply; expired or revoked certificates can prevent a new registration.

Neither the Worker, browser, nor normal build downloads MDS. The explicit
`npm run update:passkey-metadata` command caches signed input and pinned
supplemental names in the ignored `.cache/fido-mds/` directory and generates
the bundled metadata. During the download wait period, it reuses and verifies
cached MDS; once requests are allowed, it checks for an MDS update. Its output
distinguishes an MDS update check from cache reuse. Certificate revocation
checks may retrieve public certificate-status data even when MDS is cached.
Source digests, MDS serial, fixed reference date, and supplemental commit are
included in the generated metadata. The browser receives no certificates,
icons, or original MDS BLOB.

Generated trust-anchor lists are ordered by SHA-256 of certificate DER bytes,
so upstream reordering alone does not change those lists. Signed source BLOBs
and attestation certificate chains retain their original order.

MDS downloads are limited to once per hour, including conditional update
attempts. The update command respects the local wait period and `Retry-After`,
performs no automatic retry after HTTP 429, and preserves generated data on
failure. Without a cached MDS, it reports when another request is allowed.
Actual request or verification failures stop the command with an error.
A 304 response reuses the cached MDS. Supplemental names are checked
independently, including during the MDS wait period and after a 304 response;
the command regenerates metadata using the selected inputs. See the
[FIDO MDS change log](https://fidoalliance.org/mds-changelog/).

If supplemental-name retrieval fails after MDS was downloaded, rerunning the
update command resumes from the cached MDS without downloading it again.

The policy and registration verification records are included in Studio SQL
backups and excluded from Preview Data. Restoring a backup also restores the
policy and recorded results from that backup; its referenced snapshot can
differ from the release currently running.
