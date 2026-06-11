---
title: "feat: Windows SSO via SSPI (Milestone 2)"
type: feat
date: 2026-06-11
origin: docs/brainstorms/2026-06-10-on-prem-server-support-requirements.md
depends_on: docs/plans/2026-06-11-001-feat-on-prem-server-support-plan.md
---

# feat: Windows SSO via SSPI (Milestone 2)

## Summary

Add `--authentication sspi` auth type that uses the current Windows user's domain credentials (NTLM/Kerberos via SSPI) for zero-credential connectivity to on-prem Azure DevOps Server. Auto-selected on Windows when an on-prem URL is detected. Uses the `win-sso` package for the SSPI handshake with EPA (channel binding) for NTLM relay mitigation.

## Problem Frame

Milestone 1 delivers on-prem connectivity via PAT. But PATs expire, need manual creation, and add friction. Domain-joined Windows machines already have valid credentials — SSPI lets the MCP server use them transparently, matching what Visual Studio and `git credential-manager` do. This is the native experience enterprise users expect.

## Requirements

- **R1.** New auth type `sspi` via `--authentication sspi`
- **R2.** Auto-selected as default auth when: on-prem URL detected AND running on Windows
- **R3.** Multi-round-trip Negotiate/NTLM handshake via SSPI (transparent Kerberos/NTLM selection)
- **R4.** EPA (Extended Protection for Authentication) via TLS channel binding when connecting over HTTPS
- **R5.** Windows-only — attempting on Linux/macOS produces a clear error suggesting `--authentication pat`
- **R6.** Graceful failure when SSPI init fails (not domain-joined, no network) — clear error, not a crash
- **R7.** The global fetch interceptor (PAT mode) must NOT interfere with SSPI auth headers
- **R8.** `win-sso` is an optional dependency — `npm install` must not break on non-Windows platforms

## Key Technical Decisions

- **`win-sso` package for SSPI:** MIT, prebuilt N-API binaries (no node-gyp needed), EPA support via `peerCert` param. v1.3.3, compatible with Node 18.18+/20.9+/22+. Single maintainer (bjowes) but stable, 0 open issues. (see origin doc for full validation)
- **Custom `IRequestHandler` for typed-rest-client:** The `azure-devops-node-api` `WebApi` constructor accepts an `IRequestHandler`. We implement a `SspiRequestHandler` that performs the Negotiate handshake, preserving connection affinity (keep-alive) during multi-round-trip auth.
- **Optional dependency pattern:** `win-sso` is listed in `optionalDependencies` (not `dependencies`). Import is dynamic (`await import("win-sso")`). This prevents `npm install` failures on Linux/macOS and allows the package to work cross-platform (just without SSPI).
- **Fetch interceptor bypass:** SSPI mode does NOT install the global fetch interceptor. The auth mode switch in `src/index.ts` must be exclusive — either PAT interceptor OR SSPI handler, never both.
- **Auto-selection logic:** On-prem URL + `process.platform === "win32"` + no explicit `--authentication` flag → default to `sspi`. If user explicitly passed `--authentication pat`, respect it.

## Implementation Units

### U1. Add `win-sso` as Optional Dependency

**Goal:** Add the package without breaking cross-platform installs.

**Files:**

- `package.json` (modify — add to `optionalDependencies`)

**Approach:**

1. Add `"win-sso": "^1.3.3"` to `optionalDependencies` in `package.json`
2. Do NOT add to regular `dependencies` — this ensures `npm install` on Linux/macOS succeeds even though the native binary isn't available for those platforms
3. Run `npm install` on Windows to verify the prebuilt binary downloads correctly

**Test scenarios:**

- `npm install` on Windows → `win-sso` installs with prebuilt binary
- `npm install` on Linux/macOS → proceeds without error (optional dep missing is OK)

**Dependencies:** None

### U2. Implement `SspiRequestHandler`

**Goal:** Create a custom `IRequestHandler` that performs SSPI Negotiate/NTLM authentication with EPA support.

**Files:**

- `src/sspi-handler.ts` (create)

**Approach:**

1. Create a new file `src/sspi-handler.ts` exporting a class `SspiRequestHandler` implementing `IRequestHandler` from `typed-rest-client/Interfaces`
2. Dynamic import of `win-sso` — wrap in try/catch, throw clear error if unavailable
3. Constructor:
   - Accept target hostname/SPN
   - Initialize `win-sso`'s `SspiClient` with `"Negotiate"` package
   - For HTTPS connections: extract the TLS peer certificate and pass to `SspiClient` via `peerCert` for EPA (channel binding)
4. `prepareRequest(options)`: no-op on first call (token obtained in `canHandleAuthentication`/`handleAuthentication` cycle)
5. `canHandleAuthentication(response)`: return `true` when response is 401 with `WWW-Authenticate: Negotiate` or `NTLM`
6. `handleAuthentication(httpClient, requestInfo, objs)`:
   - Multi-round-trip loop:
     - Call `sspiClient.getNextBlob(serverBlob)` to get the next client token
     - Set `Authorization: Negotiate <token>` header
     - Re-send the request (preserving keep-alive for connection affinity)
     - If response is 401 with a server blob → next round
     - If response is 200/non-401 → auth complete, return response
   - Handle errors gracefully (network, SSPI failures → clear error messages)
7. Export a factory function `createSspiHandler(serverUrl: string)` that handles the TLS cert extraction and returns the handler

**Test scenarios:**

- Successful Negotiate auth with single round-trip (Kerberos)
- Successful NTLM auth with 3 round-trips (Type1 → Type2 → Type3)
- EPA: channel binding token included when connecting over HTTPS
- `win-sso` not available → clear error: "SSPI authentication requires Windows. Use --authentication pat instead."
- Server doesn't support Negotiate → clear error
- Network error during handshake → wrapped error with suggestion

**Dependencies:** U1

### U3. Wire SSPI Auth into `src/auth.ts` and `src/index.ts`

**Goal:** Add `sspi` to the auth type switch, implement auto-selection logic, ensure fetch interceptor exclusivity.

**Files:**

- `src/auth.ts` (modify)
- `src/index.ts` (modify)

**Approach:**

**`src/auth.ts`:**

1. Add `"sspi"` to the `choices` array in yargs authentication option
2. Add a new case in `createAuthenticator` switch:
   ```
   case "sspi":
     // SSPI doesn't use a token provider in the traditional sense
     // Return a no-op — actual auth is handled by SspiRequestHandler
     return async () => "";
   ```
   (The SSPI handler is attached at the WebApi level, not the token provider level)

**`src/index.ts`:**

1. Add auto-selection logic after URL detection:
   - If on-prem mode AND `process.platform === "win32"` AND user didn't explicitly set `--authentication` → override to `"sspi"`
   - Log: "On-prem URL detected on Windows — using SSPI authentication (override with --authentication pat)"
2. When auth type is `sspi`:
   - Do NOT install the global fetch interceptor
   - In `getAzureDevOpsClient()`, use `createSspiHandler(orgUrl)` instead of bearer/PAT handler:
     ```typescript
     const connection = new WebApi(orgUrl, createSspiHandler(orgUrl), ...);
     ```
3. Platform guard: if `sspi` selected but `process.platform !== "win32"` → exit with clear error

**Test scenarios:**

- On-prem + Windows + no explicit auth → auto-selects `sspi`, logs message
- On-prem + Windows + `--authentication pat` → uses PAT, no SSPI
- On-prem + Linux + auto-detect → does NOT auto-select sspi (stays at requiring explicit auth)
- Explicit `--authentication sspi` on Linux → clear error exit
- SSPI mode → no global fetch interceptor installed
- SSPI mode → WebApi constructed with SspiRequestHandler

**Dependencies:** U1, U2

### U4. Graceful Failure and Startup Validation

**Goal:** Ensure SSPI failures produce actionable errors, not cryptic crashes.

**Files:**

- `src/sspi-handler.ts` (modify)
- `src/index.ts` (modify)

**Approach:**

1. In the startup connection check (already exists from M1 plan):
   - When auth is `sspi`, the startup check also validates that SSPI handshake succeeds
   - If it fails with a clear SSPI error (not domain-joined, SPN not found, etc.) → emit specific error message with remediation suggestion (`--authentication pat`)
   - If it fails with network error → emit standard connection error (same as M1)
2. In `SspiRequestHandler`:
   - Wrap `sspiClient.getNextBlob()` errors with context: which round, what the server sent
   - Catch `win-sso` initialization errors (DLL load failure, etc.) → "SSPI unavailable: {reason}. Use --authentication pat as fallback."
3. Handle the case where `win-sso` package is present but SSPI context creation fails (e.g., machine not joined to domain) — this is different from package-not-installed

**Test scenarios:**

- Machine not domain-joined → "SSPI failed: not joined to a domain. Use --authentication pat."
- Server rejects auth (wrong SPN, disabled Negotiate) → clear error with server response
- `win-sso` DLL load failure → "SSPI unavailable on this system. Use --authentication pat."
- Startup check with SSPI succeeds → proceeds normally

**Dependencies:** U2, U3

### U5. Tests and Documentation

**Goal:** Unit tests for SSPI handler, integration guidance, README update.

**Files:**

- `test/src/sspi-handler.test.ts` (create)
- `test/src/tools/auth.test.ts` (modify — add sspi cases)
- `README.md` (modify — add Windows SSO section)
- `docs/GETTINGSTARTED.md` (modify — add SSPI setup)

**Approach:**

1. Unit tests for `SspiRequestHandler`:
   - Mock `win-sso` module for cross-platform test execution
   - Test handshake state machine (single-round Kerberos, multi-round NTLM)
   - Test EPA cert extraction
   - Test error paths (module unavailable, auth rejected, network failure)
2. Tests for auto-selection logic:
   - Mock `process.platform` to test Windows/non-Windows paths
   - Verify fetch interceptor is NOT installed in SSPI mode
3. Documentation:
   - README: "Windows Single Sign-On (SSPI)" section explaining zero-config usage on domain-joined machines
   - Getting started: note that SSPI is auto-selected, PAT is the cross-platform fallback
   - Mention `NODE_EXTRA_CA_CERTS` still applies (TLS cert needed for EPA too)

**Test scenarios:**

- All existing tests pass (SSPI doesn't affect cloud/PAT paths)
- Mock-based SSPI handshake tests pass on all platforms
- Auto-selection logic tests cover all platform × auth × URL combinations

**Dependencies:** U1–U4

## Risks

- **Single-maintainer dependency (`win-sso`):** The package has one maintainer. Mitigation: it's MIT-licensed and uses stable N-API — if abandoned, the prebuilt binaries continue working and the code is forkable. The optional dependency pattern means it doesn't block non-Windows usage.
- **Connection affinity (keep-alive) requirement:** NTLM requires the same TCP connection across all handshake rounds. If a proxy or load balancer breaks connection affinity, NTLM fails silently. Mitigation: document that NTLM requires direct connectivity to the server; Kerberos is preferred in load-balanced environments.
- **Fetch interceptor interaction:** The global fetch interceptor (PAT mode) rewrites Authorization headers. If accidentally installed alongside SSPI, it would corrupt the Negotiate tokens. Mitigation: exclusive auth mode switch — one or the other, enforced in `src/index.ts` with clear code path separation.
- **EPA cert extraction timing:** The TLS peer certificate must be extracted from the connection before the first auth round. The `typed-rest-client` HTTP pipeline may not expose this easily. Mitigation: may need to use Node.js `tls.TLSSocket.getPeerCertificate()` directly on the underlying socket. Research during implementation.

## Sequencing

```
U1 (package.json: add win-sso)
└── U2 (sspi-handler.ts: implement handler)
    └── U3 (auth.ts + index.ts: wire in)
        └── U4 (graceful failures)
            └── U5 (tests + docs)
```

Strictly sequential — each unit builds on the previous.

## Assumptions

- Milestone 1 is already implemented (on-prem URL detection, startup check, `orgUrl` export)
- Target Azure DevOps Server 2022 accepts Negotiate authentication
- MCP server runs on domain-joined Windows machine (or one with network access to the KDC)
- `typed-rest-client`'s `IRequestHandler` interface is stable and supports the multi-round-trip pattern needed for NTLM

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-10-on-prem-server-support-requirements.md`
- `win-sso` npm: v1.3.3, MIT, prebuildify N-API, EPA via `peerCert`, engines `^18.18.0 || ^20.9.0 || >=21.1.0`
- `typed-rest-client` IRequestHandler: interface with `prepareRequest`, `canHandleAuthentication`, `handleAuthentication`
- SSPI Negotiate flow: client sends empty Negotiate → server 401 + blob → client computes response → repeat until 200
