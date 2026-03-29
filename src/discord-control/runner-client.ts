import type { ActivePromptModel } from './render-model.js';
import type { RuntimeEvent } from '../shared/domain/events.js';
import type {
  RunnerWorkdirListResponse,
  RunnerWorkdirSaveRequest,
  RunnerWorkdirScanCandidate,
  RunnerWorkdirScanRequest,
  RunnerWorkdirScanResponse,
  RunnerWorkdirView
} from '../shared/contracts/runner-api.js';
import type { SessionContext, SessionState } from '../shared/domain/session.js';

export type RunnerEventEnvelope = Readonly<{
  seq: number;
  event: RuntimeEvent;
}>;

export type RunnerSessionView = Readonly<{
  sessionId: string;
  state: SessionState;
  context?: SessionContext;
  recoveryStatus: 'ok' | 'recovery_uncertain';
  pendingPrompt: ActivePromptModel | null;
}>;

export type RunnerClient = Readonly<{
  listEvents(input: { sessionId: string; fromSeq: number }): Promise<RunnerEventEnvelope[]>;
  subscribeEvents(input: {
    sessionId: string;
    fromSeq: number;
    abortSignal?: AbortSignal;
  }): AsyncIterable<RunnerEventEnvelope>;
  health(): Promise<{ ok: boolean }>;
  getPendingPrompt(input: { sessionId: string }): Promise<ActivePromptModel | null>;
  listWorkdirs?: () => Promise<RunnerWorkdirListResponse>;
  scanWorkdirs?: (input: RunnerWorkdirScanRequest) => Promise<RunnerWorkdirScanResponse>;
  saveWorkdir?: (input: RunnerWorkdirSaveRequest) => Promise<RunnerWorkdirView>;
}>;

export type RunnerControlClient = RunnerClient & Readonly<{
  createSession(input: { channelId: string; context: SessionContext }): Promise<{ sessionId: string }>;
  sendTurn(input: { sessionId: string; prompt: string }): Promise<void>;
  resolvePrompt(input: {
    promptId: string;
    resolution: 'allow_once' | 'deny_once';
  }): Promise<{ status: 'resolved' | 'already_resolved' | 'stale' }>;
  answerQuestion(input: { promptId: string; answer: string }): Promise<void>;
  getSession(input: { sessionId: string }): Promise<RunnerSessionView>;
}>; 

type RunnerWorkdirScanResult = RunnerWorkdirScanResponse & Readonly<{
  items: readonly RunnerWorkdirScanCandidate[];
}>;

export function createHttpRunnerClient(input: {
  origin: string;
  fetchImpl?: typeof fetch;
}): RunnerControlClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = input.origin.replace(/\/$/, '');

  const getSession = async (sessionId: string): Promise<RunnerSessionView> => {
    const response = await fetchImpl(`${origin}/sessions/${encodeURIComponent(sessionId)}`);
    const session = await readJson<{
      sessionId: string;
      state: SessionState;
      context?: SessionContext;
      recoveryStatus: 'ok' | 'recovery_uncertain';
      pendingPrompt: null | {
        id: string;
        kind: 'permission' | 'question';
        payload: Record<string, string>;
      };
    }>(response);

    return {
      sessionId: session.sessionId,
      state: session.state,
      context: session.context,
      recoveryStatus: session.recoveryStatus,
      pendingPrompt: toActivePromptModel(session.pendingPrompt)
    };
  };

  return {
    async createSession(body) {
      const response = await fetchImpl(`${origin}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

      return await readJson<{ sessionId: string }>(response);
    },
    async sendTurn(body) {
      const response = await fetchImpl(`${origin}/sessions/${encodeURIComponent(body.sessionId)}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: body.prompt })
      });

      await ensureOk(response);
    },
    async resolvePrompt(body) {
      const response = await fetchImpl(`${origin}/prompts/${encodeURIComponent(body.promptId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: body.resolution })
      });

      if (response.status === 404) {
        return { status: 'already_resolved' as const };
      }

      if (response.status === 409) {
        return { status: 'stale' as const };
      }

      await ensureOk(response);
      return { status: 'resolved' as const };
    },
    async answerQuestion(body) {
      const response = await fetchImpl(`${origin}/questions/${encodeURIComponent(body.promptId)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: body.answer })
      });

      await ensureOk(response);
    },
    async listEvents(inputValue) {
      const response = await fetchImpl(
        `${origin}/sessions/${encodeURIComponent(inputValue.sessionId)}/events?after=${String(
          Math.max(0, inputValue.fromSeq - 1)
        )}`
      );

      const envelopes = await readJson<Array<{ id: number; event: RuntimeEvent }>>(response);
      return envelopes.map(toRunnerEventEnvelope);
    },
    subscribeEvents(inputValue) {
      return createSseEventSubscription({
        fetchImpl,
        url: `${origin}/sessions/${encodeURIComponent(inputValue.sessionId)}/events/stream?after=${String(
          Math.max(0, inputValue.fromSeq - 1)
        )}`,
        abortSignal: inputValue.abortSignal
      });
    },
    async health() {
      const response = await fetchImpl(`${origin}/health`);
      return await readJson<{ ok: boolean }>(response);
    },
    async listWorkdirs() {
      const response = await fetchImpl(`${origin}/workdirs`);
      return await readJson<RunnerWorkdirListResponse>(response);
    },
    async scanWorkdirs(inputValue: RunnerWorkdirScanRequest) {
      const searchParams = new URLSearchParams();
      if (inputValue.offset !== undefined) {
        searchParams.set('offset', String(inputValue.offset));
      }

      if (inputValue.limit !== undefined) {
        searchParams.set('limit', String(inputValue.limit));
      }

      const query = searchParams.toString();
      const response = await fetchImpl(`${origin}/workdirs/scan${query.length > 0 ? `?${query}` : ''}`);
      return await readJson<RunnerWorkdirScanResult>(response);
    },
    async saveWorkdir(body: RunnerWorkdirSaveRequest) {
      const response = await fetchImpl(`${origin}/workdirs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

      return await readJson<RunnerWorkdirView>(response);
    },
    async getPendingPrompt(inputValue) {
      return (await getSession(inputValue.sessionId)).pendingPrompt;
    },
    async getSession(inputValue) {
      return await getSession(inputValue.sessionId);
    }
  };
}

function toRunnerEventEnvelope(input: { id: number; event: RuntimeEvent }): RunnerEventEnvelope {
  return {
    seq: input.id,
    event: input.event
  };
}

function createSseEventSubscription(input: {
  fetchImpl: typeof fetch;
  url: string;
  abortSignal?: AbortSignal;
}): AsyncIterable<RunnerEventEnvelope> {
  return {
    async *[Symbol.asyncIterator]() {
      const response = await input.fetchImpl(input.url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: input.abortSignal
      });

      await ensureOk(response);

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('runner stream missing response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }

          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            const event = parseSseBlock(block);
            if (event) {
              yield event;
            }
          }
        }

        const trailingEvent = parseSseBlock(buffer);
        if (trailingEvent) {
          yield trailingEvent;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
  };
}

function parseSseBlock(block: string): RunnerEventEnvelope | null {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const idLine = lines.find((line) => line.startsWith('id:'));
  const dataLine = lines.find((line) => line.startsWith('data:'));

  if (!idLine || !dataLine) {
    return null;
  }

  return toRunnerEventEnvelope({
    id: Number(idLine.slice(3).trim()),
    event: JSON.parse(dataLine.slice(5).trim()) as RuntimeEvent
  });
}

async function readJson<T>(response: Response): Promise<T> {
  await ensureOk(response);
  return (await response.json()) as T;
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  let message = `${response.status} ${response.statusText}`;

  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) {
      message = body.message;
    }
  } catch {
    const text = await response.text();
    if (text.trim().length > 0) {
      message = text.trim();
    }
  }

  throw new Error(message);
}

function toActivePromptModel(
  pendingPrompt:
    | null
    | {
        id: string;
        kind: 'permission' | 'question';
        payload: Record<string, string>;
      }
): ActivePromptModel | null {
  if (!pendingPrompt) {
    return null;
  }

  if (pendingPrompt.kind === 'permission') {
    return {
      kind: 'permission',
      promptId: pendingPrompt.id,
      runtimePromptId:
        pendingPrompt.payload.runtimePromptId ?? pendingPrompt.payload.requestId ?? pendingPrompt.id,
      text: pendingPrompt.payload.prompt ?? ''
    };
  }

  return {
    kind: 'question',
    promptId: pendingPrompt.id,
    runtimePromptId:
      pendingPrompt.payload.runtimePromptId ?? pendingPrompt.payload.questionId ?? pendingPrompt.id,
    text: pendingPrompt.payload.text ?? ''
  };
}
