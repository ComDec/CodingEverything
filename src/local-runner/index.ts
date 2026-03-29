import { parseAllowedRootsValue } from '../shared/config.js';
import { startRunnerServer } from './http-server.js';
import { createClaudeSdkAdapter } from './runtime/claude-sdk-adapter.js';
import type { RuntimeAdapter } from './runtime/runtime-adapter.js';

export * from './event-stream.js';
export * from './http-server.js';
export * from './recovery.js';
export * from './runtime/runtime-adapter.js';
export * from './session-orchestrator.js';

export async function startLocalRunnerFromEnv(
  env: Record<string, string | undefined> = process.env,
  deps: {
    createRuntime?: () => RuntimeAdapter;
    startServer?: typeof startRunnerServer;
  } = {}
) {
  const port = Number(env.RUNNER_PORT ?? env.PORT ?? '3000');
  const databasePath = env.RUNNER_DATABASE_PATH ?? ':memory:';
  const allowedRoots = parseAllowedRootsValue(env.ALLOWED_ROOTS);
  const executablePath = env.CLAUDE_CODE_EXECUTABLE ?? env.CLAUDE_EXECUTABLE ?? 'claude';
  const debug = env.CLAUDE_DEBUG === '1' || env.CLAUDE_DEBUG === 'true';
  const debugFile = env.CLAUDE_DEBUG_FILE;
  const createRuntime = deps.createRuntime ?? (() => createClaudeSdkAdapter({
    executablePath,
    debug,
    debugFile,
    stderr: (data) => {
      if (debug || debugFile) {
        process.stderr.write(data);
      }
    }
  }));
  const startServer = deps.startServer ?? startRunnerServer;

  if (!Number.isInteger(port) || port < 0) {
    throw new Error('RUNNER_PORT must be a non-negative integer');
  }

  return startServer({
    port,
    databasePath,
    allowedRoots,
    runtime: createRuntime()
  });
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) {
  const server = await startLocalRunnerFromEnv();
  console.log(`Runner listening on ${server.origin}`);
}
