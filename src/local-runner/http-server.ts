import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase } from '../shared/db/database.js';
import { createRepositories } from '../shared/db/repositories.js';
import type { SessionState } from '../shared/domain/session.js';
import { createEventStreamBroker } from './event-stream.js';
import { createSessionOrchestrator } from './session-orchestrator.js';
import { createWorkdirCatalog } from './workdir-catalog.js';
import type { RuntimeAdapter } from './runtime/runtime-adapter.js';

export type RunnerServer = Readonly<{
  origin: string;
  close: () => Promise<void>;
}>;

export async function startRunnerServer(input: {
  port: number;
  databasePath?: string;
  allowedRoots?: readonly string[];
  runtime: RuntimeAdapter;
  now?: () => string;
  createId?: (prefix: string) => string;
}): Promise<RunnerServer> {
  const database = createDatabase({ filename: input.databasePath ?? ':memory:' });
  const repositories = createRepositories(database);
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.createId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const events = createEventStreamBroker();
  const orchestrator = createSessionOrchestrator({
    repositories,
    runtime: input.runtime,
    now,
    createId,
    onEvent: (record) => events.publish(record)
  });
  const workdirCatalog = createWorkdirCatalog({
    repositories,
    allowedRoots: input.allowedRoots ?? [],
    now,
    createId,
  });
  await recoverPersistedSessions(orchestrator, repositories.sessions.listActive());

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (request.method === 'GET' && path === '/health') {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && path === '/sessions') {
        const body = await readJsonBody<Parameters<typeof orchestrator.createSession>[0]>(request);
        const session = await orchestrator.createSession(body);
        writeJson(response, 201, session);
        return;
      }

      if (request.method === 'GET' && path === '/workdirs') {
        writeJson(response, 200, workdirCatalog.listSavedWorkdirs());
        return;
      }

      if (request.method === 'GET' && path === '/workdirs/scan') {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const result = await workdirCatalog.scanWorkdirs({
          offset: Number.isNaN(offset) ? 0 : offset,
          limit: Number.isNaN(limit) ? 25 : limit,
        });
        writeJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/workdirs') {
        const body = await readJsonBody<{ path: string; displayName?: string; createdBy: string }>(request);
        const saved = await workdirCatalog.saveWorkdir(body);
        writeJson(response, 201, saved);
        return;
      }

      const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (request.method === 'GET' && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] ?? '');
        const session = await orchestrator.getSession(sessionId);
        writeJson(response, 200, {
          ...session,
          pendingPrompt: orchestrator.getPendingPrompt(sessionId)
        });
        return;
      }

      const turnsMatch = path.match(/^\/sessions\/([^/]+)\/turns$/);
      if (request.method === 'POST' && turnsMatch) {
        const sessionId = decodeURIComponent(turnsMatch[1] ?? '');
        const body = (await readJsonBody(request)) as { prompt: string };
        const turn = orchestrator.sendTurn(sessionId, body.prompt);
        const outcome = await settleImmediateTurnStart(turn);

        if (outcome.status === 'rejected') {
          throw outcome.error;
        }

        writeJson(response, 202, { accepted: true });
        return;
      }

      const promptResolveMatch = path.match(/^\/prompts\/([^/]+)\/resolve$/);
      if (request.method === 'POST' && promptResolveMatch) {
        const promptId = decodeURIComponent(promptResolveMatch[1] ?? '');
        const body = (await readJsonBody(request)) as { resolution: 'allow_once' | 'deny_once' };
        await orchestrator.resolvePrompt({ promptId, resolution: body.resolution });
        writeJson(response, 202, { accepted: true });
        return;
      }

      const questionAnswerMatch = path.match(/^\/questions\/([^/]+)\/answer$/);
      if (request.method === 'POST' && questionAnswerMatch) {
        const promptId = decodeURIComponent(questionAnswerMatch[1] ?? '');
        const body = (await readJsonBody(request)) as { answer: string };
        await orchestrator.answerQuestion({ promptId, answer: body.answer });
        writeJson(response, 202, { accepted: true });
        return;
      }

      const interruptMatch = path.match(/^\/sessions\/([^/]+)\/interrupt$/);
      if (request.method === 'POST' && interruptMatch) {
        const sessionId = decodeURIComponent(interruptMatch[1] ?? '');
        await orchestrator.interrupt(sessionId);
        writeJson(response, 202, { accepted: true });
        return;
      }

      const closeMatch = path.match(/^\/sessions\/([^/]+)\/close$/);
      if (request.method === 'POST' && closeMatch) {
        const sessionId = decodeURIComponent(closeMatch[1] ?? '');
        await orchestrator.closeSession(sessionId);
        writeJson(response, 202, { accepted: true });
        return;
      }

      const eventsMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1] ?? '');
        const after = Number(url.searchParams.get('after') ?? '0');
        const backlog = await orchestrator.listEvents(sessionId, Number.isNaN(after) ? 0 : after);
        writeJson(response, 200, backlog.map((record) => ({ id: record.id, event: record.event })));
        return;
      }

      const streamMatch = path.match(/^\/sessions\/([^/]+)\/events\/stream$/);
      if (request.method === 'GET' && streamMatch) {
        const sessionId = decodeURIComponent(streamMatch[1] ?? '');
        const after = Number(url.searchParams.get('after') ?? '0');
        const backlog = await orchestrator.listEvents(sessionId, Number.isNaN(after) ? 0 : after);
        events.subscribe({ sessionId, response, backlog });
        return;
      }

      writeJson(response, 404, { error: 'not_found' });
    } catch (error) {
      writeError(response, error);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(input.port, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          database.close();
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

async function recoverPersistedSessions(
  orchestrator: ReturnType<typeof createSessionOrchestrator>,
  sessions: readonly { id: string }[]
): Promise<void> {
  for (const session of sessions) {
    await orchestrator.recoverSession(session.id);
  }
}

function writeJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody<T>(request: AsyncIterable<Buffer | string | Uint8Array>): Promise<T> {
  let body = '';

  for await (const chunk of request) {
    body += chunk.toString();
  }

  return (body.length === 0 ? {} : JSON.parse(body)) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function settleImmediateTurnStart(
  turn: Promise<void>
): Promise<
  | { status: 'accepted' }
  | { status: 'rejected'; error: unknown }
> {
  return Promise.race([
    turn.then(
      () => ({ status: 'accepted' as const }),
      (error) => ({ status: 'rejected' as const, error })
    ),
    new Promise<{ status: 'accepted' }>((resolve) => {
      setTimeout(() => resolve({ status: 'accepted' }), 0);
    })
  ]);
}

function writeError(response: ServerResponse<IncomingMessage>, error: unknown): void {
  const message = getErrorMessage(error);

  if (message.startsWith('unknown session ') || message.startsWith('unknown prompt ')) {
    writeJson(response, 404, { error: 'not_found', message });
    return;
  }

  if (message.startsWith('stale prompt ')) {
    writeJson(response, 409, { error: 'stale_prompt', message });
    return;
  }

  if (
    message === 'Path is outside the allowed roots.' ||
    message.startsWith('workdir path does not exist: ') ||
    message.startsWith('workdir path is not a directory: ')
  ) {
    writeJson(response, 400, { error: 'invalid_request', message });
    return;
  }

  writeJson(response, 500, { error: 'internal_error', message });
}

export type RunnerSessionResponse = Readonly<{
  sessionId: string;
  state: SessionState;
  recoveryStatus: 'ok' | 'recovery_uncertain';
  pendingPrompt: unknown;
}>;
