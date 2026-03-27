import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options as ClaudeQueryOptions, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { SessionContext, SessionState } from '../../shared/domain/session.js';
import type { RuntimeEvent } from '../../shared/domain/events.js';
import type {
  CloseRuntimeSessionInput,
  CreateRuntimeSessionInput,
  InterruptRuntimeTurnInput,
  ResolveRuntimePromptInput,
  ResumeRuntimeSessionInput,
  RuntimeAdapter,
  RuntimeSessionHandle,
  RuntimeTurnInput,
  RuntimeTurnPromptResolution
} from './runtime-adapter.js';
import {
  normalizeClaudeEvent,
  normalizePermissionRequest,
  normalizeQuestionRequest,
  type ClaudeAdapterInternalEvent,
  type ClaudeSdkRawEvent,
  type NormalizedClaudeEvent
} from './claude-event-normalizer.js';

export type ClaudeSdkQueryOptions = Readonly<{
  cwd: string;
  model: string;
  resume?: string;
  pathToClaudeCodeExecutable?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills?: string[];
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
  persistSession: boolean;
  includePartialMessages: boolean;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeSdkPermissionRequest
  ) => Promise<ClaudeSdkPermissionResult>;
  toolConfig: {
    askUserQuestion: {
      previewFormat: 'markdown';
      onQuestion?: (question: ClaudeSdkQuestionRequest) => Promise<string>;
    };
  };
  systemPrompt: {
    type: 'preset';
    preset: 'claude_code';
  };
  settingSources: string[];
}>;

export type ClaudeSdkPermissionRequest = Readonly<{
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  agentID?: string;
}>;

export type ClaudeSdkPermissionResult = PermissionResult;

export type ClaudeSdkQuestionRequest = Readonly<{
  id: string;
  question: string;
}>;

type ClaudeSdkQueryHandle = AsyncIterable<ClaudeSdkRawEvent> & {
  interrupt?: () => void | Promise<void>;
};

export type ClaudeSdkAdapterCapabilities = Readonly<{
  supportsStructuredPermissions: true;
  supportsStructuredQuestions: true;
  supportsResume: true;
  supportsInterrupt: true;
}>;

export type ClaudeSdkAdapter = RuntimeAdapter & {
  capabilities: ClaudeSdkAdapterCapabilities;
  getInternalEvents(sessionId: string): ClaudeAdapterInternalEvent[];
  hasActiveInterrupt(sessionId: string): boolean;
  getPendingPrompt(sessionId: string):
    | Readonly<{
        id: string;
        kind: 'permission';
        requestId: string;
        prompt: string;
      }>
    | Readonly<{
        id: string;
        kind: 'question';
        questionId: string;
        text: string;
      }>
    | null;
};

export type ClaudeSdkAdapterOptions = Readonly<{
  executablePath?: string;
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
}>;

type PendingPromptRecord =
    | {
      id: string;
      kind: 'permission';
      requestId: string;
      prompt: string;
      toolInput: Record<string, unknown>;
      resolve: (value: ClaudeSdkPermissionResult) => void;
    }
  | {
      id: string;
      kind: 'question';
      questionId: string;
      text: string;
      resolve: (value: string) => void;
    };

type AdapterSessionRecord = {
  context: SessionContext;
  runtimeSessionId: string | null;
  internalEvents: ClaudeAdapterInternalEvent[];
  pendingPrompt: PendingPromptRecord | null;
  activeInterrupt: (() => void | Promise<void>) | null;
  toolUses: Map<string, { toolName: string; command?: string; description?: string }>;
};

const DEFAULT_CAPABILITIES: ClaudeSdkAdapterCapabilities = {
  supportsStructuredPermissions: true,
  supportsStructuredQuestions: true,
  supportsResume: true,
  supportsInterrupt: true
};

export function createClaudeSdkAdapter(options: ClaudeSdkAdapterOptions = {}): ClaudeSdkAdapter {
  const sessions = new Map<string, AdapterSessionRecord>();

  return {
    capabilities: DEFAULT_CAPABILITIES,

    async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionHandle> {
      sessions.set(input.sessionId, {
        context: input.context,
        runtimeSessionId: null,
        internalEvents: [],
        pendingPrompt: null,
        activeInterrupt: null,
        toolUses: new Map()
      });

      return {
        sessionId: input.sessionId,
        runtimeSessionId: input.sessionId
      };
    },

    async resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSessionHandle> {
      const session = sessions.get(input.sessionId) ?? {
        context: input.context,
        runtimeSessionId: input.runtimeSessionId,
        internalEvents: [],
        pendingPrompt: null,
        activeInterrupt: null,
        toolUses: new Map()
      };
      session.context = input.context;
      session.runtimeSessionId = input.runtimeSessionId;
      sessions.set(input.sessionId, session);

      return {
        sessionId: input.sessionId,
        runtimeSessionId: session.runtimeSessionId
      };
    },

    sendTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
      const session = getSessionRecord(sessions, input.sessionId);
      const runtimeEvents = createAsyncQueue<RuntimeEvent>();

      void runClaudeQuery({
        sessionId: input.sessionId,
        prompt: input.prompt,
        onRuntimeSessionId: input.onRuntimeSessionId,
        session,
        runtimeEvents
      });

      return runtimeEvents;
    },

    async resolvePrompt(input: ResolveRuntimePromptInput): Promise<void> {
      const session = getSessionRecord(sessions, input.sessionId);
      const pendingPrompt = session.pendingPrompt;
      if (!pendingPrompt || pendingPrompt.id !== input.promptId) {
        throw new Error(`unknown Claude prompt ${input.promptId}`);
      }

      session.pendingPrompt = null;

      if (pendingPrompt.kind === 'permission') {
        pendingPrompt.resolve(permissionResolutionToSdkDecision(input.resolution, pendingPrompt.toolInput));
        return;
      }

      pendingPrompt.resolve(questionResolutionToSdkAnswer(input.resolution));
    },

    async interrupt(input: InterruptRuntimeTurnInput): Promise<void> {
      const session = getSessionRecord(sessions, input.sessionId);
      await session.activeInterrupt?.();
    },

    async closeSession(input: CloseRuntimeSessionInput): Promise<void> {
      sessions.delete(input.sessionId);
    },

    getInternalEvents(sessionId: string): ClaudeAdapterInternalEvent[] {
      return [...getSessionRecord(sessions, sessionId).internalEvents];
    },

    hasActiveInterrupt(sessionId: string): boolean {
      return getSessionRecord(sessions, sessionId).activeInterrupt !== null;
    },

    getPendingPrompt(sessionId: string) {
      const pendingPrompt = getSessionRecord(sessions, sessionId).pendingPrompt;
      if (!pendingPrompt) {
        return null;
      }

      if (pendingPrompt.kind === 'permission') {
        return {
          id: pendingPrompt.id,
          kind: pendingPrompt.kind,
          requestId: pendingPrompt.requestId,
          prompt: pendingPrompt.prompt
        } as const;
      }

      return {
        id: pendingPrompt.id,
        kind: pendingPrompt.kind,
        questionId: pendingPrompt.questionId,
        text: pendingPrompt.text
      } as const;
    }
  };

  async function runClaudeQuery(input: {
    sessionId: string;
    prompt: string;
    onRuntimeSessionId?: (runtimeSessionId: string) => void;
    session: AdapterSessionRecord;
    runtimeEvents: AsyncQueue<RuntimeEvent>;
  }): Promise<void> {
    try {
      const handle = query({
        prompt: input.prompt,
        options: buildQueryOptions({
          sessionId: input.sessionId,
          onRuntimeSessionId: input.onRuntimeSessionId,
          session: input.session,
          runtimeEvents: input.runtimeEvents
        }) as ClaudeQueryOptions
      }) as ClaudeSdkQueryHandle;

      input.session.activeInterrupt = typeof handle.interrupt === 'function' ? handle.interrupt : null;

      for await (const rawEvent of handle) {
        applyNormalizedEvent(
          input.sessionId,
          input.session,
          normalizeClaudeEvent(input.sessionId, rawEvent),
          input.runtimeEvents,
          input.onRuntimeSessionId
        );
      }

      input.runtimeEvents.close();
    } catch (error) {
      input.runtimeEvents.fail(error);
    } finally {
      input.session.activeInterrupt = null;
    }
  }

  function buildQueryOptions(input: {
    sessionId: string;
    onRuntimeSessionId?: (runtimeSessionId: string) => void;
    session: AdapterSessionRecord;
    runtimeEvents: AsyncQueue<RuntimeEvent>;
  }): ClaudeSdkQueryOptions {
    return {
      cwd: input.session.context.cwd,
      model: input.session.context.model,
      resume: input.session.runtimeSessionId ?? undefined,
      persistSession: true,
      includePartialMessages: true,
      effort: input.session.context.runtimeOptions.effort,
      skills: input.session.context.runtimeOptions.skills
        ? [...input.session.context.runtimeOptions.skills]
        : undefined,
      canUseTool: async (toolName, toolInput, request) => {
        const requestId = request.toolUseID;
        const normalized = normalizePermissionRequest({
          sessionId: input.sessionId,
          requestId,
          runtimePromptId: request.toolUseID,
          toolName,
          prompt: request.title
        });
        applyNormalizedEvent(input.sessionId, input.session, normalized, input.runtimeEvents);

        return new Promise<ClaudeSdkPermissionResult>((resolve) => {
          input.session.pendingPrompt = {
            id: requestId,
            kind: 'permission',
            requestId,
            prompt: normalized.runtimeEvents[0]?.type === 'permission.requested'
              ? normalized.runtimeEvents[0].prompt
              : buildToolPermissionPrompt(toolName, request.title),
            toolInput,
            resolve
          };
        });
      },
      toolConfig: {
        askUserQuestion: {
          previewFormat: 'markdown',
          onQuestion: async (question) => {
            const normalized = normalizeQuestionRequest({
              sessionId: input.sessionId,
              questionId: question.id,
              runtimePromptId: question.id,
              text: question.question
            });
            applyNormalizedEvent(input.sessionId, input.session, normalized, input.runtimeEvents);

            return new Promise<string>((resolve) => {
              input.session.pendingPrompt = {
                id: question.id,
                kind: 'question',
                questionId: question.id,
                text: question.question,
                resolve
              };
            });
          }
        }
      },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code'
      },
      settingSources: ['project'],
      pathToClaudeCodeExecutable: options.executablePath ?? 'claude',
      debug: options.debug,
      debugFile: options.debugFile,
      stderr: options.stderr
    };
  }
}

function applyNormalizedEvent(
  sessionId: string,
  session: AdapterSessionRecord,
  normalized: NormalizedClaudeEvent,
  runtimeEvents: AsyncQueue<RuntimeEvent>,
  onRuntimeSessionId?: (runtimeSessionId: string) => void
): void {
  for (const event of normalized.internalEvents) {
    session.internalEvents.push(event);
    if (event.type === 'session.init') {
      session.runtimeSessionId = event.runtimeSessionId;
      onRuntimeSessionId?.(event.runtimeSessionId);
      continue;
    }

    if (event.type === 'tool.started') {
      session.toolUses.set(event.toolUseId, {
        toolName: event.toolName,
        command: event.command,
        description: event.description
      });
    }
  }

  for (const event of normalized.runtimeEvents) {
    if (event.type === 'tool.completed') {
      const toolUse = session.toolUses.get(event.toolUseId);
      runtimeEvents.push({
        ...event,
        toolName: toolUse?.toolName ?? event.toolName,
        command: toolUse?.command,
        description: toolUse?.description
      });
      continue;
    }

    runtimeEvents.push(event);
  }
}

function getSessionRecord(
  sessions: Map<string, AdapterSessionRecord>,
  sessionId: string
): AdapterSessionRecord {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`unknown Claude session ${sessionId}`);
  }

  return session;
}

function permissionResolutionToSdkDecision(
  resolution: RuntimeTurnPromptResolution,
  toolInput: Record<string, unknown>
): ClaudeSdkPermissionResult {
  return resolution === 'allow_once'
    ? { behavior: 'allow', updatedInput: toolInput }
    : { behavior: 'deny', message: 'Denied by runner operator.' };
}

function questionResolutionToSdkAnswer(resolution: RuntimeTurnPromptResolution): string {
  if (!resolution.startsWith('answer:')) {
    throw new Error(`expected question answer resolution, received ${resolution}`);
  }

  return resolution.slice('answer:'.length);
}

function buildToolPermissionPrompt(toolName: string, title?: string): string {
  return title?.trim() || `Allow Claude to use ${toolName}?`;
}

type AsyncQueue<T> = AsyncIterable<T> & {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
};

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let isClosed = false;
  let failure: unknown = null;

  return {
    push(value: T) {
      if (isClosed || failure !== null) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }

      values.push(value);
    },

    close() {
      if (isClosed) {
        return;
      }

      isClosed = true;
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined, done: true });
      }
    },

    fail(error: unknown) {
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift() as T, done: false });
          }

          if (failure !== null) {
            return Promise.reject(failure);
          }

          if (isClosed) {
            return Promise.resolve({ value: undefined, done: true });
          }

          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        }
      };
    }
  };
}
