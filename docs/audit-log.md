# Audit Log

Administrators can open **Audit Log** beside Users to see who performed a major
operation, when it happened, its target, and the result. Filter by date, actor,
category, or result. A record's details include its connection information and
an option to find other records with the same IP hash. Deleted accounts remain
searchable by their recorded name and email.

## Recorded activity

- Successful sign-in, sign-out, and sensitive-action reauthentication.
- Invitations, account activation, recovery and deletion, role and status
  changes, password and MFA changes, and explicit session revocation.
- Post and Page publication-state changes, trash, restore and permanent
  deletion, and Media deletion. Bulk actions produce a summary per request.
- GitHub publishing outcomes, settings saves and credential changes.
- WXR chunk results and final settings application. A chunk record does not
  mean the entire import finished.
- Database upgrades, backups and restores, administrator recovery, content
  clearing, Studio resets, Edge operations and search-index rebuilds.

Routine editing, autosaves, reads, connection tests, rejected authentication,
scheduled maintenance, and individual comment, form and newsletter actions
are excluded. Passwords, tokens, content bodies and external response bodies
are never included. Settings records contain field names and credential-change
indicators, not their values.

## Retention and availability

Records are retained for **365 days**. Original IP addresses are retained for
**30 days**. Their keyed hashes, User-Agent, available location and network
information remain with the record. Location and ASN come from Cloudflare;
Studio does not contact a location service. Missing information is shown as
unavailable. Changing `STUDIO_AUTH_SECRET` changes subsequent IP hashes.

Expired information is hidden during reads even if scheduled cleanup is delayed.
Clear Content and Reset Studio preserve the records. SQL backups include them;
restoring a Studio backup returns the history to that backup's point in time.
Studio pauses new audit writes during that restore and records its completion
after verification, so new records cannot interfere with the restored data.
Uninstall removes the records; its completion remains in Worker operational logs.

Recording runs in the background. A storage or hashing failure does not stop the
original operation, so records can be missing. This is an administrative history,
not a tamper-proof ledger: database owners can modify it and restores rewind it.
For multi-request work, including Dashboard search-index rebuilds, the initial
actor is separate from the caller and connection that executed each step.
Token-only callers appear as **Operations token**.

Existing installations use the Operations database upgrade before opening the
new screen. Earlier activity is not added retroactively.
