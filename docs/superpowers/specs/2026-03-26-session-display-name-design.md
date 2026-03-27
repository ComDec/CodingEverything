# Session Display Name Design

## Goal

Allow `/session-new` to accept an optional custom session name. If the user does not provide one, the system should generate a short kebab-case display name such as `pretty-fire`.

The chosen name should become part of the session's metadata, be used as the Discord thread title when the bot creates a new thread, and appear in the session summary shown to the user.

## Confirmed Product Decisions

1. `/session-new` gains a new optional `name` parameter.
2. If the user provides a name, that name is used after normalization.
3. If the user does not provide a name, the bot generates a default adjective-noun slug.
4. The final name is used for the thread title when a new thread is created, and for the session summary UI in all cases.
5. The final name is persisted with the session so recovery and later reads use one canonical source of truth.
6. This feature should be developed in an isolated git worktree and prepared in a PR-friendly branch.

## Design Principles

- One canonical session display name per session
- Generate once at creation time, then reuse everywhere
- Keep the implementation dependency-light
- Preserve compatibility with existing persisted sessions
- Prefer normalization and fallback over user-facing validation failures
- Respect Discord thread-name constraints

## Recommended Approach

Implement a small in-repo session naming helper instead of adding a third-party slug package.

This is the best fit for the current repository because the required behavior is narrow:

- one optional slash-command field
- one deterministic normalization path for user input
- one lightweight random fallback generator

An internal helper keeps the generated naming style under direct control, avoids introducing a new runtime dependency for a very small feature, and makes tests simpler because the generator can be injected or stubbed at the command-handling boundary.

## User Experience

### Explicit Name

- The user runs `/session-new name: deploy-war-room cwd: ...`.
- If the command is invoked from a parent channel, the bot creates a Discord thread titled `deploy-war-room`.
- If the command is invoked from an existing thread, the bot keeps using that thread and does not attempt a rename.
- The bot persists `deploy-war-room` in the session context.
- The bot's session summary embed shows the display name alongside the session id and runtime settings.

### Generated Name

- The user runs `/session-new cwd: ...` without `name`.
- The bot generates a short adjective-noun slug such as `pretty-fire`.
- If the bot creates a new thread for the command, it uses that generated title.
- The same generated value is stored in the session context and displayed in the summary embed.

## Data Model

### Session Context

Add an optional `displayName?: string` field to `SessionContext` in `src/shared/domain/session.ts`.

This field remains optional so existing persisted `context_json` rows continue to decode without any database migration. New sessions created after this feature lands should always populate `displayName`.

### No Database Schema Migration

The `sessions` table already stores `context_json`. Because the display name lives inside `SessionContext`, no SQL schema migration is needed.

That keeps the change low-risk and lets restart recovery, replay, HTTP transport, and repository reads continue to work through the existing context serialization path.

## Naming Rules

### Normalization of User Input

The naming helper should expose a normalization path for optional user input.

Expected behavior:

- trim leading and trailing whitespace
- collapse repeated internal whitespace
- convert spaces and obvious separators into single hyphens
- normalize to lower-case kebab-case output
- remove leading or trailing hyphens after normalization
- truncate the final thread-safe value to Discord's thread-name limit before thread creation

If a provided value normalizes to an empty string, treat it as absent and fall back to generated naming instead of surfacing a user-facing error.

The session metadata should store the same final resolved display name that is safe to reuse in UI. A practical implementation may therefore cap the resolved value to a Discord-safe maximum such as 100 characters.

### Generated Default Name

The helper should also expose a generator that builds a kebab-case `adjective-noun` slug from small internal word lists.

Requirements:

- ASCII-only output
- stable formatting: `word-word`
- short, readable, non-offensive vocabulary
- enough combinations to avoid obviously repetitive names during normal manual use

The generator does not need uniqueness guarantees across all sessions. Thread creation already occurs in Discord's normal thread creation flow, and session ids remain the true unique identifier.

## Command and Creation Flow

### Slash Command Registration

In `src/discord-control/bot.ts`, add the optional `name` string option to the `session-new` command definition.

The command should then read `value.options.getString('name')` alongside the existing `cwd`, `model`, `effort`, and `skills` options.

### Session Creation Path

The final display name should be resolved before thread creation decisions are made, then propagated forward.

Recommended flow:

1. Read the raw optional `name` value from the slash command.
2. Resolve the final display name through a shared naming helper before `ensureThreadChannel(...)` decides whether to create or reuse a thread.
3. If the command is creating a new thread, use the resolved display name as the thread title.
4. Pass the resolved display name into command handling.
5. Store the final display name in `SessionContext.displayName`.
6. Use the same final display name when building the summary embed.

This keeps thread naming, context persistence, and summary rendering synchronized while still respecting the current `ensureThreadChannel(...)` behavior that reuses an existing thread unchanged.

## Error Handling

- Blank or whitespace-only `name` values should not fail the command.
- Poorly formatted names should be normalized when possible.
- Names that normalize to empty should silently fall back to generated naming.
- Existing path validation and authorization failures should continue to behave exactly as they do today.

The name feature should be additive and forgiving. It should not introduce a new category of user-visible command error for ordinary input cleanup cases.

## Recovery and Compatibility

- Existing sessions without `displayName` remain valid.
- Recovery paths that read `SessionContext` continue to work because `displayName` is optional.
- New sessions always have one resolved display name from creation onward.
- Any UI surface rendering session metadata should prefer `context.displayName` when present.
- A session created from an existing thread may have a display name that differs from that thread's historical title, because reused threads are not renamed by this feature.

## File-Level Changes

### `src/discord-control/bot.ts`

- add the `name` slash-command option
- read the raw `name` value from the interaction
- resolve the final display name before thread creation
- pass the resolved value through the session creation path
- use the resolved display name when creating a new thread
- include the display name in the session summary message

### `src/discord-control/command-handlers.ts`

- accept the already resolved `displayName: string` from the caller
- write the result into `createSessionContext(...)`

### `src/shared/domain/session.ts`

- extend `SessionContext` with optional `displayName?: string`
- preserve immutable freezing behavior for the new field

### New helper module

Create a focused helper module for session naming logic.

Responsibilities:

- normalize optional user-provided names
- generate adjective-noun fallback names
- expose a single resolver that returns the final display name used for a new session
- enforce Discord-safe maximum length for thread-title usage

### `README.md`

- document that `/session-new` now supports `name`
- mention that omitted names fall back to generated slugs

## Testing Strategy

### Unit Tests for Naming Helper

Add focused tests covering:

- trimming and whitespace collapse
- kebab-case normalization
- empty-after-normalization fallback behavior
- generated-name format
- max-length handling

### Command Handler Tests

Add tests proving:

- explicit names are persisted into `SessionContext.displayName`
- the resolved display name is passed into runner session creation

Add a persistence test proving `displayName` survives `context_json` serialization and deserialization through the existing repository/database path.

The command handler is the right level to verify that the already resolved canonical display name is written into the session context.

### Discord Bot Tests

Add tests proving:

- the slash command registers the new `name` option
- explicit names become the created thread title when the bot creates a new thread
- explicit names appear in the session summary embed
- omitted names use the generated fallback in both thread creation and summary rendering
- existing thread invocation keeps using the current thread without rename while still storing and displaying the resolved display name

### Regression Scope

Run targeted tests first, then the repository's standard validation flow:

1. narrow Vitest files for touched behavior
2. `npm test`
3. `npm run build`

## Out of Scope

- uniqueness checks against existing session display names
- rename-session support after creation
- separate storage outside `SessionContext`
- introducing a new third-party slug dependency just for this feature

## Branching and Delivery

Implementation should continue in the isolated worktree at `/Users/xiwang/.config/superpowers/worktrees/remote-coding/feat-session-display-name` on branch `feat/session-display-name`.

The resulting code changes should stay focused on session naming so the eventual PR remains easy to review.
