# AGENTS Guide

This file is for coding agents working in this repository.

## Project Overview

- Project: `discord-claude-runner`
- Stack: TypeScript, Node.js, Vitest, `discord.js`, `better-sqlite3`
- Module mode: ESM (`"type": "module"` + `moduleResolution: "NodeNext"`)
- Main areas:
  - `src/local-runner/`: local Claude runner HTTP service and runtime orchestration
  - `src/discord-control/`: Discord bot, rendering, replay, session routing
  - `src/shared/`: config, security, DB schema/repositories, shared domain contracts
  - `src/smoke/`: smoke harnesses
  - `tests/`: Vitest unit/integration coverage

## Develop Guidances

- ALWAYS Create new branch or worktree if you're asked to add new feats. or fix bugs.


## Rules Files

- No root `AGENTS.md` existed before this file.
- No `.cursorrules` found.
- No `.cursor/rules/` directory found.
- No `.github/copilot-instructions.md` found.

## Setup Notes

- Copy `.env.example` to `.env` for local runs.
- Never commit `.env`, tokens, Discord IDs, database files, or machine-specific paths.
- Top-level `.gitignore` already excludes local secrets and build artifacts.

## Core Commands

- Install deps: `npm install`
- Run full tests: `npm test`
- Typecheck/build gate: `npm run build`
- Start local runner: `npm run runner`
- Start Discord control: `npm run discord`
- Tokenless smoke flow: `npm run smoke:tokenless`
- Claude-auth smoke flow: `CLAUDE_MODEL=sonnet npm run smoke:runner`

## There Is No Dedicated Lint Script

- There is no `npm run lint` today.
- Treat `npm run build` as the static-analysis gate.
- Use existing file style as the formatter source of truth.

## Single-Test Commands

Use Vitest directly for targeted runs.

- Run one file:
  - `npx vitest run tests/discord-control/bot.test.ts`
- Run one test by name:
  - `npx vitest run tests/discord-control/bot.test.ts -t "creates a fresh assistant message for each new user turn"`
- Run multiple files:
  - `npx vitest run tests/discord-control/bot.test.ts tests/discord-control/message-renderer.test.ts`
- Re-run a narrow slice while iterating:
  - `npx vitest run tests/shared/security.test.ts -t "expands a leading tilde before checking allowed roots"`

Recommended validation order for most changes:

1. Targeted Vitest command for touched behavior
2. `npm test`
3. `npm run build`

## High-Value Smoke Commands

- Fast workflow sanity check without Discord transport:
  - `npm run smoke:tokenless`
- Runner sanity check with Claude auth available locally:
  - `CLAUDE_MODEL=sonnet npm run smoke:runner`

Use smoke tests when changing session orchestration, replay, or end-to-end flows.

## Import Conventions

- Use ESM imports only.
- Local imports must include the `.js` extension, even in `.ts` files.
  - Example: `import { createCommandHandlers } from './command-handlers.js';`
- Prefer `import type` for type-only imports.
  - Example: `import type { RunnerControlClient } from './runner-client.js';`
- Group imports simply:
  1. external packages
  2. local runtime imports
  3. local type imports if split separately
- Avoid unused imports; keep import lists tight.

## Formatting Conventions

- Use 2-space indentation.
- Use single quotes.
- Keep semicolons.
- Favor trailing commas where surrounding code uses them.
- Keep long object literals and function calls multi-line when they stop being readable on one line.
- Match the surrounding file rather than introducing a new style.

## TypeScript Style

- `tsconfig` is strict; do not weaken types to make compilation pass.
- Prefer explicit domain types over `any`.
- Use `unknown` at external boundaries, then narrow with guards.
- Prefer `Readonly<{ ... }>` for structured object types used as contracts.
- Prefer literal unions and `as const` arrays over enums.
- Export explicit types for public module boundaries.
- Preserve narrow return types where possible.
- Avoid type assertions unless there is no cleaner narrowing path.

## Naming Conventions

- `camelCase` for variables, parameters, and functions
- `PascalCase` for types and type aliases
- `UPPER_SNAKE_CASE` for module-level constants
- Use descriptive verb-led helper names:
  - `createX`, `startX`, `buildX`, `parseX`, `resolveX`, `loadX`, `formatX`, `isX`, `canX`
- Boolean guards should read like predicates:
  - `isThreadChannel`, `isUnknownChannelError`, `canManageSessions`

## Function Design

- Keep functions focused and single-purpose.
- Prefer small helper functions over deeply nested blocks.
- Push parsing/formatting into named helpers instead of inlining complex transformations.
- For orchestration code, keep side effects near the edges and pure transforms in helpers.

## Error Handling Guidelines

- Throw plain `Error` with short, specific messages for validation failures.
- Catch errors at integration boundaries:
  - Discord gateway handlers
  - startup recovery
  - runner transport boundaries
- Log unexpected failures through existing logger hooks.
- Return `null` for “not found / unavailable” paths where the rest of the code already expects nullable flow.
- Do not swallow errors silently unless the calling path is explicitly best-effort and logs elsewhere.
- Preserve user-safe wording in Discord-facing responses.

## Config and Secrets

- All runtime secrets belong in environment variables.
- Do not hardcode:
  - `DISCORD_TOKEN`
  - `DISCORD_CLIENT_ID`
  - `DISCORD_GUILD_ID`
  - `ANTHROPIC_API_KEY`
  - user IDs / role IDs
  - machine-specific paths
- Keep `.env.example` updated whenever a required env var changes.
- If adding config, wire it through `src/shared/config.ts` and document it in `README.md`.

## Repository and DB Changes

- Shared persistent state flows through `src/shared/db/schema.ts`, `src/shared/db/database.ts`, and `src/shared/db/repositories.ts`.
- If schema changes, update repository behavior and corresponding tests together.
- Preserve restart/replay behavior when changing delivery state or session state.

## Discord-Control Specific Guidance

- Main assistant reply rendering lives in `src/discord-control/message-renderer.ts`.
- Discord orchestration and event handling live in `src/discord-control/bot.ts`.
- Keep assistant text separate from tool cards.
- Prefer concise user-facing Discord copy.
- When modifying thread/session behavior, verify multi-turn continuity and restart recovery paths.

## Lessons From The Session-Naming Rollout

- Preserve core invariants when refactoring `session-new` flow. Creating a session is not enough; the bot must also persist the `threadId -> sessionId` binding immediately or later thread messages will be ignored.
- Manual validation must run the Discord bot and local runner from a consistent stack. Do not point a new bot build at an older runner/database pair and assume failures come from the new feature.
- For isolated manual Discord tests, prefer a clean local bot DB or a clean local runner DB. Startup recovery will replay existing bindings, and stale or synthetic thread ids can hide the real bug.
- When debugging Discord auth/RBAC issues, verify the exact runtime identities from logs before changing code. `DISCORD_CLIENT_ID` must match the bot token's application, and `SESSION_MANAGER_USER_IDS` must contain real user ids, not guild ids.
- Passing unit tests is necessary but not sufficient for Discord/session orchestration changes. After the test suite passes, also verify one real `/session-new` flow end-to-end: command registration, thread creation, summary post, binding persistence, first user reply, and first assistant reply.
- If a new thread shows only the waiting placeholder, inspect both layers before changing code again: bot logs/bindings on the Discord side, then runner session state/events on the runner side. This prevents blaming the UI for a runner/runtime failure.

## Testing Style

- Add or update tests with behavior changes.
- Prefer small, targeted tests over giant scenario blocks.
- Reuse fake helpers from `tests/support/` and local builders in existing test files.
- Follow existing Vitest style:
  - `describe(...)`
  - `it(...)`
  - direct expectations on visible behavior
- Name tests by behavior, not implementation details.

## Before Finishing Work

- Run targeted tests for changed files.
- Run `npm test`.
- Run `npm run build`.
- For Discord or runner orchestration changes, run at least one real end-to-end manual check or the closest available smoke flow with the same bot/runner pairing you intend to use.
- Check that no secrets or local paths were introduced.
- If you add env/config surface area, update `.env.example` and `README.md`.

## Agent Workflow Notes

- Prefer minimal, surgical edits.
- Preserve existing architecture unless the task clearly requires broader refactoring.
- Do not introduce unrelated cleanup in the same change.
- When unsure, follow the established patterns in `src/discord-control/` and `src/shared/`.
