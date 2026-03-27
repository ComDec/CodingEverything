# Discord Conversation Mode UI Tuning Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Discord conversation delivery read like continuous Claude chat: one new assistant message per user turn, clear text-vs-tools separation, and compact expandable Bash tool cards.

**Architecture:** Keep one continuous runner session per Discord thread, but reset only turn-local render state when a new user message arrives. Persist enough delivery metadata to replay the active turn safely, keep assistant text in the primary anchor only, and move tool activity into concise gray cards with on-demand detail views.

**Tech Stack:** TypeScript, discord.js, Vitest, SQLite

---

## Chunk 1: Turn-scoped delivery behavior

### Task 1: Lock one assistant anchor to each user turn without resetting Claude session context

**Files:**
- Modify: `tests/discord-control/bot.test.ts`
- Modify: `src/discord-control/bot.ts`
- Modify: `src/discord-control/render-model.ts`

- [ ] **Step 1: Write the failing concurrency and continuity tests**

Add focused tests in `tests/discord-control/bot.test.ts` for:

```ts
it('rejects a new user turn while the session is still running and keeps the current anchor active', async () => {
  expect(channel.sentContents).toContain('Assistant is still responding. Please wait.');
  expect(sendTurnCalls).toEqual(['first question']);
});

it('starts the next Discord turn on the same runner session after the previous turn completes', async () => {
  expect(sendTurnCalls).toEqual([
    { sessionId: 'session-1', prompt: 'first question' },
    { sessionId: 'session-1', prompt: 'second question' }
  ]);
});
```

- [ ] **Step 2: Run the focused bot tests to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "rejects a new user turn while the session is still running and keeps the current anchor active|starts the next Discord turn on the same runner session after the previous turn completes"`

Expected: FAIL because the bot currently accepts the new turn too loosely and does not emit the short in-progress reply.

- [ ] **Step 3: Implement the minimal turn-gating behavior**

In `src/discord-control/bot.ts` and `src/discord-control/render-model.ts`:

```ts
if (session.state === 'running') {
  await sendChannelMessage(channel, 'Assistant is still responding. Please wait.');
  return;
}

model = startNewTurn(model, value.channelId);
```

Keep the existing `sessionId` and event cursor. Only reset turn-local fields.

- [ ] **Step 4: Run the focused bot tests to verify GREEN**

Run the same command from Step 2.

Expected: PASS for both tests.

- [ ] **Step 5: Re-run the existing per-turn anchor tests**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "creates a fresh assistant message for each new user turn|uses the latest turn anchor when background subscription events arrive after a new turn starts"`

Expected: PASS and no regression in current turn-anchor behavior.

- [ ] **Step 6: Commit the task if git metadata is available**

```bash
git add tests/discord-control/bot.test.ts src/discord-control/bot.ts src/discord-control/render-model.ts
git commit -m "fix: keep Discord turns single-flight per session"
```

If the workspace still has no `.git`, skip the commit and continue.

### Task 2: Keep assistant text blue-gray and tools fully gray with compact summaries

**Files:**
- Modify: `tests/discord-control/message-renderer.test.ts`
- Modify: `tests/discord-control/bot.test.ts`
- Modify: `src/discord-control/message-renderer.ts`
- Modify: `src/discord-control/bot.ts`

- [ ] **Step 1: Write the failing renderer and tool-card tests**

Add tests for:

```ts
it('keeps assistant text separate from compact Bash tool cards', () => {
  expect(renderSessionMessage(model)[0]?.content).toBe('The directory is ready.');
});

it('renders assistant replies as blue-gray embeds instead of plain text messages', async () => {
  expect(channel.sentPayloads[0]).toEqual(expect.objectContaining({
    embeds: [expect.objectContaining({ color: 0x5f748c, description: 'Waiting for runner output.' })]
  }));
});

it('posts one concise gray tool card per tool completion using description-first summaries', async () => {
  expect(channelMessages).toContainEqual(expect.objectContaining({
    embeds: [expect.objectContaining({ description: 'Bash - Print working directory' })]
  }));
  expect(channelMessages).toContainEqual(expect.objectContaining({
    embeds: [expect.objectContaining({ description: 'Read - Open README.md' })]
  }));
});
```

- [ ] **Step 2: Run the focused renderer and bot tests to verify RED**

Run: `npx vitest run tests/discord-control/message-renderer.test.ts tests/discord-control/bot.test.ts -t "keeps assistant text separate from compact Bash tool cards|renders assistant replies as blue-gray embeds instead of plain text messages|posts one concise gray tool card per tool completion using description-first summaries"`

Expected: FAIL because assistant replies are still sent as plain text and the current tool-card path only handles Bash.

- [ ] **Step 3: Implement the minimal rendering cleanup**

In `src/discord-control/message-renderer.ts`:

```ts
return sanitized || 'Waiting for runner output.';
```

In `src/discord-control/bot.ts`, wrap assistant text in a blue-gray embed and build tool-card text from description first:

```ts
const ASSISTANT_EMBED_COLOR = 0x5f748c;

embeds: [{ color: ASSISTANT_EMBED_COLOR, description: content }]

const summary = detail.description?.trim() || detail.command?.trim() || detail.toolName;
description: `${detail.toolName} - ${summary}`
```

Generalize the delivery path so non-Bash `tool.completed` events also emit concise gray cards, while only Bash keeps the button-driven detail view.

- [ ] **Step 4: Run the focused renderer and bot tests to verify GREEN**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Re-run the existing Bash detail tests**

Run: `npx vitest run tests/discord-control/message-renderer.test.ts tests/discord-control/bot.test.ts -t "strips duplicated Bash output from the assistant reply|falls back to a compact completion message|posts collapsed Bash detail cards and reveals Bash output on demand|renders assistant replies as blue-gray embeds instead of plain text messages"`

Expected: PASS.

- [ ] **Step 6: Commit the task if git metadata is available**

```bash
git add tests/discord-control/message-renderer.test.ts tests/discord-control/bot.test.ts src/discord-control/message-renderer.ts src/discord-control/bot.ts
git commit -m "feat: separate Discord tool cards from assistant replies"
```

If the workspace still has no `.git`, skip the commit and continue.

## Chunk 2: Replay-safe tool delivery

### Task 3: Persist enough delivery metadata to avoid duplicate tool cards after replay

**Files:**
- Modify: `src/shared/db/database.ts`
- Modify: `src/shared/db/schema.ts`
- Modify: `src/shared/db/repositories.ts`
- Modify: `tests/shared/database.test.ts`
- Modify: `src/discord-control/bot.ts`
- Modify: `tests/discord-control/bot.test.ts`

- [ ] **Step 1: Write the failing persistence and replay tests**

Add tests for:

```ts
it('stores delivered tool-card ids alongside the active anchor', () => {
  expect(repositories.deliveryState.getBySessionId('session-1')).toMatchObject({
    deliveredToolCallIds: ['tool-bash-1', 'tool-read-1']
  });
});

it('adds the delivery_state delivered_tool_call_ids column when opening an older database', () => {
  expect(columns).toContain('delivered_tool_call_ids');
});

it('does not re-send the same tool cards after restart recovery', async () => {
  expect(restartedChannel.sentContents.filter((entry) => entry.includes('Bash - ') || entry.includes('Read - '))).toEqual([]);
});
```

- [ ] **Step 2: Run the focused persistence and replay tests to verify RED**

Run: `npx vitest run tests/shared/database.test.ts tests/discord-control/bot.test.ts -t "stores delivered tool-card ids alongside the active anchor|adds the delivery_state delivered_tool_call_ids column when opening an older database|does not re-send the same tool cards after restart recovery"`

Expected: FAIL because delivery state currently remembers only cursor and root message id.

- [ ] **Step 3: Implement the minimal delivery-state extension**

Extend `delivery_state` with a JSON column for delivered tool ids and thread-safe mapping code:

```ts
export type DeliveryStateRecord = Readonly<{
  sessionId: string;
  cursor: string;
  rootMessageId: string | null;
  deliveredToolCallIds: readonly string[];
  updatedAt: string;
}>;
```

Update `src/shared/db/database.ts` to backfill the new column for old databases, then update `persistDeliveryState()` / `loadPersistedRenderModel()` so replay knows which Bash and non-Bash tool cards were already delivered for the active turn.

- [ ] **Step 4: Run the focused persistence and replay tests to verify GREEN**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Re-run the existing restart-recovery tests**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "persists the current assistant anchor and continues editing it during active-turn restart recovery|replays only the current active turn when a persisted assistant anchor exists"`

Expected: PASS with the new delivery-state shape updated in assertions.

- [ ] **Step 6: Commit the task if git metadata is available**

```bash
git add src/shared/db/database.ts src/shared/db/schema.ts src/shared/db/repositories.ts tests/shared/database.test.ts src/discord-control/bot.ts tests/discord-control/bot.test.ts
git commit -m "fix: make Discord tool-card replay idempotent"
```

If the workspace still has no `.git`, skip the commit and continue.

### Task 4: Keep Bash detail actions stale-safe and concise

**Files:**
- Modify: `tests/discord-control/bot.test.ts`
- Modify: `src/discord-control/bot.ts`

- [ ] **Step 1: Write the failing stale-detail and no-output tests**

Add tests for:

```ts
it('returns a short stale-safe message when Bash detail output is unavailable', async () => {
  expect(buttonReply.updates).toEqual([
    expect.objectContaining({
      embeds: [expect.objectContaining({ description: 'Bash output is no longer available.' })]
    })
  ]);
});

it('shows No output when the Bash command completed without visible output', async () => {
  expect(buttonReply.updates[0]?.embeds?.[0]?.description).toContain('No output');
});
```

- [ ] **Step 2: Run the focused detail tests to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "returns a short stale-safe message when Bash detail output is unavailable|shows No output when the Bash command completed without visible output"`

Expected: FAIL because the current formatter emits `(no output)` and the stale copy is not locked to the new wording.

- [ ] **Step 3: Implement the minimal detail-formatting update**

Update `formatBashDetailMessage()` and the stale fallback branch:

```ts
const output = detail.output.trim().length > 0 ? detail.output : 'No output';
return `Bash output for ${label}\n\`\`\`text\n${truncateForCodeBlock(output)}\n\`\`\``;
```

Keep the stale path as exactly `Bash output is no longer available.`

- [ ] **Step 4: Run the focused detail tests to verify GREEN**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Re-run the current Bash interaction tests**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "posts collapsed Bash detail cards and reveals Bash output on demand|acknowledges stale approval buttons instead of timing out"`

Expected: PASS.

- [ ] **Step 6: Commit the task if git metadata is available**

```bash
git add tests/discord-control/bot.test.ts src/discord-control/bot.ts
git commit -m "refactor: tighten Discord Bash detail responses"
```

If the workspace still has no `.git`, skip the commit and continue.

## Chunk 3: Full verification

### Task 5: Run the project verification commands and refresh docs if behavior text changed

**Files:**
- Modify: `README.md` (only if command/behavior notes need updating)

- [ ] **Step 1: Run the Discord-focused test suite**

Run: `npx vitest run tests/discord-control/message-renderer.test.ts tests/discord-control/bot.test.ts tests/shared/database.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the full automated test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run the type/build verification**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Update the README only if the user-facing behavior description changed materially**

If needed, document:

```md
- each new Discord user message creates a fresh assistant reply card in the same session
- Bash tool activity appears as compact gray cards with clickable detail views
```

- [ ] **Step 5: Re-run the exact command affected by the README change, if any docs-triggered behavior was touched**

Run the smallest relevant verification command again.

- [ ] **Step 6: Commit the final verification/docs task only if files changed and git metadata is available**

```bash
git add README.md
git commit -m "docs: describe Discord conversation-mode delivery"
```

If the workspace still has no `.git` or `README.md` was unchanged, skip the commit and continue.
