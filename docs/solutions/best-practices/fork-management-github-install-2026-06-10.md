---
title: "Fork management strategy for direct GitHub install"
module: build-and-deploy
date: 2026-06-10
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Forking an npm package from a public repo for customization
  - Need to install MCP server directly from GitHub without npm registry
  - Maintaining a fork that tracks upstream changes
tags:
  - fork-management
  - github-install
  - npx
  - upstream-sync
  - dist-commit
---

# Fork Management Strategy for Direct GitHub Install

## Context

We forked `microsoft/azure-devops-mcp` to `DITEC-Mracka/azure-devops-mcp` to add on-prem Azure DevOps Server support. The MCP server needs to be installable directly from the GitHub fork URL (via `npx github:DITEC-Mracka/azure-devops-mcp`) without requiring consumers to have TypeScript or other build tooling installed.

The challenge: npm installs from git URLs do **not** install `devDependencies`, so the `prepare` script (which runs `tsc`) fails. The upstream repo has `dist/` in `.gitignore` since they publish to npm registry where tarballs already contain built JS.

## Guidance

### 1. Commit `dist/` in the fork

Remove `dist` from `.gitignore` and commit the built JavaScript output. This is what npm registry tarballs contain — we're just keeping it in git instead.

```gitignore
# .gitignore — comment out or remove the dist line
# dist - included in fork for direct GitHub install (npx github:DITEC-Mracka/azure-devops-mcp)
```

### 2. Remove build from `prepare` script

The `prepare` script runs during `npm install` from git URL. Since `dist/` is already committed, consumers don't need to build. Keep `husky` for local dev:

```json
"prepare": "husky"
```

Previously: `"prepare": "npm run build && husky"`

### 3. Exclude `dist/` from lint-staged

Lint-staged passes staged files directly to prettier (bypassing `.prettierignore`). Exclude dist:

```json
"lint-staged": {
  "!(dist/**)/**/*.(js|ts|jsx|tsx|json|css|md)": [
    "npm run format"
  ]
}
```

### 4. Branch strategy: `main` as upstream mirror, `ditec` as custom branch

GitHub's "Sync fork" button matches branches by name with the upstream repo. To make it safe:

- **`main`** = clean upstream mirror (Sync fork updates this safely)
- **`ditec`** = our changes + `dist/` (default branch, npx install target)

```bash
# One-time setup
git remote add upstream https://github.com/microsoft/azure-devops-mcp.git
git branch ditec main                         # create custom branch from current state
git checkout main
git reset --hard upstream/main                # main = clean upstream
git checkout ditec
git push origin main --force-with-lease       # push clean main
git push origin ditec                         # push custom branch
# On GitHub: Settings → Default branch → ditec
```

**Why this layout:**

- "Sync fork" on GitHub only touches `main` → never corrupts our custom code
- `main` is always a clean upstream mirror → trivial rebase source
- Colleagues can safely click "Sync fork" without breaking anything

### 5. Sync workflow (pulling new upstream changes)

```bash
# After someone clicks "Sync fork" on GitHub, or manually:
git fetch origin                              # get updated main
git checkout ditec
git rebase origin/main                        # our commits on top of new upstream
npm run build                                 # rebuild dist/
git add dist/
git commit --amend --no-edit                  # update dist in last commit
git push origin ditec --force-with-lease
```

### 6. MCP client configuration

```json
{
  "servers": {
    "ado": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:DITEC-Mracka/azure-devops-mcp#ditec", "<org>"]
    }
  }
}
```

Note the `#ditec` suffix — without it, npm would fetch the default branch. Since we set `ditec` as default on GitHub, it would work without `#ditec` too, but being explicit is safer.

## Why This Matters

- **Without dist/ in git**: `npx github:...` fails because npm can't build without `typescript`, `@types/node`, and `shx` (devDependencies not installed for git deps)
- **Without removing prepare build**: Even with dist/ committed, the prepare script would try to rebuild and fail
- **Branch separation**: "Sync fork" creates merge commits on `main` — keeping custom code on a separate branch avoids merge commit pollution and keeps rebase workflow clean
- **Rebase workflow**: Keeps our on-prem commits clearly on top of upstream, making conflicts visible and history linear

## When to Apply

- When forking any TypeScript npm package for internal customization
- When the fork needs to be installable via git URL without build tooling
- When maintaining long-lived fork that tracks upstream releases
- When multiple people have access to the fork and might click "Sync fork"

## Examples

**Before (fails):**

```
$ npx github:DITEC-Mracka/azure-devops-mcp#ditec myorg
> npm ERR! sh: tsc: command not found
```

**After (works):**

```
$ npx github:DITEC-Mracka/azure-devops-mcp#ditec myorg
> Azure DevOps MCP Server started...
```

**Only 3 devDependencies are needed for build:**

- `typescript` — the compiler
- `@types/node` — Node.js type definitions
- `shx` — cross-platform `chmod +x`

## Avoiding "Sync fork" accidents

| Situation                                    | Impact                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| Someone clicks "Sync fork"                   | ✅ Safe — only updates `main` (upstream mirror)      |
| Someone merges `main` into `ditec` on GitHub | ⚠️ Creates merge commit — fix with local rebase      |
| Upstream changes same files we changed       | Rebase shows conflicts on `ditec` — resolve manually |

**Recovery if someone merges main into ditec on GitHub:**

```bash
git fetch origin
git checkout ditec
git rebase origin/main     # recreate linear history
npm run build
git add dist/
git commit --amend --no-edit
git push origin ditec --force-with-lease
```

All other devDependencies (jest, prettier, eslint, husky, lint-staged) are for development only.
