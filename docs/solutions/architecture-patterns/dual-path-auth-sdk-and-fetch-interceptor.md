---
title: Dual-path authentication for MCP servers (SDK handlers + global fetch interceptors)
date: 2026-06-11
category: architecture-patterns
module: authentication
problem_type: architecture_pattern
component: authentication
severity: high
applies_when:
  - "Adding on-prem auth (SSPI/Negotiate) to a system with both SDK clients and raw fetch() calls"
  - "Supporting cloud and on-prem deployments with different auth protocols"
  - "Needing transparent auth across many callsites without modifying each one"
tags:
  - sspi
  - negotiate
  - fetch-interceptor
  - on-prem
  - mcp-server
  - typed-rest-client
  - windows-auth
---

# Dual-path authentication for MCP servers (SDK handlers + global fetch interceptors)

## Context

The azure-devops-mcp server (TypeScript, ES modules) exposes Azure DevOps APIs via two incompatible auth paths:

1. **SDK calls** — `azure-devops-node-api` WebApi class accepts an `IRequestHandler` for auth (typed-rest-client)
2. **Raw fetch calls** — 14+ tool endpoints (search, wiki, work-items batch, test-plans) use `globalThis.fetch()` with Bearer tokens from a `tokenProvider`

Adding on-prem Azure DevOps Server support required SSPI/Negotiate authentication across both paths. On-prem servers respond with `401 + WWW-Authenticate: Negotiate/NTLM` and require multi-round-trip SSPI handshakes — fundamentally different from cloud Bearer/PAT token auth.

The initial implementation only wired SSPI into the `IRequestHandler` (SDK path). This broke all 14 raw-fetch call sites because `tokenProvider()` returned `""` in SSPI mode, sending `Authorization: Bearer` (malformed, empty token) → 401 on every tool call.

## Guidance

Implement a **layered auth architecture** with four components:

### 1. URL Resolution Layer — detect cloud vs on-prem once at startup

```typescript
// src/utils.ts
export function resolveOrgUrl(organization: string, allowHttp: boolean): OrgResolution {
  // Plain org name → https://dev.azure.com/{org}, isOnPrem: false
  // dev.azure.com/{org} URL → extract org from path, isOnPrem: false
  // *.visualstudio.com → extract org from subdomain, isOnPrem: false
  // Any other URL → isOnPrem: true
  // Guards: empty org extraction throws, http:// requires allowHttp flag
}
```

### 2. IRequestHandler for SDK path — dedicated class for typed-rest-client

```typescript
// src/sspi-handler.ts
class SspiRequestHandler implements IRequestHandler {
  prepareRequest(options: http.RequestOptions): void {
    options.headers = options.headers ?? {}; // Guard null headers!
    options.headers["Connection"] = "keep-alive"; // Required for NTLM multi-round
  }
  canHandleAuthentication(response): boolean {
    return response.statusCode === 401 && /negotiate|ntlm/i.test(response.headers["www-authenticate"]);
  }
  async handleAuthentication(httpClient, requestInfo, objs): Promise<IHttpClientResponse> {
    const winSso = await import("win-sso"); // Dynamic import — optionalDependency
    const sso = new winSso.WinSso("Negotiate", targetHost, peerCert, undefined);
    try {
      // Initial Negotiate token → send → multi-round-trip loop (max 5) → return
    } finally {
      try {
        sso.freeAuthContext();
      } catch {} // Always free SSPI context
    }
  }
}
```

### 3. Global Fetch Interceptor — handle raw-fetch tools transparently

Replace `globalThis.fetch` with a URL-scoped interceptor. **Critical:** never rewrite headers for non-ADO requests.

**PAT mode:**

```typescript
const orgOrigin = new URL(orgUrl).origin;
const isAdoRequest = (url: string) => url.startsWith(orgOrigin) || url.startsWith("https://almsearch.dev.azure.com/");
globalThis.fetch = async (input, init) => {
  if (isAdoRequest(requestUrl)) {
    // Rewrite Bearer → Basic for PAT auth
  }
  return _originalFetch(input, init);
};
```

**SSPI mode:**

```typescript
globalThis.fetch = async (input, init) => {
  if (!requestUrl.startsWith(orgOrigin)) return _originalFetch(input, init);

  // Strip empty Bearer from probe (tokenProvider returns "" in SSPI mode)
  const probeHeaders = new Headers(init?.headers);
  probeHeaders.delete("Authorization");
  let response = await _originalFetch(input, { ...init, headers: probeHeaders });
  if (response.status !== 401) return response;

  // Check for Negotiate/NTLM challenge
  const wwwAuth = response.headers.get("www-authenticate");
  if (!wwwAuth?.toLowerCase().includes("negotiate")) return response;

  // Perform SSPI handshake
  const winSso = await import("win-sso");
  const sso = new winSso.WinSso("Negotiate", targetHost, undefined, undefined);
  try {
    headers.set("Authorization", sso.createAuthRequestHeader());
    response = await _originalFetch(input, { ...init, headers });
    // Multi-round-trip loop for NTLM (max 5 rounds)
    while (response.status === 401 && rounds < 5) { ... }
    return response;
  } finally {
    try { sso.freeAuthContext(); } catch {}
  }
};
```

### 4. Search URL Derivation — eliminate circular dependencies

Tool modules must NOT import from the CLI entry point. Derive URLs from `connection.serverUrl`:

```typescript
// src/tools/search.ts — no import from ../index.js
function getSearchBaseUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  if (parsed.hostname === "dev.azure.com") {
    return `https://almsearch.dev.azure.com${parsed.pathname}`;
  }
  return serverUrl; // On-prem: search extension co-located with server
}
```

### Key defensive patterns

- **URL-scoped interceptors** — always check `requestUrl.startsWith(orgOrigin)` before modifying headers
- **AbortSignal.timeout(10_000)** on startup connection checks — prevent infinite hangs
- **Detect explicit CLI flags** via `process.argv.some(a => a === "--authentication" || ...)` — not by comparing with default value
- **Dynamic `import("win-sso")`** — optionalDependency, fails gracefully on non-Windows
- **Strip Authorization before probe** — prevent sending malformed `Bearer` header (`tokenProvider()` returns `""` in SSPI mode)

## Why This Matters

1. **Transparent auth** — existing tool implementations don't change; they continue calling `fetch()` with Bearer tokens, interceptor handles translation
2. **No circular dependencies** — each layer is self-contained; tools derive URLs from connection state
3. **Security** — interceptors are URL-scoped so credentials never leak to non-ADO requests
4. **Platform safety** — `win-sso` is dynamically imported and validated; non-Windows gets clear error

## When to Apply

- Adding auth to a system mixing SDK clients with raw HTTP calls
- Supporting both cloud SaaS and on-prem deployments with different auth protocols
- Working with SSPI/Negotiate/NTLM in Node.js (multi-round-trip, keep-alive, context cleanup)
- Any MCP server or API wrapper targeting Azure DevOps Server

## Examples

**Before (broken): SSPI only on SDK path — raw-fetch tools get 401:**

```typescript
// tokenProvider returns "" for SSPI → all 14 raw-fetch tools broken
const token = await tokenProvider();
fetch(url, { headers: { Authorization: `Bearer ${token}` } });
// → Sends "Authorization: Bearer " → server returns 401
```

**After: Fetch interceptor handles it transparently:**

```typescript
// Tool code unchanged — interceptor strips empty Bearer, does SSPI handshake
const token = await tokenProvider();
fetch(url, { headers: { Authorization: `Bearer ${token}` } });
// → Interceptor: strips Bearer, probes server, gets 401, does Negotiate, returns authed response
```

**Before (broken): circular dependency:**

```typescript
import { isOnPrem, orgName } from "../index.js"; // Tool imports from CLI entry point!
```

**After: self-contained derivation:**

```typescript
function getSearchBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  return url.hostname === "dev.azure.com" ? `https://almsearch.dev.azure.com${url.pathname}` : serverUrl;
}
```

## Related

- [Fork management strategy](../best-practices/fork-management-github-install-2026-06-10.md) — the on-prem fork management that motivated this work
- `win-sso` package: Windows SSPI bindings for Node.js (Negotiate, NTLM, Kerberos)
- Azure DevOps Search API uses a separate host (`almsearch.dev.azure.com`) for cloud mode
