import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../src/shared/domain/events.js';
import { startLocalRunnerFromEnv } from '../../src/local-runner/index.js';
import { startRunnerServer, type RunnerServer } from '../../src/local-runner/http-server.js';
import type {
  RuntimeAdapter,
  RuntimeSessionHandle,
  RuntimeTurnPromptResolution
} from '../../src/local-runner/runtime/runtime-adapter.js';

const servers: RunnerServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('runner HTTP API', () => {
  it('imports shared workdir DTOs in the runner client', async () => {
    const source = await readFile(
      new URL('../../src/discord-control/runner-client.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain("from '../shared/contracts/runner-api.js'");
    expect(source).toContain('RunnerWorkdirView');
    expect(source).toContain('RunnerWorkdirScanCandidate');
    expect(source).toContain('RunnerWorkdirScanRequest');
    expect(source).toContain('RunnerWorkdirScanResponse');
    expect(source).toContain('RunnerWorkdirSaveRequest');
    expect(source).not.toContain('export type RunnerWorkdirView =');
    expect(source).not.toContain('export type RunnerWorkdirScanCandidate =');
  });

  it('creates a session through POST /sessions and exposes GET /health', async () => {
    const server = await createServer([]);

    const createResponse = await fetch(`${server.origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId: 'thread-1',
        context: {
          cwd: '/workspace/app',
          allowedRoot: '/workspace',
          model: 'sonnet',
          runtimeOptions: { permissionMode: 'default' },
          createdBy: 'discord-user-1'
        }
      })
    });

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };
    expect(created.sessionId).toBe('session-1');

    const statusResponse = await fetch(`${server.origin}/sessions/${created.sessionId}`);
    expect(statusResponse.status).toBe(200);

    const healthResponse = await fetch(`${server.origin}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({ ok: true });
  });

  it('streams events and resolves permission prompts through HTTP endpoints', async () => {
    const server = await createServer([
      { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' },
      { type: 'turn.completed', exitCode: 0 }
    ]);

    const created = await createSession(server.origin, 'thread-2', 'discord-user-2');
    const streamResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/events/stream`);
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');

    const turnResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run tests' })
    });
    expect(turnResponse.status).toBe(202);

    const sessionResponse = await waitForSession(server.origin, created.sessionId, 'awaiting_permission');
    expect(sessionResponse.pendingPrompt?.id).toBe('prompt-1');

    const resolveResponse = await fetch(
      `${server.origin}/prompts/${sessionResponse.pendingPrompt?.id}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'allow_once' })
      }
    );
    expect(resolveResponse.status).toBe(202);

    const streamText = await readStreamChunk(streamResponse);
    expect(streamText).toContain('permission.requested');
  });

  it('splits finite backlog fetches from live SSE subscriptions', async () => {
    const server = await createServer([
      { type: 'text.delta', messageId: 'msg-1', delta: 'hello\n' },
      { type: 'turn.completed', exitCode: 0 }
    ]);

    const created = await createSession(server.origin, 'thread-split', 'discord-user-split');

    const turnResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run split test' })
    });
    expect(turnResponse.status).toBe(202);

    const backlogResponse = await fetch(
      `${server.origin}/sessions/${created.sessionId}/events?after=0`
    );
    expect(backlogResponse.status).toBe(200);
    expect(backlogResponse.headers.get('content-type')).toContain('application/json');
    await expect(backlogResponse.json()).resolves.toEqual([
      expect.objectContaining({ id: expect.any(Number), event: { type: 'session.created' } }),
      expect.objectContaining({ id: expect.any(Number), event: { type: 'text.delta', messageId: 'msg-1', delta: 'hello\n' } }),
      expect.objectContaining({ id: expect.any(Number), event: { type: 'turn.completed', exitCode: 0 } })
    ]);

    const streamResponse = await fetch(
      `${server.origin}/sessions/${created.sessionId}/events/stream?after=0`
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    const streamText = await readStreamChunk(streamResponse);
    expect(streamText).toContain('session.created');
  });

  it('answers questions and exposes interrupt and close endpoints', async () => {
    const server = await createServer([
      { type: 'question.asked', questionId: 'q-1', text: 'Continue?' },
      { type: 'turn.completed', exitCode: 0 }
    ]);

    const created = await createSession(server.origin, 'thread-3', 'discord-user-3');
    await fetch(`${server.origin}/sessions/${created.sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'continue' })
    });

    const questionSession = await waitForSession(server.origin, created.sessionId, 'awaiting_user_answer');
    const answerResponse = await fetch(
      `${server.origin}/questions/${questionSession.pendingPrompt?.id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'yes' })
      }
    );
    expect(answerResponse.status).toBe(202);

    const interruptResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/interrupt`, {
      method: 'POST'
    });
    expect(interruptResponse.status).toBe(202);

    const closeResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/close`, {
      method: 'POST'
    });
    expect(closeResponse.status).toBe(202);
  });

  it('returns a failure response when a turn fails immediately', async () => {
    const server = await createServer([], { failSendTurn: true });
    const created = await createSession(server.origin, 'thread-4', 'discord-user-4');

    const turnResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'explode' })
    });

    expect(turnResponse.status).toBe(500);
    await expect(turnResponse.json()).resolves.toMatchObject({
      error: 'internal_error',
      message: 'runtime send failed'
    });

    const sessionResponse = await fetch(`${server.origin}/sessions/${created.sessionId}`);
    await expect(sessionResponse.json()).resolves.toMatchObject({ state: 'idle' });
  });

  it('returns not found when posting a turn to an unknown session', async () => {
    const server = await createServer([]);

    const turnResponse = await fetch(`${server.origin}/sessions/missing/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run tests' })
    });

    expect(turnResponse.status).toBe(404);
    await expect(turnResponse.json()).resolves.toMatchObject({
      error: 'not_found',
      message: 'unknown session missing'
    });
  });

  it('returns stale_prompt when a persisted prompt can no longer be resolved by the runtime', async () => {
    const server = await createServer(
      [{ type: 'permission.requested', requestId: 'perm-stale', prompt: 'Allow write?' }],
      { staleResolvePrompt: true }
    );
    const created = await createSession(server.origin, 'thread-stale', 'discord-user-stale');

    const turnResponse = await fetch(`${server.origin}/sessions/${created.sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run tests' })
    });
    expect(turnResponse.status).toBe(202);

    const session = await waitForSession(server.origin, created.sessionId, 'awaiting_permission');
    const promptId = session.pendingPrompt?.id;
    expect(promptId).toBeTruthy();

    const resolveResponse = await fetch(`${server.origin}/prompts/${promptId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: 'allow_once' })
    });

    expect(resolveResponse.status).toBe(409);
    await expect(resolveResponse.json()).resolves.toMatchObject({
      error: 'stale_prompt',
      message: `stale prompt ${promptId}`
    });
  });

  it('reuses a configured sqlite file and recovers persisted active sessions on restart', async () => {
    const databasePath = await createTempDatabasePath();
    const firstServer = await startRunnerServer({
      port: 0,
      databasePath,
      runtime: createFakeRuntimeAdapter([]),
      now: () => '2026-03-25T00:00:00.000Z',
      createId: createIncrementingId()
    });
    servers.push(firstServer);

    const created = await createSession(firstServer.origin, 'thread-persist', 'discord-user-persist');
    await firstServer.close();
    servers.pop();

    const resumedSessions: Array<{ sessionId: string; runtimeSessionId: string }> = [];

    const secondServer = await startRunnerServer({
      port: 0,
      databasePath,
      runtime: {
        async createSession(input) {
          return { sessionId: input.sessionId, runtimeSessionId: `runtime-${input.sessionId}` };
        },
        async resumeSession(input) {
          resumedSessions.push({
            sessionId: input.sessionId,
            runtimeSessionId: input.runtimeSessionId
          });
          return {
            sessionId: input.sessionId,
            runtimeSessionId: input.runtimeSessionId
          };
        },
        async *sendTurn() {},
        async resolvePrompt() {
          return;
        },
        async interrupt() {
          return;
        },
        async closeSession() {
          return;
        }
      },
      now: () => '2026-03-25T00:01:00.000Z',
      createId: createIncrementingId()
    });
    servers.push(secondServer);

    const sessionResponse = await fetch(`${secondServer.origin}/sessions/${created.sessionId}`);
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      sessionId: created.sessionId,
      state: 'idle',
      context: expect.objectContaining({ cwd: '/workspace/app' })
    });
    expect(resumedSessions).toEqual([
      {
        sessionId: created.sessionId,
        runtimeSessionId: `runtime-${created.sessionId}`
      }
    ]);
  });

  it('passes RUNNER_DATABASE_PATH from env into local runner startup', async () => {
    const databasePath = await createTempDatabasePath();
    const allowedRoot = await createTempDir('discord-claude-runner-root-');
    const server = await startLocalRunnerFromEnv(
      {
        RUNNER_PORT: '0',
        RUNNER_DATABASE_PATH: databasePath,
        ALLOWED_ROOTS: allowedRoot
      },
      {
        createRuntime: () => createFakeRuntimeAdapter([]),
        startServer: startRunnerServer
      }
    );
    servers.push(server);

    const created = await createSession(server.origin, 'thread-env', 'discord-user-env');
    const workdirPath = await createProjectDir(allowedRoot, 'saved-from-env', ['package.json']);
    const saveResponse = await fetch(`${server.origin}/workdirs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: workdirPath, createdBy: 'discord-user-env' })
    });
    await server.close();
    servers.pop();

    const reopened = await startRunnerServer({
      port: 0,
      databasePath,
      runtime: createFakeRuntimeAdapter([]),
      now: () => '2026-03-25T00:02:00.000Z',
      createId: createIncrementingId()
    });
    servers.push(reopened);

    const sessionResponse = await fetch(`${reopened.origin}/sessions/${created.sessionId}`);
    expect(sessionResponse.status).toBe(200);
    expect(saveResponse.status).toBe(201);
  });

  it('lists saved workdirs through GET /workdirs', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-workdirs-');
    const alphaPath = await createProjectDir(allowedRoot, 'alpha-workspace', ['package.json']);
    const bravoPath = await createProjectDir(allowedRoot, 'bravo-workspace', ['pyproject.toml']);
    const alphaRealPath = await realpath(alphaPath);
    const bravoRealPath = await realpath(bravoPath);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    await saveWorkdir(server.origin, { path: bravoPath, createdBy: 'discord-user-1' });
    await saveWorkdir(server.origin, { path: alphaPath, createdBy: 'discord-user-2' });

    const response = await fetch(`${server.origin}/workdirs`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        path: alphaRealPath,
        displayName: 'alpha-workspace',
        source: 'scan'
      }),
      expect.objectContaining({
        path: bravoRealPath,
        displayName: 'bravo-workspace',
        source: 'scan'
      })
    ]);
  });

  it('scans paged workdir candidates and skips noisy directories', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-scan-');
    const gitProjectPath = await createProjectDir(allowedRoot, 'alpha-git', ['.git']);
    const goProjectPath = await createProjectDir(allowedRoot, 'bravo-go', ['go.mod']);
    const packageProjectPath = await createProjectDir(allowedRoot, 'charlie-node', ['package.json']);
    await createProjectDir(allowedRoot, 'build/ignored-build', ['package.json']);
    await createProjectDir(allowedRoot, 'node_modules/ignored-module', ['package.json']);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    const firstPageResponse = await fetch(`${server.origin}/workdirs/scan?offset=0&limit=2`);
    expect(firstPageResponse.status).toBe(200);
    await expect(firstPageResponse.json()).resolves.toEqual({
      items: [
        expect.objectContaining({ path: gitProjectPath, displayName: basename(gitProjectPath) }),
        expect.objectContaining({ path: goProjectPath, displayName: basename(goProjectPath) })
      ],
      nextOffset: 2
    });

    const secondPageResponse = await fetch(`${server.origin}/workdirs/scan?offset=2&limit=2`);
    expect(secondPageResponse.status).toBe(200);
    await expect(secondPageResponse.json()).resolves.toEqual({
      items: [expect.objectContaining({ path: packageProjectPath })],
      nextOffset: null
    });
  });

  it('excludes already-saved workdirs from scan results before pagination', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-scan-filtered-');
    const savedProjectPath = await createProjectDir(allowedRoot, 'alpha-saved', ['package.json']);
    const visibleProjectPath = await createProjectDir(allowedRoot, 'bravo-visible', ['go.mod']);
    const trailingProjectPath = await createProjectDir(allowedRoot, 'charlie-visible', ['Cargo.toml']);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    await saveWorkdir(server.origin, {
      path: savedProjectPath,
      createdBy: 'discord-user-scan-filter'
    });

    const response = await fetch(`${server.origin}/workdirs/scan?offset=0&limit=2`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        expect.objectContaining({ path: visibleProjectPath }),
        expect.objectContaining({ path: trailingProjectPath })
      ],
      nextOffset: null
    });
  });

  it('saves a scanned workdir after validating it', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-save-');
    const projectPath = await createProjectDir(allowedRoot, 'delta-project', ['Cargo.toml']);
    const projectRealPath = await realpath(projectPath);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    const response = await saveWorkdir(server.origin, {
      path: projectPath,
      createdBy: 'discord-user-save'
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        path: projectRealPath,
        displayName: 'delta-project',
        source: 'scan',
        createdBy: 'discord-user-save'
      })
    );

    const listResponse = await fetch(`${server.origin}/workdirs`);
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({ path: projectRealPath, displayName: 'delta-project' })
    ]);
  });

  it('rejects saving workdirs outside the configured roots', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-allowed-');
    const outsideRoot = await createTempDir('discord-claude-runner-outside-');
    const outsideProjectPath = await createProjectDir(outsideRoot, 'outside-project', ['package.json']);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    const response = await saveWorkdir(server.origin, {
      path: outsideProjectPath,
      createdBy: 'discord-user-outside'
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      message: 'Path is outside the allowed roots.'
    });
  });

  it('rejects symlinked workdirs whose real path escapes the configured roots', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-symlink-allowed-');
    const outsideRoot = await createTempDir('discord-claude-runner-symlink-outside-');
    const outsideProjectPath = await createProjectDir(outsideRoot, 'real-project', ['package.json']);
    const escapedPath = join(allowedRoot, 'escaped-project');
    await symlink(outsideProjectPath, escapedPath, 'dir');
    expect(await readlink(escapedPath)).toBe(outsideProjectPath);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    const response = await saveWorkdir(server.origin, {
      path: escapedPath,
      createdBy: 'discord-user-symlink'
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      message: 'Path is outside the allowed roots.'
    });
  });

  it('re-saving an existing workdir preserves identity and increments usage history', async () => {
    const allowedRoot = await createTempDir('discord-claude-runner-resave-');
    const projectPath = await createProjectDir(allowedRoot, 'echo-project', ['package.json']);
    const projectRealPath = await realpath(projectPath);
    const server = await createServer([], { allowedRoots: [allowedRoot] });

    const firstResponse = await saveWorkdir(server.origin, {
      path: projectPath,
      createdBy: 'discord-user-first'
    });
    expect(firstResponse.status).toBe(201);
    const firstSaved = (await firstResponse.json()) as {
      id: string;
      path: string;
      createdAt: string;
      updatedAt: string;
      lastUsedAt: string;
      useCount: number;
      displayName: string;
      createdBy: string;
    };

    const secondResponse = await saveWorkdir(server.origin, {
      path: projectPath,
      createdBy: 'discord-user-second',
      displayName: '  '
    });
    expect(secondResponse.status).toBe(201);
    const secondSaved = (await secondResponse.json()) as typeof firstSaved;

    expect(secondSaved).toMatchObject({
      id: firstSaved.id,
      createdAt: firstSaved.createdAt,
      displayName: firstSaved.displayName,
      createdBy: firstSaved.createdBy,
      useCount: firstSaved.useCount + 1
    });
    expect(secondSaved.path).toBe(projectRealPath);

    const listResponse = await fetch(`${server.origin}/workdirs`);
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({
        id: firstSaved.id,
        path: projectRealPath,
        useCount: firstSaved.useCount + 1,
        displayName: firstSaved.displayName
      })
    ]);
  });
});

async function createTempDatabasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'discord-claude-runner-http-'));
  tempDirs.push(dir);
  return join(dir, 'runner.db');
}

async function createServer(
  script: RuntimeEvent[],
  options?: {
    failSendTurn?: boolean;
    staleResolvePrompt?: boolean;
    allowedRoots?: string[];
  }
): Promise<RunnerServer> {
  const server = await startRunnerServer({
    port: 0,
    runtime: createFakeRuntimeAdapter(script, options),
    allowedRoots: options?.allowedRoots ?? [],
    now: () => '2026-03-25T00:00:00.000Z',
    createId: createIncrementingId()
  });
  servers.push(server);
  return server;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createProjectDir(
  root: string,
  relativePath: string,
  markers: readonly string[]
): Promise<string> {
  const projectPath = join(root, relativePath);
  await mkdir(projectPath, { recursive: true });

  for (const marker of markers) {
    const markerPath = join(projectPath, marker);
    if (marker.startsWith('.')) {
      await mkdir(markerPath, { recursive: true });
      continue;
    }

    await writeFile(markerPath, 'marker');
  }

  return projectPath;
}

async function saveWorkdir(
  origin: string,
  body: { path: string; createdBy: string; displayName?: string }
): Promise<Response> {
  return await fetch(`${origin}/workdirs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function createSession(origin: string, channelId: string, createdBy: string) {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channelId,
      context: {
        cwd: '/workspace/app',
        allowedRoot: '/workspace',
        model: 'sonnet',
        runtimeOptions: { permissionMode: 'default' },
        createdBy
      }
    })
  });

  return (await response.json()) as { sessionId: string };
}

async function waitForSession(origin: string, sessionId: string, state: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${origin}/sessions/${sessionId}`);
    const session = (await response.json()) as {
      state: string;
      pendingPrompt?: { id: string };
    };

    if (session.state === state) {
      return session;
    }
  }

  throw new Error(`timed out waiting for ${state}`);
}

async function readStreamChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('missing stream body');
  }

  const chunk = await reader.read();
  await reader.cancel();
  reader.releaseLock();

  return new TextDecoder().decode(chunk.value);
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
  options?: { failSendTurn?: boolean; staleResolvePrompt?: boolean }
): RuntimeAdapter & {
  resolveCalls: Array<{
    sessionId: string;
    promptId: string;
    resolution: RuntimeTurnPromptResolution;
  }>;
} {
  const handles = new Map<string, RuntimeSessionHandle>();
  const resolveCalls: Array<{
    sessionId: string;
    promptId: string;
    resolution: RuntimeTurnPromptResolution;
  }> = [];

  return {
    resolveCalls,
    async createSession(input) {
      const handle = { sessionId: input.sessionId, runtimeSessionId: `runtime-${input.sessionId}` };
      handles.set(input.sessionId, handle);
      return handle;
    },
    async resumeSession(input) {
      const handle = handles.get(input.sessionId);
      if (!handle) {
        throw new Error(`unknown session ${input.sessionId}`);
      }

      return handle;
    },
    async *sendTurn() {
      if (options?.failSendTurn) {
        throw new Error('runtime send failed');
      }

      for (const event of script) {
        yield event;
      }
    },
    async resolvePrompt(input) {
      if (options?.staleResolvePrompt) {
        throw new Error(`unknown Claude prompt ${input.promptId}`);
      }

      resolveCalls.push(input);
    },
    async interrupt() {
      return;
    },
    async closeSession() {
      return;
    }
  };
}
