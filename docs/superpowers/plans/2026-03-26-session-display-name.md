# Session Display Name Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `/session-new name` parameter that persists a canonical session display name and falls back to a generated adjective-noun slug when omitted.

**Architecture:** Resolve the final display name once in the Discord command flow before thread creation, then pass that resolved string through command handling into `SessionContext.displayName`. Keep naming logic isolated in a dedicated helper so normalization, fallback generation, and Discord-safe truncation are tested independently and reused consistently.

**Tech Stack:** TypeScript, Node.js, `discord.js`, `better-sqlite3`, Vitest

---

## File Structure

- Create: `src/discord-control/session-display-name.ts` - normalize optional user input, generate adjective-noun fallback names, and resolve the final Discord-safe display name
- Modify: `src/shared/domain/session.ts` - add optional `displayName` to `SessionContext` and preserve immutability
- Modify: `src/discord-control/command-handlers.ts` - accept resolved `displayName` during session creation and persist it into session context
- Modify: `src/discord-control/bot.ts` - register `/session-new name`, resolve display names before thread creation, use them in thread titles and summary embeds
- Modify: `README.md` - document the new `name` option and generated fallback behavior
- Test: `tests/shared/session-domain.test.ts`
- Test: `tests/shared/database.test.ts`
- Test: `tests/discord-control/command-handlers.test.ts`
- Test: `tests/discord-control/bot.test.ts`
- Test: `tests/discord-control/session-display-name.test.ts`

## Chunk 1: Naming Helper and Session Contract

### Task 1: Add display-name helper with TDD

**Files:**
- Create: `src/discord-control/session-display-name.ts`
- Test: `tests/discord-control/session-display-name.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  generateSessionDisplayName,
  normalizeSessionDisplayName,
  resolveSessionDisplayName,
} from '../../src/discord-control/session-display-name.js';

describe('normalizeSessionDisplayName', () => {
  it('normalizes mixed separators into kebab-case', () => {
    expect(normalizeSessionDisplayName('  Pretty   Fire_room  ')).toBe('pretty-fire-room');
  });

  it('returns null when normalization removes all content', () => {
    expect(normalizeSessionDisplayName('---___   ')).toBeNull();
  });

  it('truncates long names to a Discord-safe length', () => {
    expect(normalizeSessionDisplayName('A'.repeat(150))?.length).toBeLessThanOrEqual(100);
  });
});

describe('resolveSessionDisplayName', () => {
  it('uses the normalized explicit name when present', () => {
    expect(resolveSessionDisplayName({ rawName: 'Deploy War Room' })).toBe('deploy-war-room');
  });

  it('falls back to the generator when the name is missing or blank', () => {
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(resolveSessionDisplayName({ rawName: '   ', random })).toBe('pretty-fire');
  });
});

describe('generateSessionDisplayName', () => {
  it('builds an adjective-noun slug', () => {
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(generateSessionDisplayName(random)).toBe('pretty-fire');
  });
});
```

- [ ] **Step 2: Run the helper test to verify RED**

Run: `npx vitest run tests/discord-control/session-display-name.test.ts`
Expected: FAIL with missing module or missing exports from `src/discord-control/session-display-name.ts`

- [ ] **Step 3: Write the minimal helper implementation**

```ts
const MAX_DISPLAY_NAME_LENGTH = 100;
const ADJECTIVES = ['pretty', 'brisk', 'steady', 'bright'];
const NOUNS = ['fire', 'river', 'cloud', 'field'];

export function normalizeSessionDisplayName(rawName?: string | null): string | null {
  if (!rawName) {
    return null;
  }

  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .replace(/-+$/g, '');

  return normalized.length > 0 ? normalized : null;
}

export function resolveSessionDisplayName(input: {
  rawName?: string | null;
  random?: () => number;
}): string {
  return normalizeSessionDisplayName(input.rawName) ?? generateSessionDisplayName(input.random);
}

export function generateSessionDisplayName(random: () => number = Math.random): string {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] ?? ADJECTIVES[0];
  const noun = NOUNS[Math.floor(random() * NOUNS.length)] ?? NOUNS[0];
  return `${adjective}-${noun}`;
}
```

- [ ] **Step 4: Run the helper test to verify GREEN**

Run: `npx vitest run tests/discord-control/session-display-name.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the helper slice**

```bash
git add tests/discord-control/session-display-name.test.ts src/discord-control/session-display-name.ts
git commit -m "feat: add session display name resolver"
```

### Task 2: Persist display names in session context

**Files:**
- Modify: `src/shared/domain/session.ts`
- Test: `tests/shared/session-domain.test.ts`
- Test: `tests/shared/database.test.ts`

- [ ] **Step 1: Write the failing session-domain test**

```ts
it('preserves displayName on immutable session context', () => {
  const context = createSessionContext({
    cwd: '/workspace/app',
    allowedRoot: '/workspace',
    model: 'sonnet',
    runtimeOptions: { permissionMode: 'default' },
    createdBy: 'discord-user-1',
    displayName: 'pretty-fire',
  });

  expect(context.displayName).toBe('pretty-fire');
});
```

- [ ] **Step 2: Run the session-domain test to verify RED**

Run: `npx vitest run tests/shared/session-domain.test.ts -t "preserves displayName on immutable session context"`
Expected: FAIL because `displayName` is not part of `SessionContext`

- [ ] **Step 3: Add the minimal session-domain implementation**

```ts
export type SessionContext = Readonly<{
  cwd: string;
  allowedRoot: string;
  model: string;
  runtimeOptions: SessionRuntimeOptions;
  createdBy: string;
  displayName?: string;
}>;

export function createSessionContext(input: {
  cwd: string;
  allowedRoot: string;
  model: string;
  runtimeOptions: SessionRuntimeOptions;
  createdBy: string;
  displayName?: string;
}): SessionContext {
  return Object.freeze({
    cwd: input.cwd,
    allowedRoot: input.allowedRoot,
    model: input.model,
    runtimeOptions: Object.freeze({
      ...input.runtimeOptions,
      ...(input.runtimeOptions.skills
        ? { skills: Object.freeze([...input.runtimeOptions.skills]) }
        : {}),
    }),
    createdBy: input.createdBy,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
}
```

- [ ] **Step 4: Re-run the session-domain test to verify GREEN**

Run: `npx vitest run tests/shared/session-domain.test.ts -t "preserves displayName on immutable session context"`
Expected: PASS

- [ ] **Step 5: Write the failing database round-trip test**

```ts
it('round-trips displayName through session context_json storage', () => {
  const database = createDatabase({ filename: ':memory:' });
  const repositories = createRepositories(database);

  repositories.sessions.insert({
    id: 'session-1',
    state: SessionState.idle,
    runtimeSessionId: null,
    context: createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1',
      displayName: 'pretty-fire',
    }),
    createdAt: '2026-03-26T00:00:00.000Z',
    updatedAt: '2026-03-26T00:00:00.000Z',
  });

  expect(repositories.sessions.getById('session-1')?.context.displayName).toBe('pretty-fire');
});
```

- [ ] **Step 6: Run the database test to verify RED**

Run: `npx vitest run tests/shared/database.test.ts -t "round-trips displayName through session context_json storage"`
Expected: FAIL until the new context field is exercised end-to-end

- [ ] **Step 7: Adjust any minimal serialization code needed and verify GREEN**

Run: `npx vitest run tests/shared/session-domain.test.ts tests/shared/database.test.ts`
Expected: PASS

- [ ] **Step 8: Commit the session-contract slice**

```bash
git add tests/shared/session-domain.test.ts tests/shared/database.test.ts src/shared/domain/session.ts
git commit -m "feat: persist session display names"
```

## Chunk 2: Command Flow and Discord UI

### Task 3: Persist resolved display names in command handling

**Files:**
- Modify: `src/discord-control/command-handlers.ts`
- Test: `tests/discord-control/command-handlers.test.ts`

- [ ] **Step 1: Write the failing command-handler test**

```ts
it('writes the resolved display name into session context', async () => {
  const { repositories } = createTestContext();
  const runnerClient = createRunnerClientDouble({
    createSessionResult: { sessionId: 'session-name-1' },
  });

  const handlers = createCommandHandlers({
    runnerClient,
    audit: repositories.audit,
    access: { canManageSessions: () => true },
    allowedRoots: ['/workspace'],
    now: () => '2026-03-25T00:00:00.000Z',
  });

  await handlers.handleCreateSession({
    channelId: 'thread-name-1',
    cwd: '/workspace/app',
    model: 'sonnet',
    displayName: 'pretty-fire',
    userId: 'discord-user-1',
    roleIds: ['operator'],
  });

  expect(runnerClient.createSessionCalls.at(-1)?.context.displayName).toBe('pretty-fire');
});
```

- [ ] **Step 2: Run the command-handler test to verify RED**

Run: `npx vitest run tests/discord-control/command-handlers.test.ts -t "writes the resolved display name into session context"`
Expected: FAIL because `displayName` is not accepted by `handleCreateSession`

- [ ] **Step 3: Implement the minimal command-handler change**

```ts
async handleCreateSession(input: {
  channelId: string;
  cwd: string;
  model: string;
  displayName: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills?: readonly string[];
  userId: string;
  roleIds: string[];
}): Promise<{ sessionId: string }> {
  // existing checks...
  const session = await deps.runnerClient.createSession({
    channelId: input.channelId,
    context: createSessionContext({
      cwd,
      allowedRoot,
      model: input.model,
      runtimeOptions: {
        permissionMode: 'default',
        ...(effort ? { effort } : {}),
        ...(skills.length > 0 ? { skills } : {}),
      },
      createdBy: input.userId,
      displayName: input.displayName,
    }),
  });
```

- [ ] **Step 4: Re-run the command-handler test to verify GREEN**

Run: `npx vitest run tests/discord-control/command-handlers.test.ts -t "writes the resolved display name into session context"`
Expected: PASS

- [ ] **Step 5: Commit the command-handler slice**

```bash
git add tests/discord-control/command-handlers.test.ts src/discord-control/command-handlers.ts
git commit -m "feat: pass display names into session creation"
```

### Task 4: Add `/session-new name` and thread-title usage in the bot

**Files:**
- Modify: `src/discord-control/bot.ts`
- Modify: `src/discord-control/command-handlers.ts`
- Modify: `README.md`
- Test: `tests/discord-control/bot.test.ts`

Note: this task also extends the bot dependency type with an optional `random?: () => number` so tests can deterministically assert generated fallback names.

- [ ] **Step 1: Write the failing bot test for explicit names**

```ts
it('uses the resolved display name for new thread creation and summary rendering', async () => {
  const interaction = createCreateSessionInteraction(channel, {
    values: { cwd: '/workspace/app', model: 'sonnet', name: 'Deploy War Room' },
  });

  await bot.start();
  await events.emit('interactionCreate', interaction);

  expect(channel.createdThreadNames).toEqual(['deploy-war-room']);
  expect(thread.sentMessages).toEqual([
    expect.objectContaining({
      embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })],
    }),
  ]);
});
```

- [ ] **Step 2: Run the explicit-name bot test to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "uses the resolved display name for new thread creation and summary rendering"`
Expected: FAIL because the command lacks `name`, the thread name is still hardcoded, and the summary does not show a display name

- [ ] **Step 3: Write the failing bot test for generated fallback names**

```ts
it('falls back to a generated display name when name is omitted', async () => {
  const interaction = createCreateSessionInteraction(channel, {
    values: { cwd: '/workspace/app', model: 'sonnet' },
  });

  const bot = createDiscordControlBot({
    // existing deps...
    random: vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0),
  });

  await bot.start();
  await events.emit('interactionCreate', interaction);

  expect(channel.createdThreadNames).toEqual(['pretty-fire']);
});
```

- [ ] **Step 4: Run the fallback bot test to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "falls back to a generated display name when name is omitted"`
Expected: FAIL because no generation hook exists yet

- [ ] **Step 5: Write the failing reused-thread regression test before implementation**

```ts
it('keeps an existing thread title unchanged while still storing the resolved display name', async () => {
  const existingThread = createFakeThread('thread-existing');
  const interaction = createCreateSessionInteraction(existingThread as any, {
    values: { cwd: '/workspace/app', model: 'sonnet', name: 'Deploy War Room' },
  });

  await bot.start();
  await events.emit('interactionCreate', interaction);

  expect(existingThread.sentMessages).toEqual([
    expect.objectContaining({
      embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })],
    }),
  ]);
});
```

- [ ] **Step 6: Run the reused-thread regression test to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "keeps an existing thread title unchanged while still storing the resolved display name"`
Expected: FAIL because the summary does not yet include `name`

- [ ] **Step 7: Write the failing command-registration assertion**

```ts
const registeredCommands: Array<{ name: string; options: Array<{ name: string }> }> = [];

registerCommands: async (commands) => {
  registerCalls.push(commands.map((command) => command.name));
  registeredCommands.push(...commands.map((command) => ({
    name: command.name,
    options: (command.options ?? []).map((option) => ({ name: option.name })),
  })));
}

expect(registerCalls[0]).toEqual(['session-new']);
expect(registeredCommands[0]?.options.map((option) => option.name)).toContain('name');
```

- [ ] **Step 8: Run the command-registration assertion to verify RED**

Run: `npx vitest run tests/discord-control/bot.test.ts -t "logs in, registers commands, and creates a thread-backed session from a slash command"`
Expected: FAIL because the registered command options do not include `name`

- [ ] **Step 9: Implement the minimal bot changes**

```ts
import { resolveSessionDisplayName } from './session-display-name.js';

const COMMANDS = [
  {
    name: 'session-new',
    description: 'Create a Claude runner session in a thread',
    options: [
      { type: 'string', name: 'name', description: 'Optional session display name', required: false },
      { type: 'string', name: 'cwd', description: 'Working directory', required: true },
      // existing options...
    ],
  },
];

const displayName = resolveSessionDisplayName({
  rawName: value.options.getString('name'),
  random: deps.random,
});
const thread = await ensureThreadChannel(sourceChannel, displayName);
const session = await deps.handlers.handleCreateSession({
  channelId: thread.id,
  cwd: value.options.getString('cwd') ?? process.cwd(),
  model: value.options.getString('model') ?? 'sonnet',
  displayName,
  userId: value.user.id,
  roleIds: getRoleIds(value.member),
});
```

- [ ] **Step 10: Update summary rendering and thread creation behavior**

```ts
type DiscordControlBotDeps = Readonly<{
  // existing deps...
  random?: () => number;
}>;

const random = deps.random ?? Math.random;

function buildSessionSummaryMessage(input: {
  sessionId: string;
  displayName: string;
  cwd: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills: readonly string[];
}) {
  const lines = [
    `Session ${input.sessionId}`,
    `name: ${input.displayName}`,
    `cwd: ${input.cwd}`,
    `model: ${input.model}`,
    `effort: ${input.effort ?? 'default'}`,
    `skills: ${input.skills.length > 0 ? input.skills.join(', ') : 'none'}`,
  ];
}

async function ensureThreadChannel(channel: unknown, threadName: string): Promise<CreatedThreadChannel> {
  if (isThreadChannel(channel)) {
    return channel;
  }

  return maybeChannel.threads.create({ name: threadName });
}
```

- [ ] **Step 11: Run the bot test file to verify GREEN**

Run: `npx vitest run tests/discord-control/bot.test.ts`
Expected: PASS

- [ ] **Step 12: Update docs and re-run focused tests**

Run: `npx vitest run tests/discord-control/session-display-name.test.ts tests/shared/session-domain.test.ts tests/shared/database.test.ts tests/discord-control/command-handlers.test.ts tests/discord-control/bot.test.ts`
Expected: PASS

- [ ] **Step 13: Commit the bot-and-docs slice**

```bash
git add tests/discord-control/bot.test.ts tests/discord-control/session-display-name.test.ts tests/shared/session-domain.test.ts tests/shared/database.test.ts tests/discord-control/command-handlers.test.ts src/discord-control/bot.ts src/discord-control/command-handlers.ts src/discord-control/session-display-name.ts src/shared/domain/session.ts README.md
git commit -m "feat: support custom session display names"
```

## Chunk 3: Full Verification

### Task 5: Run repository validation before completion

**Files:**
- Modify: `README.md`
- Verify: `src/discord-control/bot.ts`
- Verify: `src/discord-control/command-handlers.ts`
- Verify: `src/shared/domain/session.ts`
- Verify: `src/discord-control/session-display-name.ts`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS with all repository tests green

- [ ] **Step 2: Run the type/build gate**

Run: `npm run build`
Expected: PASS with no TypeScript errors

- [ ] **Step 3: Run the tokenless smoke flow**

Run: `npm run smoke:tokenless`
Expected: PASS with session creation still working end-to-end without Discord transport

- [ ] **Step 4: Inspect git diff for scope control**

Run: `git diff -- src/discord-control/bot.ts src/discord-control/command-handlers.ts src/discord-control/session-display-name.ts src/shared/domain/session.ts tests/discord-control/bot.test.ts tests/discord-control/command-handlers.test.ts tests/discord-control/session-display-name.test.ts tests/shared/session-domain.test.ts tests/shared/database.test.ts README.md`
Expected: Only session display name changes and supporting tests/docs

- [ ] **Step 5: Prepare PR-ready branch state**

Run: `git status --short`
Expected: only intended files are modified or staged
