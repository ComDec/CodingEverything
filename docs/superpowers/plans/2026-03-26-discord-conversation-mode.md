# Discord Conversation Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Discord thread UX from a single ever-growing status message into per-turn assistant replies, with Bash output hidden behind explicit detail actions.

**Architecture:** Keep the existing runner/session model, but change Discord delivery from one session-wide anchor to one anchor per active turn. Extend runtime events to capture Bash tool input/output so the bot can post a compact system card and reveal details on demand without polluting the main assistant reply.

**Tech Stack:** TypeScript, discord.js, Claude Agent SDK, Vitest, SQLite

---

### Task 1: Add tool events and per-turn render model

**Files:**
- Modify: `src/shared/domain/events.ts`
- Modify: `src/local-runner/runtime/claude-sdk-adapter.ts`
- Modify: `src/local-runner/runtime/claude-event-normalizer.ts`
- Modify: `src/discord-control/render-model.ts`
- Modify: `src/discord-control/message-renderer.ts`
- Test: `tests/discord-control/message-renderer.test.ts`
- Test: `tests/local-runner/claude-sdk-adapter.test.ts`

- [ ] Write failing adapter/renderer tests for Bash tool input-output events, per-turn assistant messages, and hidden detail cards
- [ ] Run focused tests to verify RED
- [ ] Implement minimal Claude tool event normalization and turn-scoped render state
- [ ] Re-run focused tests to verify GREEN

### Task 2: Switch bot delivery to one assistant message per user turn

**Files:**
- Modify: `src/discord-control/bot.ts`
- Modify: `tests/discord-control/bot.test.ts`

- [ ] Write failing bot tests showing a new assistant anchor is created for each user message
- [ ] Run bot tests to verify RED
- [ ] Implement minimal turn reset / active assistant anchor behavior
- [ ] Re-run bot tests to verify GREEN

### Task 3: Add Bash detail buttons and stale-safe interaction handling

**Files:**
- Modify: `src/discord-control/bot.ts`
- Modify: `tests/discord-control/bot.test.ts`

- [ ] Write failing bot tests for `View Bash Output` interactions
- [ ] Run bot tests to verify RED
- [ ] Implement minimal detail-card and detail-view interaction flow
- [ ] Re-run bot tests to verify GREEN

### Task 4: Verify end-to-end locally and in Discord

**Files:**
- Modify: `README.md`

- [ ] Run focused tests plus full suite
- [ ] Run `npm run build`
- [ ] Re-run live Discord flow and verify per-turn replies / Bash detail view
