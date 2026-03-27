# Discord Conversation Mode UI Design

## Goal

Refine the existing Discord conversation delivery so each user question produces a new assistant reply message while still preserving one continuous Claude session underneath.

The Discord presentation must clearly separate primary assistant text from tool activity. Main assistant replies should render as blue-gray message cards, while tool activity should render as compact gray cards with expandable details.

## Confirmed UX Requirements

1. Session startup and follow-up conversation must remain normal and continuous.
2. Each new user message must create a new assistant reply message in Discord.
3. Replies must stay within the same Claude session so prior context is preserved.
4. Main text replies and tool output must be visually distinct.
5. Main text replies use a blue-gray card style.
6. Tool output uses a fully gray card style.
7. Tool cards stay very concise in the default collapsed state.
8. Bash output must be available on click without polluting the main reply stream.

## Design Principles

- Continuous runtime session, per-turn Discord rendering
- One user turn maps to one assistant reply anchor
- Assistant text is the answer; tool cards are process metadata
- Tool details are opt-in, not inline by default
- Keep Discord history readable during multi-turn conversations
- Reuse the current architecture instead of introducing a new message pipeline

## Recommended Approach

Continue the current per-turn render model and finish the separation already started in `src/discord-control/render-model.ts`, `src/discord-control/message-renderer.ts`, and `src/discord-control/bot.ts`.

This is the lowest-risk path because the repository already contains the right building blocks:

- turn-scoped render state
- Bash detail capture
- button-driven Bash detail access
- per-turn anchor reset support

The work should focus on tightening the rendering contract, ensuring new turns always get a fresh assistant anchor, and keeping tool cards compact.

## Interaction Model

### Session Continuity

- A Discord thread still maps to one internal session.
- That internal session still maps to one Claude session.
- `sendTurn()` continues targeting the same runtime session id for every follow-up turn.
- Prior conversation context therefore stays available to Claude.

### Per-Turn Assistant Replies

- When the user sends a new thread message, the bot starts a new render turn.
- Starting a new turn must create a fresh assistant anchor in Discord.
- Streaming text for that turn only updates the current turn's assistant anchor.
- Older assistant replies remain visible as prior conversation history and are never overwritten by later turns.

### Concurrent Turn Rule

- The runtime remains single-turn per session.
- If a new user message arrives while the previous turn is still running, the bot should not start a second turn on the same session.
- Instead, the bot should send a very short status reply telling the user the previous turn is still in progress.
- A fresh assistant anchor is created only after the session is ready to accept the next `sendTurn()`.
- Because new turns are only created after the previous turn is complete or blocked on an explicit prompt, late text or tool events remain attached to the existing active turn and cannot drift onto the next turn's anchor.

### Text vs Tools Separation

- The assistant message represents only answer text.
- Tool execution is rendered separately from answer text.
- Tool output must not be embedded into the primary assistant card by default.
- If the assistant text repeats Bash output verbatim, that repeated output should be stripped from the assistant message when the same content exists in a tool detail record.

## Render State Model

The session render model should keep two layers of state.

### Session-Level State

This state survives across turns:

- `sessionId`
- thread binding
- event cursor / last consumed sequence
- persisted delivery checkpoint data

### Turn-Level State

This state resets when a new user turn begins:

- current assistant text buffer
- current turn anchor message id
- tool call lookup for the active turn
- current turn Bash detail cards
- current turn prompt rendering state

`startNewTurn()` must reset only turn-level rendering fields. It must not reset session identity or event cursor state.

## Discord Card Semantics

### Assistant Text Card

- Purpose: show the answer to the user's current question
- Style: blue-gray visual treatment
- Content: only assistant text for the current turn
- Behavior: created once per user turn, then edited as text streams in

If the current turn has no assistant text yet, the placeholder should stay very short, such as `Waiting for runner output.`

### Tool Card

- Purpose: show that a tool ran without flooding the thread
- Style: fully gray visual treatment
- Scope: one card per tool call, not one merged card per turn
- Default content: `tool name + one-line summary`

All tools follow the same family of card semantics. Bash gets the richest detail view because its output is the main artifact the user asked to inspect.

For Bash specifically, the collapsed card should prefer:

1. tool `description`, if present
2. a short derived summary from the command, if no description exists

The collapsed card should not include:

- full stdout
- full stderr
- long command bodies
- repeated assistant prose

## Bash Detail Expansion

- Each Bash tool card gets a clickable detail action.
- Clicking it reveals the full Bash detail view.
- The detail view should show, in order: summary or command, status, and full output.
- Long output may be chunked only inside the detail view.
- If no output exists, the detail view should say `No output`.
- If the detail record is stale or unavailable, the user should get a very short fallback such as `Bash output is no longer available.`

Failed Bash executions should keep the same card family and interaction model. The only difference is the summary/status content.

### Non-Bash Tool Behavior

- `tool.started` should update internal turn-local metadata only; it does not need to emit a user-visible card immediately.
- `tool.completed` for non-Bash tools should still produce a compact gray tool card so the user can see that tool activity occurred.
- Non-Bash cards should stay summary-only unless the runtime already provides a compact structured detail that is safe to show.
- Failed non-Bash tools should still render a gray card with a short failure summary.
- No tool event, Bash or otherwise, should be folded into the main assistant text card by default.

## Event and Delivery Flow

### On New User Message

1. Resolve the bound session for the Discord thread.
2. Sync the session render model from runner events.
3. Start a new turn in the render model.
4. Emit or prepare a fresh assistant anchor for the new turn.
5. Send the user's message to the existing runner session with `sendTurn()`.
6. Stream and apply new runtime events to only the active turn.

### On Text Events

- Append only to the active turn text buffer.
- Re-render only the current turn assistant anchor.

### On Tool Events

- Track started tools for summary metadata.
- When a Bash tool completes, append a new turn-local tool card entry.
- Deliver a separate gray tool card for that tool call.
- When a non-Bash tool completes, append a separate gray tool card entry with compact summary text.
- Failed tool completions should still create a concise tool card for visibility.
- In-progress tool events stay internal unless future UX explicitly adds a running-state card.

### On Next User Turn

- Preserve all previously delivered Discord messages.
- Reset only turn-local render state.
- Create a new assistant anchor for the next reply.

## Restart and Replay Expectations

- Startup recovery must continue to reconstruct the active session state from persisted events.
- Recovery should not accidentally create a new runtime session for ordinary follow-up conversation.
- Replay logic should rebuild the active turn display state without collapsing prior turns into one giant assistant message.
- Persisted delivery state should track the current active assistant anchor plus the set of already-delivered tool-card identifiers for the active turn.
- If recovery finds `assistant anchor created but not fully updated`, replay should continue editing that anchor rather than creating a duplicate.
- If recovery finds `tool card delivered but detail record missing`, the card may remain visible but its action must degrade to a short stale-safe message.
- If Discord send or edit fails after runner events have already advanced, replay must retry idempotently using persisted anchor and delivered-tool metadata instead of emitting duplicate cards.

## File-Level Implementation Targets

### `src/discord-control/render-model.ts`

- tighten the distinction between session-level state and turn-level state
- ensure `startNewTurn()` resets only turn-local presentation fields
- keep Bash detail accumulation scoped to the current turn

### `src/discord-control/message-renderer.ts`

- keep assistant rendering limited to answer text
- continue stripping duplicate Bash output from the answer body
- keep placeholder and chunking behavior compact and predictable

### `src/discord-control/bot.ts`

- create one fresh assistant anchor per user question
- never reuse a prior turn's assistant anchor for a later turn
- emit one concise tool card per Bash tool completion
- keep button-driven detail access intact and short in the default view

### `tests/discord-control/message-renderer.test.ts`

- verify text and tools stay separated
- verify duplicate Bash output is removed from the assistant text card
- verify a new turn clears only turn-local display state

### `tests/discord-control/bot.test.ts`

- verify a new user message creates a new assistant reply anchor
- verify repeated turns stay on the same session id
- verify each Bash call produces its own compact tool card
- verify detail actions return full output and stale-safe fallback text

## Error Handling

- Missing tool details should degrade to a short stale message rather than a noisy failure.
- Empty output should still open successfully with `No output`.
- Button interactions for stale or already-cleared details should remain safe and idempotent.
- If Discord delivery fails mid-turn, the bot should preserve the render model so the active turn can be retried or replayed.
- If Discord delivery fails after a tool card was already recorded as delivered, replay should not send that same card twice.
- If Discord delivery fails before a card or anchor is recorded as delivered, replay may send it once when state is reconstructed.

## Testing Strategy

Follow TDD for the remaining implementation work.

Minimum validation coverage:

- renderer tests for text/tool separation
- bot tests for per-turn message creation
- bot tests for same-session follow-up turns
- bot tests for compact tool cards and expandable Bash details
- existing suite regression coverage via `npm test`
- type validation via `npm run build`

## Non-Goals

- Replacing the current Discord control architecture
- Introducing a new generic message bus abstraction
- Reworking permission prompts into the same visual bucket as assistant replies
- Reopening the underlying Claude session for every user turn
