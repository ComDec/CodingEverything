# Discord Claude Runner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-machine Discord-controlled Claude runner with persistent sessions, streaming output, in-chat approvals, and restart-aware persistence.

**Architecture:** The codebase is a single TypeScript repository with two entrypoints: `discord-control` and `local-runner`. Shared domain types, persistence, and protocol contracts live in `src/shared`, while the runner exposes a localhost HTTP plus SSE API and the Discord service projects runner events into thread-based Discord UX.

**Tech Stack:** Node.js 25, TypeScript, `discord.js`, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `zod`, `vitest`, Docker Compose

---

## File Structure

- Create: `package.json` - workspace manifest, scripts, runtime dependencies
- Create: `tsconfig.json` - shared TypeScript config
- Create: `vitest.config.ts` - test runner setup
- Create: `.env.example` - Discord token, runner port, SQLite path, allowed roots, Claude API config
- Create: `src/shared/domain/session.ts` - session state enums, immutable session context, prompt matching rules
- Create: `src/shared/domain/events.ts` - normalized internal event schema and payload types
- Create: `src/shared/contracts/runner-api.ts` - request/response DTOs for runner HTTP API
- Create: `src/shared/config.ts` - env parsing with Zod
- Create: `src/shared/db/database.ts` - SQLite connection and setup
- Create: `src/shared/db/schema.ts` - schema bootstrap SQL for sessions, bindings, prompts, events, delivery state, audit
- Create: `src/shared/db/repositories.ts` - focused repository layer with clear ownership helpers
- Create: `src/shared/security.ts` - path normalization, safe-root enforcement, RBAC helpers
- Create: `src/shared/health.ts` - service health and counters contracts
- Create: `src/shared/audit.ts` - audit event builders for sensitive actions
- Create: `src/local-runner/runtime/runtime-adapter.ts` - generic runtime capability and prompt contracts
- Create: `src/local-runner/runtime/claude-sdk-adapter.ts` - Claude SDK integration
- Create: `src/local-runner/runtime/claude-event-normalizer.ts` - maps SDK messages to internal events
- Create: `src/local-runner/session-orchestrator.ts` - session lifecycle, locking, prompt persistence, degraded recovery rules
- Create: `src/local-runner/recovery.ts` - restart replay, degraded recovery markers, startup-order tolerant resume helpers
- Create: `src/local-runner/event-stream.ts` - per-session event pub/sub for SSE
- Create: `src/local-runner/http-server.ts` - localhost HTTP and SSE server
- Create: `src/local-runner/index.ts` - runner bootstrap
- Create: `src/discord-control/runner-client.ts` - local runner HTTP/SSE client
- Create: `src/discord-control/session-router.ts` - Discord thread to session mapping
- Create: `src/discord-control/render-model.ts` - deterministic delivery projection state
- Create: `src/discord-control/message-renderer.ts` - chunking, debounce, prompt cards, replay-aware rendering
- Create: `src/discord-control/replay-controller.ts` - replay from `last_consumed_event_seq + 1` and active prompt refresh
- Create: `src/discord-control/startup-recovery.ts` - reload bindings, restore anchors, and surface runner-unavailable startup state
- Create: `src/discord-control/command-handlers.ts` - slash command and interaction handlers
- Create: `src/discord-control/bot.ts` - Discord client wiring
- Create: `src/discord-control/index.ts` - Discord bootstrap
- Create: `src/smoke/runner-smoke.ts` - local non-Discord validation script for Claude runtime using Sonnet
- Create: `src/smoke/claude-sdk-spike.ts` - explicit installed-SDK validation for init, resume, permission, question, and interrupt semantics
- Create: `src/smoke/tokenless-harness.ts` - local feasibility harness for runner plus Discord projection without a bot token
- Create: `tests/shared/session-domain.test.ts`
- Create: `tests/shared/database.test.ts`
- Create: `tests/shared/security.test.ts`
- Create: `tests/shared/audit.test.ts`
- Create: `tests/local-runner/session-orchestrator.test.ts`
- Create: `tests/local-runner/http-server.test.ts`
- Create: `tests/local-runner/claude-sdk-adapter.test.ts`
- Create: `tests/local-runner/recovery.test.ts`
- Create: `tests/discord-control/message-renderer.test.ts`
- Create: `tests/discord-control/session-router.test.ts`
- Create: `tests/discord-control/command-handlers.test.ts`
- Create: `tests/discord-control/replay-controller.test.ts`
- Create: `tests/discord-control/startup-recovery.test.ts`
- Create: `tests/integration/tokenless-flow.test.ts`
- Create: `tests/support/fake-runtime.ts`
- Create: `tests/support/fake-discord.ts`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `README.md`

## Chunk 1: Foundation and Shared Contracts

### Task 1: Bootstrap Repository and Shared Domain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/shared/domain/session.ts`
- Create: `src/shared/domain/events.ts`
- Create: `src/shared/contracts/runner-api.ts`
- Create: `src/shared/config.ts`
- Test: `tests/shared/session-domain.test.ts`

- [ ] **Step 1: Write the failing shared-domain tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildSessionApprovalMatcher,
  createSessionContext,
  SessionState,
} from '../../src/shared/domain/session';

describe('createSessionContext', () => {
  it('freezes immutable session context for recovery and audit', () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1',
    });

    expect(context.cwd).toBe('/workspace/app');
    expect(context.allowedRoot).toBe('/workspace');
    expect(context.model).toBe('sonnet');
  });
});

describe('buildSessionApprovalMatcher', () => {
  it('downgrades session approvals when scope is not normalizable', () => {
    const matcher = buildSessionApprovalMatcher({
      toolName: 'Bash',
      promptKind: 'permission',
      targetScope: undefined,
    });

    expect(matcher.scope).toBe('once');
  });
});

describe('SessionState', () => {
  it('includes recovery-aware states', () => {
    expect(SessionState.awaitingPermission).toBe('awaiting_permission');
    expect(SessionState.recovering).toBe('recovering');
  });
});
```

- [ ] **Step 2: Run the shared-domain tests to verify RED**

Run: `npm test -- tests/shared/session-domain.test.ts`
Expected: FAIL with missing module or missing exports from `src/shared/domain/session.ts`

- [ ] **Step 3: Write the minimal shared domain implementation**

```ts
export const SessionState = {
  created: 'created',
  idle: 'idle',
  running: 'running',
  awaitingPermission: 'awaiting_permission',
  awaitingUserAnswer: 'awaiting_user_answer',
  interrupting: 'interrupting',
  completed: 'completed',
  failed: 'failed',
  recovering: 'recovering',
  closed: 'closed',
} as const;

export function createSessionContext(input: CreateSessionContextInput): SessionContext {
  return Object.freeze({
    cwd: input.cwd,
    allowedRoot: input.allowedRoot,
    model: input.model,
    runtimeOptions: input.runtimeOptions,
    createdBy: input.createdBy,
  });
}

export function buildSessionApprovalMatcher(input: ApprovalMatcherInput): ApprovalMatcher {
  if (!input.targetScope) {
    return { scope: 'once' };
  }

  return {
    scope: 'session',
    toolName: input.toolName,
    promptKind: input.promptKind,
    targetScope: input.targetScope,
  };
}
```

- [ ] **Step 4: Run the shared-domain tests to verify GREEN**

Run: `npm test -- tests/shared/session-domain.test.ts`
Expected: PASS

- [ ] **Step 5: Add configuration and API contract tests first**

```ts
import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../../src/shared/config';

describe('parseAppConfig', () => {
  it('parses allowed roots and defaults the model to sonnet', () => {
    const config = parseAppConfig({
      DISCORD_TOKEN: 'token',
      DISCORD_CLIENT_ID: 'client',
      RUNNER_DATABASE_PATH: './var/app.db',
      ALLOWED_ROOTS: '/workspace,/tmp/project',
    });

    expect(config.allowedRoots).toEqual(['/workspace', '/tmp/project']);
    expect(config.claudeModel).toBe('sonnet');
  });
});
```

- [ ] **Step 6: Run the config tests to verify RED**

Run: `npm test -- tests/shared/session-domain.test.ts`
Expected: FAIL with missing `parseAppConfig`

- [ ] **Step 7: Implement `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, and `src/shared/config.ts` minimally**

```json
{
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "runner": "tsx src/local-runner/index.ts",
    "discord": "tsx src/discord-control/index.ts",
    "smoke:runner": "tsx src/smoke/runner-smoke.ts"
  }
}
```

```ts
const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  RUNNER_DATABASE_PATH: z.string().min(1),
  ALLOWED_ROOTS: z.string().min(1),
  CLAUDE_MODEL: z.string().default('sonnet'),
});
```

- [ ] **Step 8: Run all shared tests to verify GREEN**

Run: `npm test -- tests/shared/session-domain.test.ts`
Expected: PASS

- [ ] **Step 9: Add support-file tests first for fake runtime and fake Discord harnesses**

```ts
import { describe, expect, it } from 'vitest';
import { createFakeRuntimeAdapter } from '../support/fake-runtime';

describe('createFakeRuntimeAdapter', () => {
  it('can script permission, question, and completion events deterministically', async () => {
    const runtime = createFakeRuntimeAdapter({
      script: ['permission.requested', 'question.asked', 'turn.completed'],
    });

    expect(runtime.capabilities.supportsStructuredPermissions).toBe(true);
    expect(runtime.capabilities.supportsStructuredQuestions).toBe(true);
  });
});
```

- [ ] **Step 10: Run the support-file tests to verify RED, then implement `tests/support/fake-runtime.ts` and `tests/support/fake-discord.ts` minimally**

Run: `npm test -- tests/shared/session-domain.test.ts`
Expected: FAIL until support modules exist

- [ ] **Step 11: Re-run all foundation tests to verify GREEN**

Run: `npm test -- tests/shared/session-domain.test.ts`
Expected: PASS

- [ ] **Step 12: Commit the foundation bootstrap if this becomes a git repo later**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/shared tests/shared
git commit -m "feat: bootstrap shared runner domain"
```

### Task 2: Add SQLite Schema and Repository Layer

**Files:**
- Create: `src/shared/db/database.ts`
- Create: `src/shared/db/schema.ts`
- Create: `src/shared/db/repositories.ts`
- Create: `src/shared/security.ts`
- Create: `src/shared/health.ts`
- Create: `src/shared/audit.ts`
- Test: `tests/shared/database.test.ts`
- Test: `tests/shared/security.test.ts`
- Test: `tests/shared/audit.test.ts`

- [ ] **Step 1: Write the failing database tests**

```ts
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/shared/db/database';

describe('database bootstrap', () => {
  it('creates the sessions and delivery_state tables', () => {
    const db = createDatabase(':memory:');

    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = rows.map((row: { name: string }) => row.name);

    expect(names).toContain('sessions');
    expect(names).toContain('delivery_state');
  });
});
```

- [ ] **Step 2: Run the database tests to verify RED**

Run: `npm test -- tests/shared/database.test.ts`
Expected: FAIL with missing `createDatabase`

- [ ] **Step 3: Implement the minimal schema and database bootstrap**

```ts
export function createDatabase(filename: string) {
  const db = new Database(filename);
  db.exec(schemaSql);
  return db;
}
```

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  runtime_type TEXT NOT NULL,
  runtime_session_id TEXT,
  state TEXT NOT NULL,
  recovery_status TEXT,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL
);
```

- [ ] **Step 4: Run the database tests to verify GREEN**

Run: `npm test -- tests/shared/database.test.ts`
Expected: PASS

- [ ] **Step 5: Add repository tests first for session inserts and prompt persistence**

```ts
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/shared/db/database';
import { createRepositories } from '../../src/shared/db/repositories';

describe('repositories', () => {
  it('persists a session and a pending permission', () => {
    const db = createDatabase(':memory:');
    const repos = createRepositories(db);

    repos.sessions.insert({
      id: 'session-1',
      runtimeType: 'claude',
      state: 'created',
      cwd: '/workspace/app',
      model: 'sonnet',
    });

    repos.prompts.insertPendingPermission({
      id: 'prompt-1',
      sessionId: 'session-1',
      requestPayload: { toolName: 'Bash' },
    });

    expect(repos.sessions.getById('session-1')?.model).toBe('sonnet');
    expect(repos.prompts.getPendingPrompt('prompt-1')?.status).toBe('pending');
  });
});
```

- [ ] **Step 6: Run the repository tests to verify RED**

Run: `npm test -- tests/shared/database.test.ts`
Expected: FAIL with missing `createRepositories`

- [ ] **Step 7: Implement the minimal repositories**

```ts
export function createRepositories(db: Database.Database) {
  return {
    sessions: {
      insert(input: SessionRowInput) { /* prepared insert */ },
      getById(id: string) { /* prepared select */ },
    },
    bindings: {
      upsert(input: DiscordBindingInput) { /* insert or replace */ },
      getByThreadId(threadId: string) { /* select */ },
    },
    prompts: {
      insertPendingPermission(input: PendingPromptInput) { /* insert */ },
      insertPendingQuestion(input: PendingPromptInput) { /* insert */ },
      getPendingPrompt(id: string) { /* select */ },
    },
    deliveryState: {
      save(input: DeliveryStateInput) { /* insert or replace */ },
      getBySessionId(sessionId: string) { /* select */ },
    },
    events: {
      append(event: PersistedEventInput) { /* insert */ },
      listAfter(sessionId: string, sequence: number) { /* select */ },
    },
    audit: {
      append(entry: AuditEntryInput) { /* insert */ },
    },
  };
}
```

- [ ] **Step 8: Add failing security tests for safe-root validation and stale approvals**

```ts
import { describe, expect, it } from 'vitest';
import { assertSafeWorkingDirectory, isPromptExpired } from '../../src/shared/security';

describe('security helpers', () => {
  it('rejects paths outside allowed roots', () => {
    expect(() => assertSafeWorkingDirectory('/etc', ['/workspace'])).toThrow(/allowed root/);
  });

  it('expires stale prompts after the configured window', () => {
    expect(isPromptExpired('2026-03-25T00:00:00.000Z', 60_000, new Date('2026-03-25T00:02:00.000Z'))).toBe(true);
  });
});
```

- [ ] **Step 9: Run the security tests to verify RED**

Run: `npm test -- tests/shared/security.test.ts`
Expected: FAIL with missing security helpers

- [ ] **Step 10: Implement `src/shared/security.ts` and `src/shared/health.ts` minimally**

```ts
export function assertSafeWorkingDirectory(cwd: string, allowedRoots: string[]) {
  const normalized = path.resolve(cwd);
  const allowed = allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error(`Working directory must stay within an allowed root: ${normalized}`);
  return normalized;
}
```

- [ ] **Step 11: Add failing audit-log tests for sensitive actions**

```ts
import { describe, expect, it } from 'vitest';
import { buildAuditEntry } from '../../src/shared/audit';

describe('buildAuditEntry', () => {
  it('records approvals with actor, session, and payload metadata', () => {
    const entry = buildAuditEntry({
      actorType: 'discord_user',
      actorId: 'discord-user-1',
      sessionId: 'session-1',
      action: 'permission.approved',
      payload: { promptId: 'prompt-1', toolName: 'Bash' },
    });

    expect(entry.action).toBe('permission.approved');
    expect(entry.actorId).toBe('discord-user-1');
  });
});
```

- [ ] **Step 12: Run the audit tests to verify RED**

Run: `npm test -- tests/shared/audit.test.ts`
Expected: FAIL with missing `buildAuditEntry`

- [ ] **Step 13: Implement `src/shared/audit.ts` minimally**

```ts
export function buildAuditEntry(input: BuildAuditEntryInput) {
  return {
    actorType: input.actorType,
    actorId: input.actorId,
    sessionId: input.sessionId,
    action: input.action,
    payload: input.payload,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 14: Run all shared tests to verify GREEN**

Run: `npm test -- tests/shared/*.test.ts`
Expected: PASS

- [ ] **Step 15: Commit the shared persistence layer if git is available**

```bash
git add src/shared/db tests/shared
git commit -m "feat: add SQLite persistence for runner state"
```

## Chunk 2: Local Runner and Claude Runtime

### Task 3: Build the Session Orchestrator and Runner HTTP API

**Files:**
- Create: `src/local-runner/runtime/runtime-adapter.ts`
- Create: `src/local-runner/session-orchestrator.ts`
- Create: `src/local-runner/recovery.ts`
- Create: `src/local-runner/event-stream.ts`
- Create: `src/local-runner/http-server.ts`
- Create: `src/local-runner/index.ts`
- Test: `tests/local-runner/session-orchestrator.test.ts`
- Test: `tests/local-runner/http-server.test.ts`
- Test: `tests/local-runner/recovery.test.ts`

- [ ] **Step 1: Write the failing orchestrator tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionOrchestrator } from '../../src/local-runner/session-orchestrator';
import { createFakeRuntimeAdapter } from '../support/fake-runtime';

describe('session orchestrator', () => {
  it('blocks a turn when a permission prompt is unresolved', async () => {
    const runtime = createFakeRuntimeAdapter({
      script: ['permission.requested', 'permission.resolved', 'turn.completed'],
    });
    const orchestrator = createSessionOrchestrator({ runtime });

    const session = await orchestrator.createSession({
      cwd: '/workspace/app',
      model: 'sonnet',
      createdBy: 'discord-user-1',
    });

    const turn = orchestrator.sendTurn(session.id, 'run tests');
    await expect(orchestrator.waitForState(session.id)).resolves.toBe('awaiting_permission');

    await orchestrator.resolvePrompt({ promptId: 'prompt-1', resolution: 'allow_once' });
    await turn;

    expect(await orchestrator.waitForState(session.id)).toBe('idle');
  });

  it('records a recovery marker when a running stream cannot be reattached', async () => {
    const runtime = createFakeRuntimeAdapter({ failResumeWhileRunning: true });
    const orchestrator = createSessionOrchestrator({ runtime });
    const session = await orchestrator.createSession({ cwd: '/workspace/app', model: 'sonnet', createdBy: 'discord-user-1' });

    await orchestrator.markRecovering(session.id);
    const result = await orchestrator.recoverSession(session.id);

    expect(result.recoveryStatus).toBe('recovery_uncertain');
  });
});
```

- [ ] **Step 2: Run the orchestrator tests to verify RED**

Run: `npm test -- tests/local-runner/session-orchestrator.test.ts`
Expected: FAIL with missing orchestrator module

- [ ] **Step 3: Implement the minimal runtime contract, recovery helper, and orchestrator**

```ts
export interface RuntimeAdapter {
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionHandle>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSessionHandle>;
  sendTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  resolvePrompt(input: ResolveRuntimePromptInput): Promise<void>;
  interrupt(input: InterruptRuntimeTurnInput): Promise<void>;
  closeSession(input: CloseRuntimeSessionInput): Promise<void>;
  subscribeEvents?(sessionId: string): AsyncIterable<RuntimeEvent>;
}
```

```ts
export function createSessionOrchestrator(deps: SessionOrchestratorDeps) {
  return {
    async createSession(input) { /* persist context + create runtime session */ },
    async sendTurn(sessionId, prompt) { /* lock, emit events, persist prompts */ },
    async resolvePrompt(input) { /* idempotent prompt resolution */ },
    async answerQuestion(input) { /* persist answer and resume runtime */ },
    async interrupt(sessionId) { /* transition to interrupting */ },
    async closeSession(sessionId) { /* close runtime and mark closed */ },
    async recoverSession(sessionId) { /* replay persisted state and degrade honestly */ },
  };
}
```

- [ ] **Step 4: Run the orchestrator tests to verify GREEN**

Run: `npm test -- tests/local-runner/session-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing HTTP API tests**

```ts
import { describe, expect, it } from 'vitest';
import { startRunnerServer } from '../../src/local-runner/http-server';

describe('runner HTTP API', () => {
  it('creates a session through POST /sessions', async () => {
    const server = await startRunnerServer({ port: 0, runtime: createFakeRuntimeAdapter() });
    const response = await fetch(`${server.origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/workspace/app', model: 'sonnet', createdBy: 'discord-user-1' }),
    });

    expect(response.status).toBe(201);
  });

  it('returns health status and exposes close and answer endpoints', async () => {
    const server = await startRunnerServer({ port: 0, runtime: createFakeRuntimeAdapter() });

    const health = await fetch(`${server.origin}/health`);
    expect(health.status).toBe(200);
  });
});
```

- [ ] **Step 6: Run the HTTP tests to verify RED**

Run: `npm test -- tests/local-runner/http-server.test.ts`
Expected: FAIL with missing `startRunnerServer`

- [ ] **Step 7: Implement the minimal localhost HTTP + SSE server**

```ts
POST /sessions
GET /sessions/:id
POST /sessions/:id/turns
POST /prompts/:id/resolve
POST /questions/:id/answer
POST /sessions/:id/interrupt
POST /sessions/:id/close
GET /sessions/:id/events
GET /health
```

Use Node's built-in `http` server unless a framework becomes necessary.

- [ ] **Step 8: Add failing recovery tests for startup-order tolerance and pending prompt restoration**

```ts
import { describe, expect, it } from 'vitest';
import { recoverRunnerState } from '../../src/local-runner/recovery';

describe('recoverRunnerState', () => {
  it('restores pending permissions and emits synthetic recovery events', async () => {
    const result = await recoverRunnerState({
      sessions: [{ id: 'session-1', state: 'awaiting_permission' }],
      prompts: [{ id: 'prompt-1', sessionId: 'session-1', status: 'pending' }],
    });

    expect(result.syntheticEvents[0]?.type).toBe('permission.requested');
  });
});
```

- [ ] **Step 9: Run the recovery tests to verify RED**

Run: `npm test -- tests/local-runner/recovery.test.ts`
Expected: FAIL with missing recovery helpers

- [ ] **Step 10: Implement `src/local-runner/recovery.ts` minimally**

```ts
export async function recoverRunnerState(input: RecoverRunnerStateInput) {
  return {
    syntheticEvents: input.prompts.map((prompt) => ({
      type: 'permission.requested',
      sequence: 0,
      promptId: prompt.id,
      sessionId: prompt.sessionId,
    })),
  };
}
```

- [ ] **Step 11: Run the local-runner tests to verify GREEN**

Run: `npm test -- tests/local-runner/session-orchestrator.test.ts tests/local-runner/http-server.test.ts tests/local-runner/recovery.test.ts`
Expected: PASS

- [ ] **Step 12: Commit the runner service layer if git is available**

```bash
git add src/local-runner tests/local-runner
git commit -m "feat: add local runner orchestrator and API"
```

### Task 4: Integrate the Claude SDK Adapter with Prompt Handling

**Files:**
- Create: `src/local-runner/runtime/claude-sdk-adapter.ts`
- Create: `src/local-runner/runtime/claude-event-normalizer.ts`
- Create: `src/smoke/claude-sdk-spike.ts`
- Create: `src/smoke/runner-smoke.ts`
- Test: `tests/local-runner/claude-sdk-adapter.test.ts`

- [ ] **Step 1: Write the failing Claude adapter tests**

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { createClaudeSdkAdapter } from '../../src/local-runner/runtime/claude-sdk-adapter';

describe('Claude SDK adapter', () => {
  it('creates a persistent sonnet session and emits normalized text deltas', async () => {
    const adapter = createClaudeSdkAdapter({ model: 'sonnet' });
    const session = await adapter.createSession({ cwd: '/workspace/app', createdBy: 'discord-user-1' });

    expect(session.runtimeType).toBe('claude');
    expect(session.model).toBe('sonnet');
  });

  it('surfaces permission requests, AskUserQuestion prompts, and resume metadata', async () => {
    const adapter = createClaudeSdkAdapter({ model: 'sonnet' });
    expect(adapter.capabilities.supportsStructuredPermissions).toBe(true);
    expect(adapter.capabilities.supportsStructuredQuestions).toBe(true);
    expect(adapter.capabilities.supportsResume).toBe(true);
  });
});
```

- [ ] **Step 2: Run the Claude adapter tests to verify RED**

Run: `npm test -- tests/local-runner/claude-sdk-adapter.test.ts`
Expected: FAIL with missing `createClaudeSdkAdapter`

- [ ] **Step 3: Implement the minimal Claude adapter using `query()`**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const stream = query({
  prompt,
  options: {
    cwd,
    model: 'sonnet',
    persistSession: true,
    includePartialMessages: true,
    canUseTool: permissionBroker,
    toolConfig: {
      askUserQuestion: { previewFormat: 'markdown' },
    },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project'],
  },
});
```

Also add one contained integration spike script in the adapter test harness that validates the installed SDK version and the shape of:

- `system/init` session messages
- partial text events
- tool permission callback invocation
- resume via `options.resume`
- interrupt support if available through the `Query` handle

The spike is its own executable file with explicit pass/fail criteria:

- file: `src/smoke/claude-sdk-spike.ts`
- command: `CLAUDE_MODEL=sonnet npm run smoke:runner -- --sdk-spike`
- pass: logs the installed SDK version, captures one init event, proves one resume path, and either proves permission/question callback wiring or exits with a clear actionable failure message
- fail: non-zero exit with the missing SDK behavior called out explicitly

- [ ] **Step 4: Run the Claude adapter tests to verify GREEN**

Run: `npm test -- tests/local-runner/claude-sdk-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Add a smoke script test first for local validation wiring**

```ts
import { describe, expect, it } from 'vitest';
import { buildSmokePrompt } from '../../src/smoke/runner-smoke';

describe('buildSmokePrompt', () => {
  it('requests a minimal read-only sonnet validation turn', () => {
    expect(buildSmokePrompt()).toContain('Return a one-line confirmation');
  });

  it('includes an explicit no-edit instruction to conserve tokens and risk', () => {
    expect(buildSmokePrompt()).toContain('Do not edit any files');
  });
});
```

- [ ] **Step 6: Run the smoke-script tests to verify RED**

Run: `npm test -- tests/local-runner/claude-sdk-adapter.test.ts`
Expected: FAIL with missing `buildSmokePrompt`

- [ ] **Step 7: Implement `src/smoke/runner-smoke.ts` for manual feasibility validation**

```ts
export function buildSmokePrompt() {
  return 'List the files in the current working directory. Do not edit any files. Return a one-line confirmation only.';
}
```

Run manually when `ANTHROPIC_API_KEY` is present:

`npm run smoke:runner`

Use `CLAUDE_MODEL=sonnet` by default to conserve cost.

- [ ] **Step 8: Add one resume-focused manual validation command**

Run manually when `ANTHROPIC_API_KEY` is present:

`CLAUDE_MODEL=sonnet npm run smoke:runner -- --resume-check`

Expected: the second turn resumes the first session and reports the same session id or a clearly logged resume path

- [ ] **Step 9: Run the explicit SDK spike locally when `ANTHROPIC_API_KEY` is present**

Run: `CLAUDE_MODEL=sonnet npm run smoke:runner -- --sdk-spike`
Expected: PASS with explicit logs for init, resume, and prompt callback support; otherwise a crisp failure message that blocks shipping the adapter

- [ ] **Step 10: Run the full local-runner suite to verify GREEN**

Run: `npm test -- tests/local-runner/*.test.ts`
Expected: PASS

- [ ] **Step 11: Commit the Claude adapter if git is available**

```bash
git add src/local-runner/runtime src/smoke tests/local-runner
git commit -m "feat: integrate Claude SDK runner adapter"
```

## Chunk 3: Discord Control Plane, Deployment, and Validation

### Task 5: Build Discord Routing and Delivery Projection

**Files:**
- Create: `src/discord-control/runner-client.ts`
- Create: `src/discord-control/session-router.ts`
- Create: `src/discord-control/render-model.ts`
- Create: `src/discord-control/replay-controller.ts`
- Create: `src/discord-control/startup-recovery.ts`
- Create: `src/discord-control/message-renderer.ts`
- Test: `tests/discord-control/session-router.test.ts`
- Test: `tests/discord-control/message-renderer.test.ts`
- Test: `tests/discord-control/replay-controller.test.ts`
- Test: `tests/discord-control/startup-recovery.test.ts`

- [ ] **Step 1: Write the failing session-router tests**

```ts
import { describe, expect, it } from 'vitest';
import { createSessionRouter } from '../../src/discord-control/session-router';

describe('session router', () => {
  it('maps a Discord thread to a runner session', () => {
    const router = createSessionRouter();
    router.bindThread({ threadId: 'thread-1', sessionId: 'session-1' });

    expect(router.getSessionIdForThread('thread-1')).toBe('session-1');
  });
});
```

- [ ] **Step 2: Run the router tests to verify RED**

Run: `npm test -- tests/discord-control/session-router.test.ts`
Expected: FAIL with missing router implementation

- [ ] **Step 3: Implement the minimal router and delivery projection model**

```ts
export function createSessionRouter() {
  const bindings = new Map<string, string>();
  return {
    bindThread(input: { threadId: string; sessionId: string }) {
      bindings.set(input.threadId, input.sessionId);
    },
    getSessionIdForThread(threadId: string) {
      return bindings.get(threadId);
    },
  };
}
```

- [ ] **Step 4: Write the failing renderer tests**

```ts
import { describe, expect, it } from 'vitest';
import { projectRunnerEvents } from '../../src/discord-control/render-model';

describe('projectRunnerEvents', () => {
  it('replays text deltas deterministically into a root status body', () => {
    const view = projectRunnerEvents([
      { type: 'turn.started', sequence: 1 },
      { type: 'text.delta', sequence: 2, delta: 'hello' },
      { type: 'text.delta', sequence: 3, delta: ' world' },
    ]);

    expect(view.latestText).toBe('hello world');
  });

  it('tracks active permission prompts and root anchor state', () => {
    const view = projectRunnerEvents([
      { type: 'permission.requested', sequence: 1, promptId: 'prompt-1' },
    ] as any);

    expect(view.activePromptId).toBe('prompt-1');
  });
});
```

- [ ] **Step 5: Run the renderer tests to verify RED**

Run: `npm test -- tests/discord-control/message-renderer.test.ts`
Expected: FAIL with missing projection code

- [ ] **Step 6: Implement the minimal renderer and chunking rules**

```ts
export function projectRunnerEvents(events: RunnerEvent[]) {
  return events.reduce(
    (view, event) => {
      if (event.type === 'text.delta') view.latestText += event.delta;
      if (event.type === 'permission.requested') view.activePrompt = event.promptId;
      return view;
    },
    { latestText: '', activePromptId: null, lastConsumedEventSeq: 0 },
  );
}
```

- [ ] **Step 7: Add failing replay-controller tests for restart replay and stale-button idempotency**

```ts
import { describe, expect, it } from 'vitest';
import { replayFromCheckpoint } from '../../src/discord-control/replay-controller';

describe('replayFromCheckpoint', () => {
  it('replays from last_consumed_event_seq + 1 and rebuilds prompt state', () => {
    const result = replayFromCheckpoint({
      checkpoint: { lastConsumedEventSeq: 1 },
      events: [
        { type: 'text.delta', sequence: 1, delta: 'skip' },
        { type: 'text.delta', sequence: 2, delta: 'replay' },
      ],
    } as any);

    expect(result.view.latestText).toBe('replay');
  });
});
```

- [ ] **Step 8: Run the replay tests to verify RED**

Run: `npm test -- tests/discord-control/replay-controller.test.ts`
Expected: FAIL with missing replay controller

- [ ] **Step 9: Implement `src/discord-control/replay-controller.ts` minimally**

```ts
export function replayFromCheckpoint(input: ReplayInput) {
  const remaining = input.events.filter((event) => event.sequence > input.checkpoint.lastConsumedEventSeq);
  return { view: projectRunnerEvents(remaining) };
}
```

- [ ] **Step 10: Run the Discord projection tests to verify GREEN**

Run: `npm test -- tests/discord-control/session-router.test.ts tests/discord-control/message-renderer.test.ts tests/discord-control/replay-controller.test.ts`
Expected: PASS

- [ ] **Step 11: Add failing startup-recovery tests for bot restart and runner-unavailable startup**

```ts
import { describe, expect, it } from 'vitest';
import { recoverDiscordControlStartup } from '../../src/discord-control/startup-recovery';

describe('recoverDiscordControlStartup', () => {
  it('reloads bindings, restores root anchors, and marks sessions unavailable when runner is down', async () => {
    const result = await recoverDiscordControlStartup({
      bindings: [{ threadId: 'thread-1', sessionId: 'session-1', rootMessageId: 'message-1' }],
      runnerAvailable: false,
    });

    expect(result.sessions[0]?.status).toBe('runner_unavailable');
    expect(result.sessions[0]?.rootMessageId).toBe('message-1');
  });
});
```

- [ ] **Step 12: Run the startup-recovery tests to verify RED**

Run: `npm test -- tests/discord-control/startup-recovery.test.ts`
Expected: FAIL with missing startup recovery module

- [ ] **Step 13: Implement `src/discord-control/startup-recovery.ts` minimally**

```ts
export async function recoverDiscordControlStartup(input: RecoverDiscordStartupInput) {
  return {
    sessions: input.bindings.map((binding) => ({
      sessionId: binding.sessionId,
      threadId: binding.threadId,
      rootMessageId: binding.rootMessageId,
      status: input.runnerAvailable ? 'reconnected' : 'runner_unavailable',
    })),
  };
}
```

- [ ] **Step 14: Re-run the Discord projection and startup tests to verify GREEN**

Run: `npm test -- tests/discord-control/session-router.test.ts tests/discord-control/message-renderer.test.ts tests/discord-control/replay-controller.test.ts tests/discord-control/startup-recovery.test.ts`
Expected: PASS

- [ ] **Step 15: Commit the Discord projection layer if git is available**

```bash
git add src/discord-control tests/discord-control
git commit -m "feat: add Discord routing and delivery projection"
```

### Task 6: Add Discord Commands, Interaction Handling, and Local Validation

**Files:**
- Create: `src/discord-control/command-handlers.ts`
- Create: `src/discord-control/bot.ts`
- Create: `src/discord-control/index.ts`
- Create: `src/smoke/tokenless-harness.ts`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `README.md`
- Test: `tests/discord-control/command-handlers.test.ts`
- Test: `tests/integration/tokenless-flow.test.ts`

- [ ] **Step 1: Write the failing command-handler tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createCommandHandlers } from '../../src/discord-control/command-handlers';

describe('command handlers', () => {
  it('creates a runner session for /session new', async () => {
    const runnerClient = { createSession: vi.fn().mockResolvedValue({ id: 'session-1' }) };
    const handlers = createCommandHandlers({ runnerClient: runnerClient as any });

    const result = await handlers.handleCreateSession({
      cwd: '/workspace/app',
      model: 'sonnet',
      userId: 'discord-user-1',
    });

    expect(result.sessionId).toBe('session-1');
  });

  it('answers questions and resolves stale prompt clicks idempotently', async () => {
    const runnerClient = {
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      resolvePrompt: vi.fn().mockResolvedValue({ status: 'already_resolved' }),
    };
    const handlers = createCommandHandlers({ runnerClient: runnerClient as any });

    await handlers.handleAnswerQuestion({ promptId: 'question-1', answer: 'yes', userId: 'discord-user-1' });
    const result = await handlers.handleResolvePrompt({ promptId: 'prompt-1', resolution: 'allow_once', userId: 'discord-user-1' });

    expect(result.status).toBe('already_resolved');
  });

  it('rejects unauthorized session creation attempts', async () => {
    const runnerClient = { createSession: vi.fn() };
    const handlers = createCommandHandlers({
      runnerClient: runnerClient as any,
      access: { canManageSessions: () => false },
    } as any);

    await expect(
      handlers.handleCreateSession({ cwd: '/workspace/app', model: 'sonnet', userId: 'discord-user-2', roleIds: [] }),
    ).rejects.toThrow(/not authorized/);
  });
});
```

- [ ] **Step 2: Run the command-handler tests to verify RED**

Run: `npm test -- tests/discord-control/command-handlers.test.ts`
Expected: FAIL with missing handler implementation

- [ ] **Step 3: Implement the minimal command handlers and bot bootstrap**

```ts
export function createCommandHandlers(deps: CommandHandlerDeps) {
  return {
    async handleCreateSession(input: CreateSessionCommandInput) {
      if (!deps.access.canManageSessions(input)) throw new Error('User is not authorized to create sessions');
      const session = await deps.runnerClient.createSession(input);
      return { sessionId: session.id };
    },
    async handleResolvePrompt(input: ResolvePromptCommandInput) {
      await deps.runnerClient.resolvePrompt(input);
    },
  };
}
```

Use `discord.js` for:

- slash command registration
- thread creation
- button interactions for approvals
- message event handling inside session threads
- root status message anchors and debounced edits
- question-button vs free-text reply handling

- [ ] **Step 4: Run the command-handler tests to verify GREEN**

Run: `npm test -- tests/discord-control/command-handlers.test.ts`
Expected: PASS

- [ ] **Step 5: Add deployment and manual validation docs first**

```md
# Validation

1. Start runner: `npm run runner`
2. Start Discord bot: `npm run discord`
3. If `DISCORD_TOKEN` is missing, commands should fail fast with a clear config error.
4. For Claude validation, prefer `CLAUDE_MODEL=sonnet npm run smoke:runner`
5. For token-free validation, run `npm test -- tests/integration/tokenless-flow.test.ts`
```

- [ ] **Step 6: Add a failing token-free integration test first**

```ts
import { describe, expect, it } from 'vitest';
import { runTokenlessFlow } from '../../src/smoke/tokenless-harness';

describe('runTokenlessFlow', () => {
  it('simulates create -> turn -> permission -> approve -> complete without a Discord token', async () => {
    const result = await runTokenlessFlow();
    expect(result.finalState).toBe('idle');
    expect(result.rendered.latestText.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run the token-free integration test to verify RED**

Run: `npm test -- tests/integration/tokenless-flow.test.ts`
Expected: FAIL with missing tokenless harness

- [ ] **Step 8: Implement `src/smoke/tokenless-harness.ts`, then add `Dockerfile`, `docker-compose.yml`, and `README.md` minimally**

Include:

- one service for runner
- one service for Discord control
- shared mounted SQLite volume
- environment variables for Discord token and Claude API key
- instructions for token-free validation before adding the Discord bot token

- [ ] **Step 9: Run the token-free integration test to verify GREEN**

Run: `npm test -- tests/integration/tokenless-flow.test.ts`
Expected: PASS

- [ ] **Step 10: Confirm audit writes in the Discord command path**

Add one more expectation in `tests/discord-control/command-handlers.test.ts` that session creation, approval, interrupt, and close flows append audit entries through the shared audit helper or repository.

- [ ] **Step 11: Run the full test suite to verify GREEN**

Run: `npm test`
Expected: PASS with all shared, runner, and Discord tests green

- [ ] **Step 12: Run local feasibility validation commands**

Run: `npm run build`
Expected: PASS

Run: `CLAUDE_MODEL=sonnet npm run smoke:runner`
Expected: a minimal Claude response if `ANTHROPIC_API_KEY` is present; otherwise a clean config error that explains what is missing

Run: `node --test` is not required; `vitest` remains the single test entrypoint

Run: `npm test -- tests/integration/tokenless-flow.test.ts`
Expected: PASS without `DISCORD_TOKEN`

Run after token is provided: `npm run discord`
Expected: Discord bot logs in and registers commands successfully

- [ ] **Step 13: Commit the Discord entrypoint and deployment docs if git is available**

```bash
git add src/discord-control Dockerfile docker-compose.yml README.md tests/discord-control
git commit -m "feat: add Discord control plane for Claude runner"
```
