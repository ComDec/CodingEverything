import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/shared/db/database.js';
import { createRepositories } from '../../src/shared/db/repositories.js';
import { SessionState, createSessionContext } from '../../src/shared/domain/session.js';
import type { RuntimeEvent } from '../../src/shared/domain/events.js';
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps
} from '../../src/local-runner/session-orchestrator.js';
import type {
  RuntimeAdapter,
  RuntimeSessionHandle,
  RuntimeTurnPromptResolution
} from '../../src/local-runner/runtime/runtime-adapter.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('session orchestrator', () => {
  it('blocks a turn when a permission prompt is unresolved and resumes after resolution', async () => {
    const runtime = createFakeRuntimeAdapter([
      { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' },
      { type: 'turn.completed', exitCode: 0 }
    ]);
    const orchestrator = createOrchestrator(runtime);

    const session = await orchestrator.createSession({
      channelId: 'thread-1',
      context: createContext('discord-user-1')
    });

    const turn = orchestrator.sendTurn(session.sessionId, 'run tests');

    await expect(waitForState(orchestrator, session.sessionId)).resolves.toBe(
      SessionState.awaitingPermission
    );
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      sessionId: 'session-1',
      state: SessionState.awaitingPermission
    });
    expect(orchestrator.getPendingPrompt(session.sessionId)).toMatchObject({
      id: 'prompt-1',
      kind: 'permission',
      payload: {
        requestId: 'perm-1',
        prompt: 'Allow write?'
      }
    });

    await orchestrator.resolvePrompt({
      promptId: 'prompt-1',
      resolution: 'allow_once'
    });
    await turn;

    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.idle
    });
    expect(runtime.resolveCalls).toEqual([
      {
        sessionId: 'session-1',
        promptId: 'perm-1',
        resolution: 'allow_once'
      }
    ]);
  });

  it('persists the runtime session id returned by createSession and reuses it during recovery', async () => {
    const runtime = createFakeRuntimeAdapter([]);
    const database = createDatabase({ filename: ':memory:' });
    databases.push(database);
    const repositories = createRepositories(database);
    const orchestrator = createSessionOrchestrator({
      repositories,
      runtime,
      now: () => '2026-03-25T00:00:00.000Z',
      createId: createIncrementingId()
    });

    const session = await orchestrator.createSession({
      channelId: 'thread-runtime',
      context: createContext('discord-user-runtime')
    });

    expect(repositories.sessions.getById(session.sessionId)).toMatchObject({
      runtimeSessionId: 'runtime-session-1'
    });

    await orchestrator.recoverSession(session.sessionId);

    expect(runtime.resumeCalls).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        runtimeSessionId: 'runtime-session-1'
      })
    ]);
  });

  it('answers a pending question and returns the session to idle', async () => {
    const runtime = createFakeRuntimeAdapter([
      { type: 'question.asked', questionId: 'q-1', text: 'Continue?' },
      { type: 'turn.completed', exitCode: 0 }
    ]);
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-2',
      context: createContext('discord-user-2')
    });

    const turn = orchestrator.sendTurn(session.sessionId, 'continue');

    await expect(waitForState(orchestrator, session.sessionId)).resolves.toBe(
      SessionState.awaitingUserAnswer
    );

    await orchestrator.answerQuestion({
      promptId: 'prompt-1',
      answer: 'yes'
    });
    await turn;

    expect(runtime.resolveCalls).toEqual([
      {
        sessionId: 'session-1',
        promptId: 'q-1',
        resolution: 'answer:yes'
      }
    ]);
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.idle
    });
  });

  it('interrupts and closes a session through the runtime adapter', async () => {
    const runtime = createFakeRuntimeAdapter([]);
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-3',
      context: createContext('discord-user-3')
    });

    await orchestrator.interrupt(session.sessionId);
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.interrupting
    });

    await orchestrator.closeSession(session.sessionId);

    expect(runtime.interruptCalls).toEqual([{ sessionId: 'session-1' }]);
    expect(runtime.closeCalls).toEqual([{ sessionId: 'session-1' }]);
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.closed
    });
  });

  it('records a recovery marker when a running stream cannot be reattached', async () => {
    const runtime = createFakeRuntimeAdapter([], { failResumeWhileRunning: true });
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-4',
      context: createContext('discord-user-4')
    });

    await orchestrator.sendTurn(session.sessionId, 'keep running');
    runtime.holdCompletion = true;
    await orchestrator.recoverSession(session.sessionId);

    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.idle,
      recoveryStatus: 'recovery_uncertain'
    });

    const events = await orchestrator.listEvents(session.sessionId, 0);
    expect(events.at(-1)?.event).toEqual({
      type: 'recovery.unattached',
      sessionId: 'session-1',
      reason: 'running_stream_unavailable'
    });
  });

  it('returns the session to idle when the runtime fails a turn immediately', async () => {
    const runtime = createFakeRuntimeAdapter([], { failSendTurn: true });
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-5',
      context: createContext('discord-user-5')
    });

    await expect(orchestrator.sendTurn(session.sessionId, 'explode')).rejects.toThrow(
      'runtime send failed'
    );
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.idle
    });
  });

  it('keeps a permission prompt pending when runtime resolution fails', async () => {
    const runtime = createFakeRuntimeAdapter(
      [{ type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' }],
      { failResolvePrompt: true }
    );
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-6',
      context: createContext('discord-user-6')
    });

    const turn = orchestrator.sendTurn(session.sessionId, 'run tests');
    await expect(waitForState(orchestrator, session.sessionId)).resolves.toBe(
      SessionState.awaitingPermission
    );

    await expect(
      orchestrator.resolvePrompt({ promptId: 'prompt-1', resolution: 'allow_once' })
    ).rejects.toThrow('runtime resolve failed');

    expect(orchestrator.getPendingPrompt(session.sessionId)).toMatchObject({
      id: 'prompt-1',
      kind: 'permission'
    });
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.awaitingPermission
    });

    turn.catch(() => undefined);
  });

  it('marks a permission prompt stale when the runtime no longer recognizes it', async () => {
    const runtime = createFakeRuntimeAdapter(
      [{ type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' }],
      { staleResolvePrompt: true }
    );
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-6b',
      context: createContext('discord-user-6b')
    });

    const turn = orchestrator.sendTurn(session.sessionId, 'run tests');
    await expect(waitForState(orchestrator, session.sessionId)).resolves.toBe(
      SessionState.awaitingPermission
    );

    await expect(
      orchestrator.resolvePrompt({ promptId: 'prompt-1', resolution: 'allow_once' })
    ).rejects.toThrow('stale prompt prompt-1');

    expect(orchestrator.getPendingPrompt(session.sessionId)).toBeNull();
    await expect(orchestrator.getSession(session.sessionId)).resolves.toMatchObject({
      state: SessionState.idle
    });

    turn.catch(() => undefined);
  });

  it('maps repository prompt ids to runtime prompt ids when resolving Claude-side prompts', async () => {
    const runtime = createFakeRuntimeAdapter([
      {
        type: 'permission.requested',
        requestId: 'perm-display-1',
        runtimePromptId: 'sdk-perm-1',
        prompt: 'Allow write?'
      },
      { type: 'turn.completed', exitCode: 0 }
    ]);
    const orchestrator = createOrchestrator(runtime);
    const session = await orchestrator.createSession({
      channelId: 'thread-7',
      context: createContext('discord-user-7')
    });

    const turn = orchestrator.sendTurn(session.sessionId, 'run tests');

    await expect(waitForState(orchestrator, session.sessionId)).resolves.toBe(
      SessionState.awaitingPermission
    );

    await orchestrator.resolvePrompt({
      promptId: 'prompt-1',
      resolution: 'allow_once'
    });
    await turn;

    expect(runtime.resolveCalls).toEqual([
      {
        sessionId: 'session-1',
        promptId: 'sdk-perm-1',
        resolution: 'allow_once'
      }
    ]);
  });
});

function createOrchestrator(runtime: RuntimeAdapter) {
  const database = createDatabase({ filename: ':memory:' });
  databases.push(database);

  const deps: SessionOrchestratorDeps = {
    repositories: createRepositories(database),
    runtime,
    now: () => '2026-03-25T00:00:00.000Z',
    createId: createIncrementingId()
  };

  return createSessionOrchestrator(deps);
}

async function waitForState(
  orchestrator: ReturnType<typeof createSessionOrchestrator>,
  sessionId: string
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const session = await orchestrator.getSession(sessionId);
    if (
      session.state === SessionState.awaitingPermission ||
      session.state === SessionState.awaitingUserAnswer
    ) {
      return session.state;
    }

    await Promise.resolve();
  }

  throw new Error('timed out waiting for prompt state');
}

function createContext(createdBy: string) {
  return createSessionContext({
    cwd: '/workspace/app',
    allowedRoot: '/workspace',
    model: 'sonnet',
    runtimeOptions: { permissionMode: 'default' },
    createdBy
  });
}

function createIncrementingId(): (prefix: string) => string {
  const counters = new Map<string, number>();

  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function createFakeRuntimeAdapter(
  script: RuntimeEvent[],
  options?: {
    failResumeWhileRunning?: boolean;
    failSendTurn?: boolean;
    failResolvePrompt?: boolean;
    staleResolvePrompt?: boolean;
  }
): RuntimeAdapter & {
  resolveCalls: Array<{
    sessionId: string;
    promptId: string;
    resolution: RuntimeTurnPromptResolution;
  }>;
  resumeCalls: Array<{
    sessionId: string;
    state: SessionState;
    runtimeSessionId: string;
  }>;
  interruptCalls: Array<{ sessionId: string }>;
  closeCalls: Array<{ sessionId: string }>;
  holdCompletion: boolean;
} {
  const handles = new Map<string, RuntimeSessionHandle>();
  const resolveCalls: Array<{
    sessionId: string;
    promptId: string;
    resolution: RuntimeTurnPromptResolution;
  }> = [];
  const resumeCalls: Array<{
    sessionId: string;
    state: SessionState;
    runtimeSessionId: string;
  }> = [];
  const interruptCalls: Array<{ sessionId: string }> = [];
  const closeCalls: Array<{ sessionId: string }> = [];
  const state = { holdCompletion: false };

  return {
    resolveCalls,
    resumeCalls,
    interruptCalls,
    closeCalls,
    get holdCompletion() {
      return state.holdCompletion;
    },
    set holdCompletion(value: boolean) {
      state.holdCompletion = value;
    },
    async createSession(input) {
      const handle = { sessionId: input.sessionId, runtimeSessionId: `runtime-${input.sessionId}` };
      handles.set(input.sessionId, handle);
      return handle;
    },
    async resumeSession(input) {
      if (options?.failResumeWhileRunning && input.state === SessionState.running) {
        throw new Error('unable to resume running stream');
      }

      resumeCalls.push({
        sessionId: input.sessionId,
        state: input.state,
        runtimeSessionId: input.runtimeSessionId
      });

      const handle = handles.get(input.sessionId);
      if (!handle) {
        throw new Error(`missing session ${input.sessionId}`);
      }

      return handle;
    },
    async *sendTurn(input) {
      if (options?.failSendTurn) {
        throw new Error('runtime send failed');
      }

      for (const event of script) {
        if (state.holdCompletion && event.type === 'turn.completed') {
          return;
        }

        yield event;
      }
    },
    async resolvePrompt(input) {
      if (options?.staleResolvePrompt) {
        throw new Error(`unknown Claude prompt ${input.promptId}`);
      }

      if (options?.failResolvePrompt) {
        throw new Error('runtime resolve failed');
      }

      resolveCalls.push(input);
    },
    async interrupt(input) {
      interruptCalls.push(input);
    },
    async closeSession(input) {
      closeCalls.push(input);
    }
  };
}
