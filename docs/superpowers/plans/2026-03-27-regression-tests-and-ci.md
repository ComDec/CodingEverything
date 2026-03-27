# Regression Tests And CI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regression tests for the session continuity failures discovered during the session-naming rollout and add a minimal CI workflow that enforces the repository's main validation commands on every push and pull request.

**Architecture:** Strengthen the existing Discord bot test suite around session creation invariants instead of inventing a separate harness, then add a single GitHub Actions workflow that runs the same validation commands used locally. Keep the test additions focused on the exact failure boundaries seen in practice: binding persistence, thread continuity, no orphan-thread regressions, and placeholder replacement on healthy event streams.

**Tech Stack:** TypeScript, Node.js, Vitest, GitHub Actions

---

## File Structure

- Modify: `tests/discord-control/bot.test.ts` - add or tighten regression coverage for binding persistence, named-session continuity, orphan-thread prevention, and placeholder replacement
- Modify: `tests/integration/tokenless-flow.test.ts` - extend only if the existing smoke integration needs one more assertion for the hardened flow
- Create: `.github/workflows/ci.yml` - minimal CI workflow that runs install, tests, build, and tokenless smoke
- Optional modify: `README.md` - short note about the canonical CI commands only if the workflow adds user-facing value worth documenting

## Chunk 1: Regression Tests For Today's Failures

### Task 1: Lock in thread-binding continuity regressions

**Files:**
- Modify: `tests/discord-control/bot.test.ts`

- [ ] **Step 1: Write the failing continuity regression test**

```ts
it('continues a named session from the first follow-up thread message', async () => {
  const events = createEventBus();
  const sendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
  const bindingMap = new Map<string, BindingRecord>();

  const bot = createDiscordControlBot({
    // existing fake deps...
    bindings: {
      getByThreadId(threadId) {
        return bindingMap.get(threadId) ?? null;
      },
      upsert(record) {
        bindingMap.set(record.threadId, record);
      },
    },
    runnerClient: {
      // fake health/listEvents/subscribeEvents/getSession
      async sendTurn(input) {
        sendTurnCalls.push(input);
      },
    },
  });

  await bot.start();
  await events.emit('interactionCreate', createCreateSessionInteraction(channel, {
    values: { cwd: '/workspace/app', model: 'sonnet', name: 'Deploy War Room' },
  }));
  await events.emit('messageCreate', createUserThreadMessage(thread, 'hi'));

  expect(channel.createdThreadNames).toEqual(['deploy-war-room']);
  expect(thread.sentMessages).toEqual([
    expect.objectContaining({
      embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })],
    }),
  ]);
  expect(sendTurnCalls).toEqual([
    { sessionId: 'session-explicit-name-1', prompt: 'hi' },
  ]);
});
```

- [ ] **Step 2: Run the bot slice to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "continues a named session from the first follow-up thread message"`
Expected: FAIL because the current suite does not yet bind together all three invariants in one regression: resolved thread title, summary display name, and first follow-up prompt routing

- [ ] **Step 3: Implement the minimal test/helper adjustments**

```ts
function createUserThreadMessage(thread: FakeThread, content: string) {
  return {
    author: { id: 'discord-user-1', bot: false },
    content,
    channelId: thread.id,
    channel: thread,
    member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
  };
}
```

Only add the smallest fake wiring needed to make the regression explicit.

- [ ] **Step 4: Run the targeted bot tests to verify GREEN**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "stores a thread binding so later thread messages continue the created session|continues a named session from the first follow-up thread message"`
Expected: PASS

- [ ] **Step 5: Commit the continuity regression slice**

```bash
git add tests/discord-control/bot.test.ts
git commit -m "test: lock in Discord session continuity regressions"
```

### Task 2: Lock in no-orphan-thread regressions

**Files:**
- Modify: `tests/discord-control/bot.test.ts`

- [ ] **Step 1: Write the failing no-orphan-thread regression test**

```ts
it('does not create a thread for an unauthorized session-new request', async () => {
  await bot.start();
  await events.emit('interactionCreate', createCreateSessionInteraction(channel, {
    values: { cwd: '/workspace/app', model: 'sonnet' },
    userId: 'discord-user-2',
    roleIds: [],
  }));

  expect(channel.createdThreadNames).toEqual([]);
});

it('does not create a thread for an invalid cwd session-new request', async () => {
  await bot.start();
  await events.emit('interactionCreate', createCreateSessionInteraction(channel, {
    values: { cwd: '/tmp/outside', model: 'sonnet' },
  }));

  expect(channel.createdThreadNames).toEqual([]);
});
```

- [ ] **Step 2: Run the unauthorized regression test to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "does not create a thread for an unauthorized session-new request|does not create a thread for an invalid cwd session-new request"`
Expected: FAIL because at least one of these exact no-thread regressions is not yet explicit as a standalone test name and assertion pair

- [ ] **Step 3: Implement the minimal test additions or assertion extraction**

Reuse the existing invalid-path scenario if possible; prefer extracting or renaming current assertions over duplicating large test setup.

- [ ] **Step 4: Run the focused bot file to verify GREEN**

Run: `npx vitest run tests/discord-control/bot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the no-orphan-thread slice**

```bash
git add tests/discord-control/bot.test.ts
git commit -m "test: cover Discord no-thread regressions"
```

### Task 3: Verify healthy-stream placeholder replacement coverage is explicit enough

**Files:**
- Modify: `tests/discord-control/bot.test.ts` only if the current suite does not already make the placeholder replacement invariant obvious

- [ ] **Step 1: Inspect the existing healthy-stream bot tests**

Read the current tests around waiting placeholders, streamed `text.delta`, and `turn.completed` behavior in `tests/discord-control/bot.test.ts`.

- [ ] **Step 2: Verify whether the current test names and assertions already cover the invariant**

The invariant to confirm is:

- a user turn can show a waiting placeholder initially
- a healthy runner event stream produces assistant text
- the placeholder is no longer the terminal visible state after streamed text and completion arrive

- [ ] **Step 3: Add one focused regression test only if that invariant is not already explicit**

```ts
it('does not leave the waiting placeholder as the terminal state after streamed text arrives', async () => {
  // create session, emit user turn, stream text.delta + turn.completed
  // assert assistant text is rendered and placeholder is no longer the terminal visible state
});
```

The test should be added only if current coverage is too implicit or too hard to understand when it fails.

- [ ] **Step 4: Run the relevant bot tests**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "uses a random waiting placeholder word before the first assistant text arrives|does not leave the waiting placeholder as the terminal state after streamed text arrives"`
Expected: PASS

- [ ] **Step 5: Commit only if the bot test file changed**

```bash
git add tests/discord-control/bot.test.ts
git commit -m "test: clarify placeholder replacement coverage"
```

If no file changed, explicitly skip this commit step.

## Chunk 2: Keep The Integration Harness Honest

### Task 4: Verify tokenless integration coverage is already sufficient

**Files:**
- Modify: `tests/integration/tokenless-flow.test.ts`

- [ ] **Step 1: Inspect the current tokenless integration assertions**

Read `tests/integration/tokenless-flow.test.ts` and confirm whether it already asserts:

- `finalState === 'idle'`
- `auditActions` includes `'discord.session.create'`
- rendered output includes successful assistant text

- [ ] **Step 2: Run the integration test as a verification checkpoint**

Run: `npx vitest run tests/integration/tokenless-flow.test.ts`
Expected: PASS if current coverage already protects the intended smoke lifecycle

- [ ] **Step 3: Add or tighten assertions only if inspection shows a real gap**

Do not force a change if the existing test already covers the intended lifecycle. If a gap exists, make the smallest assertion-only update and then re-run the file.

- [ ] **Step 4: Commit only if the integration test file changed**

```bash
git add tests/integration/tokenless-flow.test.ts
git commit -m "test: strengthen tokenless smoke expectations"
```

If no file changed, explicitly skip this commit step.

## Chunk 3: Minimal CI Workflow

### Task 5: Add the repository CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Optional modify: `README.md`

- [ ] **Step 1: Write the failing workflow expectations as a local checklist**

The workflow must run exactly these commands in order:

1. `npm test`
2. `npm run build`
3. `npm run smoke:tokenless`

If you document CI in `README.md`, keep it to one short bullet and do not expand scope beyond those commands.

- [ ] **Step 2: Add the minimal workflow file**

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm install
      - run: npm test
      - run: npm run build
      - run: npm run smoke:tokenless
```

- [ ] **Step 3: Add a brief README note only if it adds user value**

```md
- CI runs `npm test`, `npm run build`, and `npm run smoke:tokenless` on pushes and pull requests.
```

Skip this step if it feels redundant with the existing command documentation.

- [ ] **Step 4: Verify workflow file shape locally**

Run: `python3 - <<'PY'
from pathlib import Path
print(Path('.github/workflows/ci.yml').read_text())
PY`
Expected: workflow file exists and contains push/pull_request plus the three required commands

- [ ] **Step 5: Commit the CI slice**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: add repository validation workflow"
```

## Chunk 4: Final Verification

### Task 5: Verify the hardened workflow locally

**Files:**
- Verify: `tests/discord-control/bot.test.ts`
- Verify: `tests/integration/tokenless-flow.test.ts`
- Verify: `.github/workflows/ci.yml`

- [ ] **Step 1: Run targeted regression tests**

Run: `npx vitest run tests/discord-control/bot.test.ts tests/integration/tokenless-flow.test.ts`
Expected: PASS

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Run the build gate**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Run the tokenless smoke flow**

Run: `npm run smoke:tokenless`
Expected: PASS

- [ ] **Step 5: Inspect final scope**

Run: `git diff --stat $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)...HEAD`
Expected: changes limited to regression tests, optional smoke assertions, optional brief docs note, and `.github/workflows/ci.yml`
