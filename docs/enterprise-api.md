# BioGuard Enterprise Screen API — contract v1 (draft for backend implementation)

The VS Code extension (`src/bio/bioguard.ts → screenEnterprise`) is already
coded against this contract. Implement it server-side to light up Enterprise mode.

## `POST {base}/api/v1/screen`

Auth: `Authorization: Bearer <JWT>` (OAuth2, `screen:write` scope).

Request (JSON):

```json
{
  "length": 136,
  "sha256": "9f2c…",
  "sequence": "ATGCGATCGA…"
}
```

| Field | Type | Notes |
|---|---|---|
| `length` | int | Full candidate length (sequence may be truncated server-side policy) |
| `sha256` | string | Hex SHA-256 of the full candidate (cache key) |
| `sequence` | string | ACGTN, client sends up to the first 50 000 nt |

Response (JSON):

```json
{
  "verdict": "APPROVED",
  "dbVersion": "enterprise-2026-10-07",
  "matches": [
    {
      "entry": {
        "pattern": "GATTACAGATTACA",
        "name": "THREAT-001",
        "regulation": "IIGS",
        "severity": "FLAGGED_FOR_REVIEW",
        "description": "…"
      },
      "position": 42,
      "strand": 1,
      "matchedKmer": "GATTACAGATTACA"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `verdict` | enum | `APPROVED` \| `FLAGGED_FOR_REVIEW` \| `REJECTED` |
| `dbVersion` | string | Threat-feed version (surfaced in certificates & audit log) |
| `matches[].position` | int | 0-based index into the **sent** `sequence` string |
| `matches[].strand` | int | `1` or `-1` |

## Client fallback policy

Any network error, non-2xx status, timeout (>8 s) or malformed body →
silently keep the **local** verdict and mark the screening `mode: enterprise`
for traceability. The extension never blocks the editor on the cloud call.

## Privacy

Enterprise mode transmits sequence prefixes to the configured `base` URL.
On-prem deployments should pin `biolint.enterpriseUrl` to the tenant host.
