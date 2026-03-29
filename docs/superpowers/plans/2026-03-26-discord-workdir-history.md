# Discord Workdir History Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord-first workdir picker so `/session-new` can create sessions from saved machine-local workdir history or newly scanned local project directories without requiring free-form `cwd` entry.

**Architecture:** Extend the shared SQLite schema with a machine-level `workdirs` catalog, add runner-owned workdir list/scan/save endpoints, then build a Discord session-creation wizard with buttons, selects, and a rename modal that resolves to the existing session-creation flow. Keep allowed-root validation at every boundary and preserve the existing thread/session orchestration once a final path is chosen.

**Tech Stack:** TypeScript, Node.js, discord.js, better-sqlite3, Vitest, SQLite, local runner HTTP API

---

## Chunk 0: Workspace bootstrap

### Task 0: Start from an isolated feature workspace

**Files:**
- Modify: `.gitignore`

- [ ] Step 1: Create or reuse a dedicated feature branch/worktree for the workdir-history feature
- [ ] Step 2: Ensure the chosen worktree parent is ignored in `.gitignore`
- [ ] Step 3: Install dependencies in the isolated workspace if needed
- [ ] Step 4: Run `npm test` in the isolated workspace and verify the baseline is GREEN before changing code

## Chunk 1: Shared workdir catalog and runner APIs

### Task 1: Add workdir schema and repository coverage

**Files:**
- Modify: `src/shared/db/schema.ts`
- Modify: `src/shared/db/database.ts`
- Modify: `src/shared/db/repositories.ts`
- Test: `tests/shared/database.test.ts`

- [ ] Step 1: Write failing repository tests for inserting, upserting, listing, and marking workdirs as used in `tests/shared/database.test.ts`
- [ ] Step 2: Run `npx vitest run tests/shared/database.test.ts` and verify RED for missing workdir storage behavior
- [ ] Step 3: Add the `workdirs` table to `src/shared/db/schema.ts`
- [ ] Step 4: Update `src/shared/db/database.ts` only if bootstrap wiring needs to change for the new table in tests
- [ ] Step 5: Add typed `workdirs` repository methods to `src/shared/db/repositories.ts`
- [ ] Step 6: Re-run `npx vitest run tests/shared/database.test.ts` and verify GREEN

### Task 2: Add deterministic workdir scan service and runner endpoints

**Files:**
- Create: `src/local-runner/workdir-catalog.ts`
- Modify: `src/local-runner/http-server.ts`
- Modify: `src/local-runner/index.ts`
- Modify: `src/shared/config.ts`
- Modify: `src/discord-control/runner-client.ts`
- Test: `tests/local-runner/http-server.test.ts`

- [ ] Step 1: Write failing HTTP-server tests for listing saved workdirs, scanning paged candidates, saving scanned workdirs, and rejecting out-of-root paths in `tests/local-runner/http-server.test.ts`
- [ ] Step 2: Run `npx vitest run tests/local-runner/http-server.test.ts` and verify RED for missing endpoints and root enforcement
- [ ] Step 3: Implement scan heuristics, root filtering, exclusions, and pagination in `src/local-runner/workdir-catalog.ts`
- [ ] Step 4: Thread `ALLOWED_ROOTS` into runner startup via `src/shared/config.ts` and `src/local-runner/index.ts`
- [ ] Step 5: Add `/workdirs`, `/workdirs/scan`, and save handling to `src/local-runner/http-server.ts`
- [ ] Step 6: Extend `src/discord-control/runner-client.ts` with typed list/scan/save methods
- [ ] Step 7: Re-run `npx vitest run tests/local-runner/http-server.test.ts` and verify GREEN

## Chunk 2: Session creation command contract and Discord wizard entry

### Task 3: Refactor session creation command flow around optional direct cwd

**Files:**
- Modify: `src/discord-control/command-handlers.ts`
- Modify: `src/shared/contracts/runner-api.ts`
- Test: `tests/discord-control/command-handlers.test.ts`

- [ ] Step 1: Write failing command-handler tests for creating sessions from a selected workdir path, keeping allowed-root enforcement, and covering any new runner workdir contract types in `tests/discord-control/command-handlers.test.ts`
- [ ] Step 2: Run `npx vitest run tests/discord-control/command-handlers.test.ts` and verify RED for the new create path
- [ ] Step 3: Keep `handleCreateSession()` path validation focused and reusable so the Discord wizard can call it after a selection is made
- [ ] Step 4: Add any runner contract types needed for workdir list/scan/save payloads in `src/shared/contracts/runner-api.ts`
- [ ] Step 5: Re-run `npx vitest run tests/discord-control/command-handlers.test.ts` and verify GREEN

### Task 4: Change `/session-new` into a picker-first wizard entry

**Files:**
- Modify: `src/discord-control/bot.ts`
- Test: `tests/discord-control/bot.test.ts`

- [ ] Step 1: Write failing bot tests showing `/session-new` responds with `Use history` and `Search new` actions when `cwd` is omitted, and directly creates a session if an optional `cwd` is still supplied for compatibility
- [ ] Step 2: Run `npx vitest run tests/discord-control/bot.test.ts -t "session-new"` and verify RED for the new entry behavior
- [ ] Step 3: Update slash-command metadata in `src/discord-control/bot.ts` so `cwd` is no longer required for the picker-first flow
- [ ] Step 4: Add wizard bootstrap handling in `src/discord-control/bot.ts` that stores the initiator and advanced options for later selection steps
- [ ] Step 5: Re-run `npx vitest run tests/discord-control/bot.test.ts -t "session-new"` and verify GREEN

## Chunk 3: History selection, scan selection, rename modal, and ownership rules

### Task 5: Add interaction routing primitives for selects and modals

**Files:**
- Modify: `src/discord-control/bot.ts`
- Test: `tests/discord-control/bot.test.ts`

- [ ] Step 1: Write failing bot tests for string-select and modal-submit routing needed by the workdir wizard
- [ ] Step 2: Run `npx vitest run tests/discord-control/bot.test.ts -t "workdir"` and verify RED for missing routing support
- [ ] Step 3: Add type guards and routing branches in `src/discord-control/bot.ts` for string-select and modal-submit interactions
- [ ] Step 4: Add explicit ephemeral wizard-state storage and invalidation rules in `src/discord-control/bot.ts` for initiator id, selected path data, and expiration handling
- [ ] Step 5: Re-run `npx vitest run tests/discord-control/bot.test.ts -t "workdir"` and verify GREEN for routing support

### Task 6: Add history selection interactions

**Files:**
- Modify: `src/discord-control/bot.ts`
- Test: `tests/discord-control/bot.test.ts`

- [ ] Step 1: Write failing bot tests for loading saved workdirs, paginating results, creating a session from a selected history item, and rejecting foreign-user interactions
- [ ] Step 2: Run `npx vitest run tests/discord-control/bot.test.ts -t "history"` and verify RED
- [ ] Step 3: Implement history button handling and history select payloads in `src/discord-control/bot.ts`
- [ ] Step 4: Implement history pagination actions and initiator-only checks in `src/discord-control/bot.ts`
- [ ] Step 5: Re-run `npx vitest run tests/discord-control/bot.test.ts -t "history"` and verify GREEN

### Task 7: Add scan-result selection interactions

**Files:**
- Modify: `src/discord-control/bot.ts`
- Test: `tests/discord-control/bot.test.ts`

- [ ] Step 1: Write failing bot tests for launching paged scan results, surfacing no-results states, rejecting stale scan selections, and rejecting out-of-root scan save/create attempts
- [ ] Step 2: Run `npx vitest run tests/discord-control/bot.test.ts -t "scan"` and verify RED
- [ ] Step 3: Implement scan button handling and scan-result select payloads in `src/discord-control/bot.ts`
- [ ] Step 4: Implement scan pagination actions and stale-result replies in `src/discord-control/bot.ts`
- [ ] Step 5: Re-run `npx vitest run tests/discord-control/bot.test.ts -t "scan"` and verify GREEN

### Task 8: Add rename modal and save-before-create behavior

**Files:**
- Modify: `src/discord-control/bot.ts`
- Test: `tests/discord-control/bot.test.ts`

- [ ] Step 1: Write failing bot tests for default basename naming, custom modal naming, and preserving existing custom names on re-scan
- [ ] Step 2: Run `npx vitest run tests/discord-control/bot.test.ts -t "rename"` and verify RED
- [ ] Step 3: Implement default basename fallback for scanned paths in `src/discord-control/bot.ts`
- [ ] Step 4: Implement custom rename modal submission handling in `src/discord-control/bot.ts`
- [ ] Step 5: Implement save/upsert behavior that preserves existing custom names unless the user submits a new one in `src/discord-control/bot.ts`
- [ ] Step 6: Implement session creation after a successful save in `src/discord-control/bot.ts`
- [ ] Step 7: Re-run `npx vitest run tests/discord-control/bot.test.ts -t "rename"` and verify GREEN

## Chunk 4: Documentation and full verification

### Task 9: Update docs and verify the full feature set

**Files:**
- Modify: `README.md`

- [ ] Step 1: Update `README.md` to document the new `/session-new` picker flow and local workdir history behavior
- [ ] Step 2: Run focused test files touched by the work
- [ ] Step 3: Run `npm test` and verify GREEN
- [ ] Step 4: Run `npm run build` and verify GREEN
- [ ] Step 5: Manually spot-check that no secrets, local machine-only paths, or stale worktree artifacts were introduced outside intended test fixtures
