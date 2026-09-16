# Studio operational logging policy

ZeroPress Studio records operator-facing Worker diagnostics as structured
JSON. These logs diagnose service and configuration failures; they are not a
localized client response contract.

Individual codes, messages, guidance, and metadata are described in the
[operational log catalog](./operational-log-catalog.md).

## Envelope

The shared logger writes one object with a human-readable top-level `message`
and application-owned metadata under `$zeropress`.

```json
{
  "message": "Concise static diagnosis",
  "$zeropress": {
    "code": "STABLE_OPERATIONAL_CODE",
    "resource": "RESOURCE_NAME",
    "action": "stable_action_name",
    "errorType": "Error",
    "guidance": "Concrete operator recovery action."
  }
}
```

Cloudflare may enrich a deployed log with `$workers` and `$metadata`. Those
platform fields do not replace the portable `$zeropress` contract.

## Fields

| Field | Requirement | Contract |
| --- | --- | --- |
| `message` | Required | Static English diagnosis identifying the failed component or operation, without dynamic values. |
| `$zeropress.code` | Required for cataloged operational events | Stable, uppercase `SNAKE_CASE` identifier used for filtering, alerting, and documentation. |
| `$zeropress.guidance` | Optional | Concrete operator action. Omitted when the cause is not known well enough to recommend a safe action. |
| `$zeropress.resource` | Optional | Bound or external resource involved in the failure, such as `DB`, `KV`, or `AUTH_ROUTE_RATE_LIMITER`. |
| `$zeropress.component` | Optional | Internal runtime component involved in the failure, such as `argon2id`. |
| `$zeropress.action` | Optional | Stable low-cardinality operation name. |
| `$zeropress.reason` | Optional | Stable low-cardinality subtype when the implementation can classify it without parsing attacker-controlled input. |
| `$zeropress.errorType` | Optional | Fixed classification: `Error`, `TypeError`, `RangeError`, `SyntaxError`, or `NonError`. Exception text, custom names, stacks and nested causes are never serialized. |
| `$zeropress.method` / `$zeropress.pathname` | Request failures | Request location retained for portable local and remote diagnostics. |
| `$zeropress.initiated_by_user_id` | Authenticated Maintenance & Recovery mutations | Canonical Studio user ID returned by successful administrator re-verification. Omitted for token-only recovery flows and failed authentication. |
| `$zeropress.initiated_by_user_email` | Authenticated Maintenance & Recovery mutations | Canonical email read from the same D1 administrator row, rather than request input. It is operator-visible personal information. |

## Operational code versus API code

An API may return a generic `INTERNAL_ERROR` to avoid exposing infrastructure
details, while the server log records a specific operational code for diagnosis.

## Levels

- `error`: the requested operation or required service is unavailable.
- `warn`: Studio continued in a deliberate degraded state or operator action
  is advisable.
- `info`: a meaningful lifecycle or administrative transition completed.

Expected client rejections such as invalid credentials, validation errors, and
rate-limit denials are not operational failures and are not logged. This avoids
PII exposure and public log amplification.

Public system-status polling can repeatedly observe the same configuration or
database incident. Lifecycle diagnostics are therefore emitted once per
incident fingerprint within a Worker isolate. A healthy observation or a
different incident clears or replaces that fingerprint, allowing a later
recurrence to be recorded without logging every poll.

## Privacy and attribution

Operational logs exclude passwords, install tokens, authorization or session
values, raw secrets, request bodies, and unverified claims.

Administrator-attributed maintenance events include both
`initiated_by_user_id` and `initiated_by_user_email`, or neither. Their retention
follows the configured logging platform. Rejected credentials and token-only
recovery operations omit both fields.

For a multi-request operation, these fields identify the administrator who
started it, even if another person submits a continuation request.

Durable outbox failures are summarized once per drain attempt using stable
trigger/action names and aggregate counts. Target identities, titles, authored
content, event IDs, lease IDs, and serialized payloads are excluded.

Edge lifecycle, reconciliation, integration-mode, and uninstall logs include
schema versions, phase/action names, effective mode, aggregate table/count
information, and an opaque operation ID for resuming an operation. They exclude
target public IDs, titles, comments, row contents, orphan snapshots,
administrator credentials, confirmation input, and artifact contents. The
canonical `initiated_by_*` fields identify the administrator for authenticated
operations.
