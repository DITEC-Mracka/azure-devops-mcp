# Azure DevOps MCP Server — Agent Instructions

## Project Overview

This is an MCP (Model Context Protocol) server that exposes Azure DevOps APIs as tools for AI coding agents. It uses TypeScript, Zod for parameter validation, and the `@modelcontextprotocol/sdk` package.

## Build & Run Commands

```bash
npm run build              # Compile TS → dist/, generate version, chmod +x
npm run validate-tools     # Build + validate all tool/param names (CI gate)
npm test                   # Jest test suite
npm test -- --coverage     # With coverage report
npm run eslint-fix         # Lint + auto-fix
npm run format             # Prettier format
npm run inspect            # MCP Inspector for local testing
```

## Architecture

- **Entry:** `src/index.ts` — CLI parsing, auth setup, MCP server init
- **Tool router:** `src/tools.ts` — domain-based feature gating via `--domains` flag
- **Domain modules:** `src/tools/{domain}.ts` — each exports `configure*Tools(server, tokenProvider, connectionProvider, userAgentProvider)`
- **Shared utilities:** `src/shared/` — validation, domains, elicitations, content safety
- **Logging:** Winston → stderr only (stdout reserved for MCP protocol)
- **Documented solutions:** `docs/solutions/` — past problem resolutions and best practices, organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

## Adding a New Tool

1. Define tool name in the `*_TOOLS` constant map at the top of `src/tools/{domain}.ts`
2. Register with `server.tool(TOOLS.name, description, zodSchema, asyncHandler)`
3. Use Zod `.describe()` on every parameter for Claude integration
4. Tool name pattern: `^[a-zA-Z0-9_.-]{1,64}$` — enforced by ESLint rule + build validator
5. Parameter names: keep under 32 chars (warning threshold)
6. Run `npm run validate-tools` to verify

See [docs/TOOL-NAME-VALIDATION.md](../docs/TOOL-NAME-VALIDATION.md) for the 3-layer validation system.

## Key Conventions

- **ES modules** with `.js` import extensions in source (TypeScript resolves them)
- **Strict TypeScript** — no implicit any
- **Domain gating:** Tools are grouped by domain enum (`src/shared/domains.ts`); each is independently toggleable
- **Elicitation pattern:** Use `elicitProject()` / `elicitTeam()` when parameters are optional and missing
- **Content safety:** Wrap external content responses with `createExternalContentResponse()`
- **Error extraction:** Use `extractAdoStreamError()` for Azure DevOps API errors

## Testing

- Framework: Jest + ts-jest (`tsconfig.jest.json` with CommonJS + isolatedModules)
- Structure mirrors `src/`: tests go in `test/src/tools/{domain}.test.ts`
- Mocks live in `test/mocks/`
- Coverage threshold: 40% global baseline

## Authentication Strategies

Set via `--authentication` CLI flag: `interactive` (MSAL OAuth, default), `azcli`, `env`/`envvar` (PAT via `AZURE_DEVOPS_PAT`), `pat`

## Context Reuse

When a project name, team name, or other identifier has been established in previous tool call results or user input, reuse those values automatically in subsequent calls.
