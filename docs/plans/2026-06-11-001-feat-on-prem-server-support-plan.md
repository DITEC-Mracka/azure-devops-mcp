---
title: "feat: On-Prem Azure DevOps Server Support (Milestone 1)"
type: feat
date: 2026-06-11
origin: docs/brainstorms/2026-06-10-on-prem-server-support-requirements.md
---

# feat: On-Prem Azure DevOps Server Support (Milestone 1)

## Summary

Enable the MCP server to connect to Azure DevOps Server (on-premise) by accepting a collection URL in the existing `organization` positional arg. Detection is URL-based: if it starts with `http(s)://` and the hostname isn't `dev.azure.com` / `*.visualstudio.com`, it's on-prem mode. PAT auth works unchanged. Ships with `--allow-untrusted-cert` and `--allow-http` flags for enterprise environments. A fail-fast startup connection check validates connectivity before any tool call.

## Problem Frame

The MCP server currently only works with Azure DevOps Services (cloud). Enterprise users on Azure DevOps Server (on-premise) cannot use it at all — the org name is always interpolated into `https://dev.azure.com/{org}`, the `getOrgTenant()` call crashes with non-cloud orgs, and search tools use hardcoded cloud-only hostnames.

## Requirements

- **R1.** The positional `organization` arg accepts a full collection URL (e.g., `https://dev-tfs/tfs/internal_projects`)
- **R2.** URL detection: `http://` or `https://` prefix → check hostname; cloud hosts stay cloud mode, others → on-prem
- **R3.** On-prem mode skips `getOrgTenant()` entirely (it throws on non-cloud URLs)
- **R4.** Search tools use `connection.serverUrl`-based URLs instead of hardcoded `almsearch.dev.azure.com`
- **R5.** Identity API uses `connection.serverUrl` instead of hardcoded `vssps.dev.azure.com`
- **R6.** `--allow-untrusted-cert` flag sets `NODE_TLS_REJECT_UNAUTHORIZED=0` with a stderr warning
- **R7.** `--allow-http` flag permits `http://` URLs with a stderr warning (especially when PAT auth is active)
- **R8.** On-prem mode performs a startup connection check (`_apis/connectionData`) and exits on failure
- **R9.** Cloud mode remains fully backward-compatible — zero behavior change for existing users

## Key Technical Decisions

- **Substitute-in-Place (Approach A):** Reuse the `organization` positional arg for both org name and URL. No new flags, no abstraction layer. Rationale: `azure-devops-node-api`'s `WebApi` natively accepts collection URLs, so most tools work without changes. ~35 lines across 3 core files (see origin: `docs/brainstorms/2026-06-10-on-prem-server-support-requirements.md`).
- **Cloud host detection (not just URL detection):** After detecting a URL, check hostname against known cloud hosts (`dev.azure.com`, `*.visualstudio.com`). This handles the case where someone passes a full cloud URL instead of just an org name — it still routes to cloud mode correctly.
- **Search URL pattern:** On-prem Azure DevOps Server serves search at `{collectionUrl}/_apis/search/...` (no separate `almsearch` subdomain). Use `connection.serverUrl` as the base for all search API calls.
- **Export `orgUrl` instead of `orgName`:** The `orgName` export from `index.ts` is currently imported only by `search.ts`. Since `orgName` may now be a URL, the export should become `orgUrl` (the resolved base URL) — search.ts then uses it directly. However, the cleaner pattern is to pass `connectionProvider` through and derive the URL there (already available in the handler signature).
- **Startup check is on-prem only:** Cloud mode doesn't need a connection check (it's gated by OAuth/AAD). On-prem validates at startup to fail fast on network/TLS/auth issues.

## Implementation Units

### U1. URL Detection + CLI Flags in `src/index.ts`

**Goal:** Make the entry point accept URLs, add `--allow-untrusted-cert` and `--allow-http` flags, skip tenant resolution for on-prem, perform startup connection check.

**Files:**

- `src/index.ts` (modify)

**Approach:**

1. Add two new yargs options: `--allow-untrusted-cert` (boolean, default false) and `--allow-http` (boolean, default false)
2. After parsing argv, detect if `organization` is a URL (starts with `http://` or `https://`):
   - If `http://` and `!argv.allowHttp` → exit with error
   - If URL and hostname is `dev.azure.com` or matches `*.visualstudio.com` → extract org from path, use cloud mode
   - Otherwise → on-prem mode, use URL directly as `orgUrl`
3. If `--allow-untrusted-cert`: set `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` and log warning to stderr
4. If `--allow-http` with PAT auth: log high-visibility warning about cleartext credentials
5. Skip `getOrgTenant()` when in on-prem mode (it crashes on non-cloud URLs)
6. After server setup but before `server.connect()` (on-prem only): `GET {orgUrl}/_apis/connectionData` — if it fails, log error and `process.exit(1)`; if it succeeds, log the server version from the response

**Test scenarios:**

- Plain org name → cloud mode, `orgUrl` = `https://dev.azure.com/{org}`
- `https://dev-tfs/tfs/collection` → on-prem mode, `orgUrl` = input URL
- `https://dev.azure.com/myorg` → cloud mode (extracts `myorg`)
- `https://myorg.visualstudio.com` → cloud mode (extracts `myorg`)
- `http://server/tfs/col` without `--allow-http` → error exit
- `http://server/tfs/col` with `--allow-http` → proceeds with warning
- `--allow-untrusted-cert` → sets env var, logs warning
- On-prem startup check fails → clear error, exit 1
- On-prem startup check succeeds → logs server version, continues

**Dependencies:** None — this is the first unit and all others depend on it.

### U2. Fix Identity API URL in `src/tools/auth.ts`

**Goal:** Replace hardcoded `vssps.dev.azure.com` identity URL with `connection.serverUrl`-based URL.

**Files:**

- `src/tools/auth.ts` (modify)

**Approach:**

The `searchIdentities` function currently does:

```typescript
const orgName = connection.serverUrl.split("/")[3];
const baseUrl = `https://vssps.dev.azure.com/${orgName}/_apis/identities`;
```

Replace with:

```typescript
const baseUrl = `${connection.serverUrl}/_apis/identities`;
```

This works for both cloud (the global fetch interceptor handles auth) and on-prem (identity API exists at the collection URL — verified).

**Test scenarios:**

- Cloud: identity search still works (same effective URL routing via fetch interceptor)
- On-prem: identity search hits `{collectionUrl}/_apis/identities` correctly

**Dependencies:** U1 (on-prem mode must be functional)

### U3. Replace Hardcoded Search URLs in `src/tools/search.ts`

**Goal:** Remove `orgName` import, use `connection.serverUrl` for all search API calls, handle 404 gracefully.

**Files:**

- `src/tools/search.ts` (modify)

**Approach:**

1. Remove `import { orgName } from "../index.js"`
2. In each of the 3 search tool handlers (`search_code`, `search_wiki`, `search_workitem`):
   - Get connection from `connectionProvider` (already called in `search_code`; add to the other two)
   - Replace `https://almsearch.dev.azure.com/${orgName}/_apis/search/...` with `${connection.serverUrl}/_apis/search/...`
3. Add graceful 404 handling: if the search API returns 404, return a user-friendly message like "Search is not available on this server (may require Azure DevOps Server Search extension to be installed)"

**Test scenarios:**

- Cloud: search URLs resolve correctly via `connection.serverUrl` (which is `https://dev.azure.com/{org}` — the fetch interceptor + DNS still route to almsearch)
- On-prem: search URLs use collection URL directly
- On-prem without search extension installed: 404 → clear error message instead of crash
- All three search tools (code, wiki, work item) updated

**Dependencies:** U1 (on-prem mode context), but can be developed in parallel with U2

### U4. Integration Test and Documentation

**Goal:** Verify the full flow works end-to-end, update README with on-prem usage.

**Files:**

- `README.md` (modify — add on-prem usage section)
- `docs/GETTINGSTARTED.md` (modify — add on-prem configuration example)
- `test/src/tools/search.test.ts` (modify — add on-prem URL tests)

**Approach:**

1. Add unit tests for URL detection logic (cloud vs on-prem routing)
2. Add tests for search URL construction with on-prem serverUrl
3. Add a "Connecting to Azure DevOps Server (On-Premise)" section to README covering:
   - Basic usage: `mcp-server-azuredevops https://server/tfs/collection --authentication pat`
   - TLS: `NODE_EXTRA_CA_CERTS` recommendation, `--allow-untrusted-cert` escape hatch
   - HTTP: `--allow-http` for non-TLS environments (with security caveat)
   - mcp.json example for on-prem configuration
4. Verify existing tests still pass (cloud mode backward compat)

**Test scenarios:**

- Existing test suite passes unchanged (R9 backward compat)
- New URL detection tests cover all branches
- Search URL construction tests verify on-prem pattern

**Dependencies:** U1, U2, U3

## Alternatives Considered

- **New `--collection-url` flag:** Rejected — requires mutual exclusion logic, 5+ file changes, new abstraction. The positional arg handles both modes elegantly.
- **Explicit cloud-tool gating in on-prem mode:** Rejected — would create merge conflicts with upstream and require maintaining a list. API errors surface naturally and are already handled by `extractAdoStreamError()`.

## Risks

- **Search API path differences:** Cloud uses `almsearch.dev.azure.com`, on-prem uses the collection URL directly. If the path structure differs beyond the hostname, search will break on-prem. Mitigation: the `_apis/search/...` suffix is the same on both (verified in Azure DevOps Server 2020+ docs).
- **`connection.serverUrl` trailing slash variance:** Different WebApi configurations may include/exclude trailing slashes. Mitigation: normalize URL construction (strip trailing slash before appending `/_apis/...`).
- **Upstream divergence:** This fork adds ~35 lines. Minimal surface area keeps rebasing easy.

## Sequencing

```
U1 (index.ts: URL detection + flags + startup check)
├── U2 (auth.ts: identity URL fix) — can start after U1
├── U3 (search.ts: search URL fix) — can start after U1
└── U4 (tests + docs) — after U1, U2, U3
```

U2 and U3 are independent and can be developed in parallel once U1 lands.

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-10-on-prem-server-support-requirements.md`
- `azure-devops-node-api` `WebApi` class: natively accepts collection URL, handles resource area resolution
- Azure DevOps Server REST API: `_apis/connectionData` endpoint for server info
- Verified: `https://dev-tfs/tfs/internal_projects/_apis/identities` responds on-prem
