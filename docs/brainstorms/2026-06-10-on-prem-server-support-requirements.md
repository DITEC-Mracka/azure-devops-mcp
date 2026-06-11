# Azure DevOps Server (On-Prem) Support

**Date:** 2026-06-10
**Status:** Ready for planning

## Outcome

Enable the MCP server to connect to Azure DevOps Server (on-premise) in addition to Azure DevOps Services (cloud). Delivered in two milestones:

1. **Milestone 1 (on-prem via URL + PAT)** — Cross-platform on-prem connectivity by accepting a collection URL in the existing `organization` positional arg. No native dependencies, minimal code changes (~20 lines across 3 files). Ships fast.
2. **Milestone 2 (Windows SSO)** — Optional Windows-only NTLM/Negotiate SSO for zero-credential experience on domain-joined machines.

## Design Decision: Substitute-in-Place (Approach A)

Research confirmed that `azure-devops-node-api`'s `WebApi` class natively accepts a collection URL and handles on-prem resource area resolution. Most tools already use `connection.serverUrl` or standard WebApi API methods — they work without changes.

**Chosen approach:** The existing positional `organization` argument accepts either:

- An organization name (cloud) → constructs `https://dev.azure.com/{org}` as today
- A full collection URL (on-prem) → uses it directly as `orgUrl`

Detection: if the value starts with `http://` or `https://`, treat as collection URL.

**Rejected alternative:** A new `--collection-url` flag with URL resolver abstraction. Overkill — requires 5+ file changes, new abstraction layer, mutual exclusion logic.

## Requirements

### Milestone 1: On-Prem Connection + PAT

#### Connection Model

- The positional `organization` arg accepts a full collection URL (with or without `/tfs/` segment)
  - Cloud: `mcp-server-azuredevops myorg`
  - On-prem: `mcp-server-azuredevops https://dev-tfs/tfs/internal_projects`
- Detection: value starting with `http://` or `https://` → check hostname:
  - If hostname is `dev.azure.com` or `*.visualstudio.com` → cloud mode (extract org name from URL path segment)
  - Otherwise → on-prem mode (URL used directly as `orgUrl`)
- URL validation: require `https://` scheme; `http://` only with explicit `--allow-http` flag
- Cloud mode remains the default and is fully backward-compatible
- Collection switching is per-instance: run a separate MCP server process per collection

#### Code Changes Required (3 files)

**`src/index.ts` (~5 lines):**

- Detect if `organization` arg is a URL
- If URL: use directly as `orgUrl`, skip `getOrgTenant()` call
- If plain name: construct `https://dev.azure.com/{org}` as today

**`src/tools/auth.ts` (~3 lines):**

- Replace hardcoded `https://vssps.dev.azure.com/${orgName}/_apis/identities` with `${connection.serverUrl}/_apis/identities`
- Works for both cloud and on-prem (vssps split-DNS is cosmetic; the identity API exists at the collection URL)

**`src/tools/search.ts` (~25-35 lines):**

- Remove `import { orgName } from "../index.js"` — orgName may now be a URL, which breaks URL interpolation
- Replace all 3 hardcoded `https://almsearch.dev.azure.com/${orgName}` URLs (code search, wiki search, work item search) with `connection.serverUrl`-based URLs
- Get `connection.serverUrl` from connectionProvider in each tool handler
- On-prem Azure DevOps Server 2020+ serves search at `{collectionUrl}/{project}/_apis/search/...` (different path pattern than cloud)
- If search is not installed on-prem, the API returns 404 — handle gracefully with clear error message
- **Note:** This change is coupled with the `index.ts` change — search.ts must stop importing orgName before orgName can semantically become a URL

#### Tenant Resolution

- MUST skip `getOrgTenant()` when organization is a URL — calling it with a URL will crash the process (it throws on failure, does not return `undefined`)
- This is a hard requirement, not optional: `getOrgTenant("https://dev-tfs/...")` would attempt to fetch `https://vssps.dev.azure.com/https://dev-tfs/...` and throw

#### Authentication: PAT (On-Prem)

- Existing PAT auth (`--authentication pat`) works unchanged with on-prem URLs
- The `PERSONAL_ACCESS_TOKEN` env var mechanism applies identically
- This is the recommended cross-platform auth method for on-prem
- **Milestone 1 default:** On-prem mode requires explicit `--authentication pat` (no implicit default). Milestone 2 later changes the default to `sspi` on Windows.

#### TLS / Certificates

- Recommended approach: `NODE_EXTRA_CA_CERTS` env var for custom CA bundles
- Support `--allow-untrusted-cert` flag as last-resort escape hatch:
  - Emit a visible startup warning to stderr when active
  - Document that this is process-wide (Node.js limitation)
- When `--allow-http` is active AND auth is PAT: emit high-visibility warning that credentials travel in cleartext
- Alternatively respect `NODE_TLS_REJECT_UNAUTHORIZED=0` (existing Node.js behavior, no code needed)

#### Minimum Server Version

- Minimum supported: Azure DevOps Server 2020 (API version 6.0)
- Target environment: Azure DevOps Server 2022 (to be confirmed at startup)
- Tools calling newer API versions should degrade gracefully (return clear error, not crash) on older servers

#### Startup Connection Check

- On-prem mode performs a lightweight connection check at startup (e.g., `GET {collectionUrl}/_apis/connectionData`)
- If the check fails: emit a clear error to stderr and exit — do not wait for the first tool call to discover misconfiguration
- The check also verifies server version and logs it (useful for debugging API compatibility issues)

### Milestone 2: Windows Integrated Auth (SSO)

#### Authentication: Windows SSO

- New auth type `sspi` (via `--authentication sspi`) — name reflects actual mechanism (SSPI Negotiate, which selects Kerberos or NTLM transparently)
- Uses the current Windows user's credentials automatically — no password prompt
- Implements Negotiate/NTLM multi-round-trip handshake via SSPI against the on-prem server
- Requires a custom `IRequestHandler` implementation that bridges SSPI tokens into the typed-rest-client HTTP pipeline, preserving connection affinity (keep-alive) during the handshake
- This auth type is only available on Windows; attempting it on other platforms produces a clear error
- Default auth type when on-prem URL is provided on Windows: `sspi` (auto-selected, no explicit flag needed)
- Graceful failure: if SSPI initialization fails (machine not domain-joined, not on network), emit a clear error suggesting `--authentication pat` as fallback — do not crash cryptically
- **Note:** Milestone 2 must refactor or conditionally bypass the existing global fetch interceptor (PAT auth rewrites Bearer→Basic headers) — SSPI needs exclusive control over Authorization headers during Negotiate handshake.

#### Security: NTLM Relay Mitigation

- Enable Extended Protection for Authentication (EPA/channel binding) via the `peerCert` constructor parameter when connecting over HTTPS
- ✅ Verified: `win-sso` supports EPA natively — pass the TLS peer certificate to add channel binding to the authentication message

#### Cloud-Only Tools

- Tools that call cloud-only services (Advanced Security, MCP Apps) are NOT explicitly gated in on-prem mode
- They will naturally return API errors (404 / network unreachable) which are surfaced via existing `extractAdoStreamError()` handling
- This is intentional: zero additional code = zero merge conflicts with upstream
- Tool descriptions should mention "Azure DevOps Services only" where applicable

## Non-Goals

- Multi-collection routing within a single server instance
- Credential persistence/caching beyond the process lifetime (SSPI handles token refresh transparently within the session)
- Linux/macOS NTLM/Kerberos support
- Azure DevOps Server versions older than 2020
- New `--collection-url` CLI flag (unnecessary — positional arg handles both modes)
- Explicit gating/disabling of cloud-only tools in on-prem mode (let API errors surface naturally)

## Dependencies / Assumptions

### Milestone 1

- `azure-devops-node-api` already handles on-prem resource area resolution (returns serverUrl when resource areas are empty)
- No new native dependencies required
- Tools using `connection.serverUrl` or WebApi API methods work without changes: `pipelines.ts`, `work-items.ts`, `test-plans.ts`, `wiki.ts`, `core.ts`, `repositories.ts`

### Milestone 2

- `win-sso` npm package (MIT, native C++ addon) for SSPI/Negotiate handshake without explicit credentials
- ✅ Verified: compatible with Node.js 18.18+, 20.9+, 22+ (engines field). Ships prebuilt N-API binaries — no node-gyp/MSVC required for users
- ✅ EPA (channel binding) supported via `peerCert` constructor parameter — residual relay risk is mitigated
- v1.3.3 (May 2025), single maintainer (bjowes), 2,327 weekly downloads, 0 open issues
- The on-prem server accepts Negotiate or NTLM authentication
- MCP server runs on Windows in the same domain as the Azure DevOps Server (or reachable Kerberos realm)
- Consider making the native addon an optional peer dependency so it doesn't break `npm install` on non-Windows platforms

## Resolved Questions

- **Identity API at collection URL:** ✅ Verified — `https://dev-tfs/tfs/internal_projects/_apis/identities` responds (requires query params but endpoint exists). Fix is valid.
- **SSRF via user-supplied URL:** Not a real threat — MCP server runs locally (stdio), user configures URL in mcp.json/CLI, agent cannot change URL at runtime.
- **SSPI auto-selection:** Auto-select `sspi` on Windows when on-prem URL detected is acceptable (user explicitly configured the URL).
- **Cloud-only tools:** Let API errors surface naturally. No explicit gating needed.
- **PAT + HTTP warning:** Warning only (not refusal) when PAT auth is combined with `--allow-http`.
- **Startup connection check:** ✅ Fail-fast at startup — on-prem mode performs a lightweight connection check (e.g., `_apis/connectionData`) on init. If it fails, emit a clear error before any tool call.
- **Target server version:** ✅ Azure DevOps Server 2022 (assumed, to be verified via API call). Minimum supported remains 2020.
- **win-sso Node.js compatibility:** ✅ Verified — `engines: "^18.18.0 || ^20.9.0 || >=21.1.0"`. Ships prebuilt N-API binaries via prebuildify — no node-gyp or MSVC build tools needed. EPA (channel binding) is supported via `peerCert` constructor parameter. v1.3.3 (May 2025), MIT, active.

## Outstanding Questions

All questions resolved — none remaining.
