import type { CreateSessionRequest, SessionSummary } from '../shared/contracts/runner-api.js';
import type { EventRecord, PendingPrompt } from '../shared/db/repositories.js';
import type { RuntimeEvent } from '../shared/domain/events.js';
import { SessionState } from '../shared/domain/session.js';
import type { createRepositories } from '../shared/db/repositories.js';
import type {
  RuntimeAdapter,
  RuntimeTurnPromptResolution
} from './runtime/runtime-adapter.js';
import { recoverRunnerState } from './recovery.js';

type Repositories = ReturnType<typeof createRepositories>;

export type SessionView = SessionSummary & {
  recoveryStatus: 'ok' | 'recovery_uncertain';
};

export type SessionOrchestratorDeps = Readonly<{
  repositories: Repositories;
  runtime: RuntimeAdapter;
  now?: () => string;
  createId?: (prefix: string) => string;
  onEvent?: (record: EventRecord) => void;
}>;

export function createSessionOrchestrator(deps: SessionOrchestratorDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const createId = deps.createId ?? defaultCreateId;
  const activePromptResolvers = new Map<string, () => void>();
  const recoveryStatusBySession = new Map<string, 'ok' | 'recovery_uncertain'>();

  return {
    async createSession(input: CreateSessionRequest): Promise<SessionSummary> {
      const createdAt = now();
      const sessionId = createId('session');

      const runtimeHandle = await deps.runtime.createSession({
        sessionId,
        context: input.context
      });

      deps.repositories.sessions.insert({
        id: sessionId,
        state: SessionState.idle,
        runtimeSessionId: runtimeHandle.runtimeSessionId,
        context: input.context,
        createdAt,
        updatedAt: createdAt
      });
      deps.repositories.bindings.upsert({
        threadId: input.channelId,
        sessionId,
        createdAt,
        updatedAt: createdAt
      });
      appendEvent(deps, sessionId, { type: 'session.created' }, now());

      return {
        sessionId,
        state: SessionState.idle,
        context: input.context
      };
    },

    async getSession(sessionId: string): Promise<SessionView> {
      const session = getSessionRecord(deps.repositories, sessionId);

      return {
        sessionId: session.id,
        state: session.state,
        context: session.context,
        recoveryStatus: recoveryStatusBySession.get(sessionId) ?? 'ok'
      };
    },

    getPendingPrompt(sessionId: string): PendingPrompt | null {
      return deps.repositories.prompts.getPendingPrompt(sessionId);
    },

    async listEvents(sessionId: string, afterId: number): Promise<EventRecord[]> {
      return deps.repositories.events.listAfter(sessionId, afterId);
    },

    async sendTurn(sessionId: string, prompt: string): Promise<void> {
      const session = getSessionRecord(deps.repositories, sessionId);
      ensureTurnAllowed(session.state);

      updateSessionState(deps.repositories, sessionId, SessionState.running, now());
      recoveryStatusBySession.set(sessionId, 'ok');

      try {
        for await (const event of deps.runtime.sendTurn({
          sessionId,
          prompt,
          onRuntimeSessionId(runtimeSessionId) {
            persistRuntimeSessionId(deps.repositories, sessionId, runtimeSessionId, now());
          }
        })) {
          await handleRuntimeEvent({
            deps,
            createId,
            sessionId,
            event,
            now,
            activePromptResolvers
          });
        }
      } catch (error) {
        const currentSession = deps.repositories.sessions.getById(sessionId);
        if (currentSession?.state === SessionState.running) {
          updateSessionState(deps.repositories, sessionId, session.state, now());
        }

        throw error;
      }
    },

    async resolvePrompt(input: {
      promptId: string;
      resolution: Extract<RuntimeTurnPromptResolution, 'allow_once' | 'deny_once'>;
    }): Promise<void> {
      const prompt = getPrompt(deps.repositories, input.promptId);
      try {
        await deps.runtime.resolvePrompt({
          sessionId: prompt.sessionId,
          promptId: prompt.payload.runtimePromptId ?? prompt.id,
          resolution: input.resolution
        });
      } catch (error) {
        if (isUnknownRuntimePromptError(error)) {
          deps.repositories.prompts.resolve({ id: input.promptId, updatedAt: now() });
          updateSessionState(deps.repositories, prompt.sessionId, SessionState.idle, now());
          throw new Error(`stale prompt ${prompt.id}`);
        }

        throw error;
      }
      deps.repositories.prompts.resolve({ id: input.promptId, updatedAt: now() });
      appendEvent(
        deps,
        prompt.sessionId,
        { type: 'permission.resolved', promptId: prompt.id, resolution: input.resolution },
        now()
      );
      updateSessionState(deps.repositories, prompt.sessionId, SessionState.running, now());
      activePromptResolvers.get(prompt.id)?.();
    },

    async answerQuestion(input: { promptId: string; answer: string }): Promise<void> {
      const prompt = getPrompt(deps.repositories, input.promptId);
      try {
        await deps.runtime.resolvePrompt({
          sessionId: prompt.sessionId,
          promptId: prompt.payload.runtimePromptId ?? prompt.id,
          resolution: `answer:${input.answer}`
        });
      } catch (error) {
        if (isUnknownRuntimePromptError(error)) {
          deps.repositories.prompts.resolve({ id: input.promptId, updatedAt: now() });
          updateSessionState(deps.repositories, prompt.sessionId, SessionState.idle, now());
          throw new Error(`stale prompt ${prompt.id}`);
        }

        throw error;
      }
      deps.repositories.prompts.resolve({ id: input.promptId, updatedAt: now() });
      appendEvent(
        deps,
        prompt.sessionId,
        { type: 'question.answered', promptId: prompt.id, answer: input.answer },
        now()
      );
      updateSessionState(deps.repositories, prompt.sessionId, SessionState.running, now());
      activePromptResolvers.get(prompt.id)?.();
    },

    async interrupt(sessionId: string): Promise<void> {
      await deps.runtime.interrupt({ sessionId });
      updateSessionState(deps.repositories, sessionId, SessionState.interrupting, now());
      appendEvent(deps, sessionId, { type: 'session.interrupted' }, now());
    },

    async closeSession(sessionId: string): Promise<void> {
      await deps.runtime.closeSession({ sessionId });
      updateSessionState(deps.repositories, sessionId, SessionState.closed, now());
      appendEvent(deps, sessionId, { type: 'session.closed' }, now());
    },

    async recoverSession(sessionId: string): Promise<SessionView> {
      const session = getSessionRecord(deps.repositories, sessionId);

      if (session.runtimeSessionId) {
        try {
          const runtimeHandle = await deps.runtime.resumeSession({
            sessionId,
            state: session.state,
            context: session.context,
            runtimeSessionId: session.runtimeSessionId
          });
          persistRuntimeSessionId(deps.repositories, sessionId, runtimeHandle.runtimeSessionId, now());
        } catch {
          if (session.state === SessionState.running) {
            appendEvent(
              deps,
              sessionId,
              {
                type: 'recovery.unattached',
                sessionId,
                reason: 'running_stream_unavailable'
              },
              now()
            );
            recoveryStatusBySession.set(sessionId, 'recovery_uncertain');
            updateSessionState(deps.repositories, sessionId, SessionState.idle, now());
          }
        }
      }

      if (
        session.state === SessionState.awaitingPermission ||
        session.state === SessionState.awaitingUserAnswer
      ) {
        const prompt = deps.repositories.prompts.getPendingPrompt(sessionId);
        if (prompt) {
          const recovery = await recoverRunnerState({
            sessions: [session],
            prompts: [prompt]
          });

          for (const event of recovery.syntheticEvents) {
            appendEvent(deps, sessionId, event, now());
          }
        }
      }

      return this.getSession(sessionId);
    }
  };
}

const PROMPT_TTL_MS = 10 * 60 * 1000;

async function handleRuntimeEvent(input: {
  deps: SessionOrchestratorDeps;
  createId: (prefix: string) => string;
  sessionId: string;
  event: RuntimeEvent;
  now: () => string;
  activePromptResolvers: Map<string, () => void>;
}): Promise<void> {
  appendEvent(input.deps, input.sessionId, input.event, input.now());

  if (input.event.type === 'permission.requested') {
    const promptId = input.createId('prompt');
    input.deps.repositories.prompts.insertPendingPermission({
      id: promptId,
      sessionId: input.sessionId,
      requestId: input.event.requestId,
      runtimePromptId: input.event.runtimePromptId,
      prompt: input.event.prompt,
      expiresAt: computePromptExpiration(input.now()),
      createdAt: input.now()
    });
    updateSessionState(
      input.deps.repositories,
      input.sessionId,
      SessionState.awaitingPermission,
      input.now()
    );

    await new Promise<void>((resolve) => {
      input.activePromptResolvers.set(promptId, () => {
        input.activePromptResolvers.delete(promptId);
        resolve();
      });
    });
    return;
  }

  if (input.event.type === 'question.asked') {
    const promptId = input.createId('prompt');
    input.deps.repositories.prompts.insertPendingQuestion({
      id: promptId,
      sessionId: input.sessionId,
      questionId: input.event.questionId,
      runtimePromptId: input.event.runtimePromptId,
      text: input.event.text,
      expiresAt: computePromptExpiration(input.now()),
      createdAt: input.now()
    });
    updateSessionState(
      input.deps.repositories,
      input.sessionId,
      SessionState.awaitingUserAnswer,
      input.now()
    );

    await new Promise<void>((resolve) => {
      input.activePromptResolvers.set(promptId, () => {
        input.activePromptResolvers.delete(promptId);
        resolve();
      });
    });
    return;
  }

  if (input.event.type === 'turn.completed') {
    updateSessionState(input.deps.repositories, input.sessionId, SessionState.idle, input.now());
  }
}

function computePromptExpiration(nowValue: string): string {
  const baseTime = Date.parse(nowValue);
  return new Date((Number.isNaN(baseTime) ? Date.now() : baseTime) + PROMPT_TTL_MS).toISOString();
}

function appendEvent(
  deps: SessionOrchestratorDeps,
  sessionId: string,
  event: RuntimeEvent,
  createdAt: string
): void {
  const record = deps.repositories.events.append({
    sessionId,
    event,
    createdAt
  });

  deps.onEvent?.(record);
}

function updateSessionState(
  repositories: Repositories,
  sessionId: string,
  state: SessionState,
  updatedAt: string
): void {
  repositories.sessions.updateState({
    id: sessionId,
    state,
    updatedAt
  });
}

function persistRuntimeSessionId(
  repositories: Repositories,
  sessionId: string,
  runtimeSessionId: string | null,
  updatedAt: string
): void {
  repositories.sessions.updateRuntimeSessionId({
    id: sessionId,
    runtimeSessionId,
    updatedAt
  });
}

function getSessionRecord(repositories: Repositories, sessionId: string) {
  const session = repositories.sessions.getById(sessionId);

  if (!session) {
    throw new Error(`unknown session ${sessionId}`);
  }

  return session;
}

function getPrompt(repositories: Repositories, promptId: string): PendingPrompt {
  const prompt = repositories.prompts.getById(promptId);

  if (!prompt) {
    throw new Error(`unknown prompt ${promptId}`);
  }

  return prompt;
}

function isUnknownRuntimePromptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('unknown Claude prompt ');
}

function ensureTurnAllowed(state: SessionState): void {
  if (state !== SessionState.idle) {
    throw new Error(`session is not ready for a new turn: ${state}`);
  }
}

function defaultCreateId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
