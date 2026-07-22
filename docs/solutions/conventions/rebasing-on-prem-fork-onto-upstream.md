---
title: "Rebasing the on-prem fork onto upstream: what to preserve and what to take"
module: build-and-deploy
date: 2026-07-09
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Rebasing or syncing the ditec (on-prem) fork onto microsoft/azure-devops-mcp main"
  - "Resolving conflicts in src/utils.ts, package-lock.json, or tests after an upstream pull"
  - "Upstream bumped API versions, changed auth internals, or updated hardcoded test expectations"
  - "Upstream landed a tool-consolidation PR that restructured a module a fork fix lives in"
symptoms:
  - "Merge conflict resolved by silently taking upstream's side, breaking on-prem behavior"
  - "14 tests fail after rebase due to hardcoded API-version string mismatches"
  - "Editor reports 'Cannot find namespace jest' in test files after tree changes"
  - "A fork fix silently disappears when git applies it to a function upstream renamed or merged away"
tags:
  - fork-management
  - upstream-sync
  - rebase
  - on-prem
  - api-version
  - conflict-resolution
  - tool-consolidation
  - force-with-lease
---

# Rebasing the on-prem fork onto upstream: what to preserve and what to take

## Context

The `ditec` branch of our `DITEC-Mracka/azure-devops-mcp` fork carries on-prem Azure DevOps Server support on top of upstream `microsoft/azure-devops-mcp`. Periodically we rebase `ditec` onto the refreshed `main` mirror to pick up upstream fixes.

The friction: upstream is a **cloud-first** codebase. Several upstream changes are actively wrong for on-prem TFS, so a naive "take upstream's side" conflict resolution silently reintroduces bugs the fork already fixed. On the last rebase this happened with API versions, and cascaded into 14 failing tests plus an editor-only TypeScript error — none of which the rebase itself reported as conflicts.

This doc is the checklist of **what to preserve (ours) vs. take (upstream)** so the next rebase doesn't re-derive it from scratch.

## The procedure at a glance

The conflict-resolution rules below are the _contract_; the outer loop is always the same repeatable, plan-first procedure. Write the per-rebase plan (topology + predicted conflicts) first, then execute it:

1. **Map the topology.** `git merge-base ditec origin/main`, then `git log --oneline <base>..origin/ditec` (our commits to replay) and `<base>..origin/main` (incoming upstream). Know how many commits replay onto what.
2. **Predict conflicts by file overlap.** Intersect `git diff --name-only <base> origin/ditec` with `git diff --name-only <base> origin/main`. The intersection _is_ your conflict list — pre-classify each against the cheat sheet before starting.
3. **Scan the incoming batch for tool consolidations** (Rule 7) — they turn small line-fixes into re-apply-by-intent work and are the highest-risk conflicts.
4. **Safety ref, then rebase.** `git branch backup/ditec-pre-rebase-<date> origin/ditec`; `git rebase origin/main`, resolving each stop per Rules 1–7.
5. **Regenerate, don't hand-merge.** `npm install` (lockfile, Rule 5) → `npm run build` (dist) → `npm test` → `npm run validate-tools`.
6. **Verify intent survived.** The 7.2 grep (Rule 1) and the per-fix unique-string greps (Rule 7) are the tripwire — a green build alone does not prove the fork's fixes are still present.
7. **Publish with a lease.** `git push --force-with-lease origin ditec` (rebase rewrites the branch; **never** plain `--force`). On rejection, inspect the concurrent push — do not force over it. Then fast-forward local `main` to `origin/main`.

Why plan-first: the topology and overlap maps (steps 1–2) are cheap to compute and turn a blind rebase into a checklist where every stop is expected. Steps 3 and 6 exist because the dangerous failures are _silent_ (see Rule 7 and Why This Matters).

## Guidance

### Rule 1 — Preserve the on-prem API-version downgrade (never take upstream's bump)

On-prem Azure DevOps Server supports a **maximum API version of 7.1**. Requests with `7.2-preview` are rejected at runtime with `VssVersionOutOfRangeException`. Upstream targets cloud and bumps to `7.2-preview`. The fork deliberately pins 7.1 in [src/utils.ts](../../../src/utils.ts) — see ditec commit `86f7210` ("fix: downgrade API versions from 7.2 to 7.1 for on-prem compatibility", verified against a real on-prem call).

Keep **ours** on any conflict here:

```typescript
// src/utils.ts — on-prem values, do NOT take upstream's 7.2
export const apiVersion = "7.1-preview.1"; // upstream: 7.2-preview.1
export const batchApiVersion = "5.0"; // same on both
export const markdownCommentsApiVersion = "7.1-preview.3"; // upstream: 7.2-preview.4
```

Grep the whole tree for stray hardcoded versions after every rebase — the shared constant is not the only place a version string hides. Upstream had an inline `7.2-preview.3` in [src/tools/test-plans.ts](../../../src/tools/test-plans.ts) (`list_test_cases`) that the original downgrade commit missed; it must also be 7.1:

```bash
# After every rebase, this should return ONLY comments — never a live 7.2 string
grep -rn "7\.2-preview" src/
```

### Rule 2 — Reconcile hardcoded test expectations to 7.1 (tests verify logic, not a live server)

Upstream tests hardcode the cloud version strings (`api-version=7.2-preview.1`, `7.2-preview.4`) in URL assertions across [test/src/tools/auth.test.ts](../../../test/src/tools/auth.test.ts), [core.test.ts](../../../test/src/tools/core.test.ts), [wiki.test.ts](../../../test/src/tools/wiki.test.ts), and [work-items.test.ts](../../../test/src/tools/work-items.test.ts). After Rule 1 the code emits 7.1, so these assertions fail (this was the "14 failed tests" symptom).

These tests only verify **URL construction logic** — they never hit a real server — so the version in the assertion is arbitrary and just has to match what the code produces. Update the assertions to 7.1; do **not** revert the code to 7.2 to make them pass. Tests that reference the shared `apiVersion` constant (e.g. [pipelines.test.ts](../../../test/src/tools/pipelines.test.ts)) adapt automatically and need no edit.

### Rule 3 — Don't be fooled by pre-existing test drift (SSPI handler)

Not every post-rebase failure is caused by the rebase. The SSPI tests in [test/src/sspi-handler.test.ts](../../../test/src/sspi-handler.test.ts) were **stale on `ditec` independently**: they mock the old `httpClient.requestRaw`, but [handleAuthentication](../../../src/sspi-handler.ts) now performs the Negotiate/NTLM handshake through the private `rawRequest` (raw `http`/`https.request` over a keep-alive socket) and reads `requestInfo.parsedUrl.href`. The mocks supplied only `hostname`, so `new URL(undefined)` threw at `src/sspi-handler.ts:114`.

Fix by aligning the test to the implementation — spy on the private method and give a valid `href`:

```typescript
const rawSpy = jest
  .spyOn(SspiRequestHandler.prototype as any, "rawRequest")
  .mockResolvedValueOnce({ statusCode: 401, headers: { "www-authenticate": "Negotiate" }, body: "" })
  .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: "OK" });

const mockRequestInfo = {
  options: { method: "GET", headers: {} },
  parsedUrl: { href: "https://dev-tfs/tfs/internal_projects/_apis/connectionData" },
};
```

Before assuming a failure is the rebase's fault, confirm whether the same test fails on the pre-rebase tip (`git show origin/ditec:<file>` / a throwaway worktree). It saves chasing a non-existent regression.

### Rule 4 — Add `test/tsconfig.json` for the editor, not the build

After tree changes the editor may report `Cannot find namespace 'jest'` across test files. This is **editor-only**: the root [tsconfig.json](../../../tsconfig.json) `include`s only `src` and `docs`, so VS Code's language server associates test files with a config that lacks `@types/jest`. The build ([tsconfig.json](../../../tsconfig.json)) and `npm test` ([tsconfig.jest.json](../../../tsconfig.jest.json)) are unaffected — VS Code only auto-associates files via configs literally named `tsconfig.json`.

The fix is a thin editor-only config (already in the tree) — do not delete it during a rebase cleanup:

```jsonc
// test/tsconfig.json
{
  "extends": "../tsconfig.jest.json",
  "include": ["./**/*"],
}
```

After adding it, run **TypeScript: Restart TS Server** — stale language-server analysis persists on already-open files until the server reloads.

### Rule 5 — `package-lock.json` conflicts: take the newer tree, then regenerate

`package-lock.json` conflicts on nearly every rebase. Don't hand-merge it — regeneration makes the `--ours`/`--theirs` choice almost irrelevant, so just pick either committed side and re-derive:

```bash
# NOTE: during `git rebase ditec onto main`, the sides are SWAPPED vs a merge:
#   --ours   = the base you're replaying onto (upstream main)  ← the newer tree here
#   --theirs = the ditec commit being applied
git checkout --ours package-lock.json     # take upstream main's lockfile during a rebase
npm install                               # regenerate a coherent lockfile (authoritative step)
```

The `npm install` regeneration is what actually matters; the checkout just gives it a clean starting point.

### Rule 6 — Verify without hanging the terminal

Prefer the editor's language server (get-errors) and a single `npm test` run for verification. A full-project `npx tsc` type-check is slow and can hold the terminal open, which looks like a hang. Never leave a watch-mode or full `tsc` running as a "check".

### Rule 7 — Upstream _tool consolidations_ restructure modules: re-apply by intent, then grep to verify

Periodically upstream lands large **tool-consolidation** PRs (e.g. work-items #1435, test-plan #1431, pipeline #1428, wiki #1423) that move, rename, or merge whole tool handlers into a single action-dispatched tool. When a fork fix lives in a function these PRs restructured, git cannot align the small hunk: it drops the fix into a hunk that no longer exists, applies it to a renamed function, or — worst — reports a _clean_ apply that silently lost the fix. **Do not trust the auto-merge; re-apply the fix's _intent_ onto upstream's new structure** (take `--ours` = the consolidated file, then port the fork change into it).

Two concrete cases from the 2026-07-22 rebase:

- **work-items comment fix** — upstream's consolidation had already dropped the extra-brace typo but _not_ the fork's status-code + response-body diagnostics. Took the consolidated handler, then re-added only the diagnostics. Now at [src/tools/work-items.ts](../../../src/tools/work-items.ts) line 785:

  ```typescript
  throw new Error(`Failed to add a work item comment: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`);
  ```

- **test-plans `list_test_cases`** — took the consolidated file, then downgraded the inline version to 7.1 per Rule 1. Now at [src/tools/test-plans.ts](../../../src/tools/test-plans.ts) line 125 (`"7.1-preview.3"`).

**Prove intent survived — don't eyeball `git show`.** After the rebase, grep for a unique string from each fix; each must return exactly one live hit. Fold this into the Rule 1 version-check pass:

```powershell
# each must return exactly one hit; zero (or the old text) means a consolidation ate the fix
Select-String -Path src/tools/work-items.ts -Pattern 'Failed to add a work item comment'  # improved throw, NOT the old ${response.statusText}} typo
Select-String -Path src/tools/test-plans.ts -Pattern '7\.1-preview\.3'                     # on-prem version in list_test_cases
```

### Rule 8 — `server.json`: drop upstream's cloud-only `remotes` and `packages`

Upstream adds cloud-only fields to `server.json` — a `remotes` block pointing at `mcp.dev.azure.com` and a `packages` entry for the npm `@microsoft/azure-devops` release. Neither applies to the on-prem fork: the cloud remote is meaningless against an on-prem Server, and the fork installs via **direct GitHub**, not npm. On conflict, **keep ours** (the fork manifest that omits both). Verify after rebase that `server.json` still has no `remotes` / `packages` / `mcp.dev.azure.com`.

### Rule 9 — Publish with `--force-with-lease`, and read a rejection as a signal

The rebase rewrites `ditec`'s history, so publishing requires a force push. Always use the lease: `git push --force-with-lease origin ditec`, **never** plain `--force`. A rejection is not something to power through — it means `origin/ditec` moved since the safety ref was taken (a concurrent push). Inspect it (`git fetch origin ditec; git log --oneline -3 origin/ditec`), coordinate if it is real work, else reset to the backup ref and retry. Then realign local `main`: `git checkout main; git merge --ff-only origin/main; git checkout ditec`.

## Why This Matters

The dangerous failure mode is **silent**: git reports a conflict only on the exact lines that differ, so taking upstream's `7.2` in `src/utils.ts` looks like a clean resolution and compiles fine. The breakage only surfaces at runtime against a real TFS (`VssVersionOutOfRangeException` on every call) — long after the rebase is "done". The 14 unit-test failures are actually a _gift_: they're the tripwire that catches Rule 1 being violated. Understanding that the tests encode the fork's intent (7.1) — not upstream's (7.2) — is what turns a confusing red suite into a clear signal.

Separating rebase-caused failures (Rules 1–2) from pre-existing drift (Rule 3) and editor-only noise (Rule 4) prevents both under-fixing (shipping a 7.2 regression) and over-fixing (reverting good code to silence a stale test).

## When to Apply

- Every time `ditec` is rebased onto or merged with the refreshed `main` upstream mirror.
- Whenever a conflict lands in `src/utils.ts`, a `*.test.ts` URL assertion, `src/sspi-handler.ts`, or `package-lock.json`.
- When post-rebase tests go red or the editor flags `jest` namespace errors.

## Examples

Post-rebase verification sequence (covers the mechanical rules 1–4):

```bash
# 1. Rule 1 + first half of Rule 2: no live 7.2 strings left in source
grep -rn "7\.2-preview" src/            # expect: comments only
# PowerShell equivalent: Get-ChildItem -Recurse src -Include *.ts | Select-String '7\.2-preview'

# 2. Rules 2 + 3: full suite green (adjust test assertions to 7.1, fix SSPI mocks)
npm test                                # expect: all suites pass

# 3. Rule 4: editor sanity — open a test file, confirm no 'Cannot find namespace jest'
#    If present: ensure test/tsconfig.json exists, then Restart TS Server
```

Conflict-resolution cheat sheet:

| File                                         | On conflict, keep…                    | Why                                                                                           |
| -------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/utils.ts` (api versions)                | **ours (7.1)**                        | On-prem TFS rejects 7.2 (`VssVersionOutOfRangeException`)                                     |
| `src/tools/test-plans.ts` (inline version)   | **ours (7.1)**                        | Same on-prem constraint; upstream missed this one                                             |
| `test/**/*.test.ts` (version in URL asserts) | **7.1 to match code**                 | Tests assert URL construction, not a live server                                              |
| `src/sspi-handler.ts`                        | **ours**                              | On-prem SSPI/Negotiate handshake is fork-specific                                             |
| `test/tsconfig.json`                         | **ours (keep it)**                    | Editor-only `@types/jest` association; not in build                                           |
| `package-lock.json`                          | **newer tree, then `npm install`**    | Hand-merging lockfiles corrupts them                                                          |
| `src/tools/*.ts` hit by a consolidation PR   | **theirs (structure) + re-port ours** | Consolidation renamed/merged the handler; port the fix's intent, then grep to verify (Rule 7) |
| `server.json` (`remotes` / `packages`)       | **ours (drop cloud fields)**          | Cloud remote + npm package don't apply on-prem (Rule 8)                                       |

Publishing the rebased branch: `git push --force-with-lease origin ditec` — never plain `--force` (Rule 9).
