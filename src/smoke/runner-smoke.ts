export function buildSmokePrompt(): string {
  return 'List the files in the current working directory. Do not edit any files. Return a one-line confirmation only.';
}

export function buildResumeEvidenceMessage(input: {
  previousRuntimeSessionId: string;
  resumedRuntimeSessionId: string;
}): string {
  return `Resume evidence: resumed runtime session ${input.resumedRuntimeSessionId} from ${input.previousRuntimeSessionId}.`;
}

export function findSmokeRuntimeSessionId(
  internalEvents: ReadonlyArray<{ type: string; runtimeSessionId?: string } & Record<string, unknown>>
): string {
  for (let index = internalEvents.length - 1; index >= 0; index -= 1) {
    const event = internalEvents[index];
    if (event?.type === 'session.init' && event.runtimeSessionId) {
      return event.runtimeSessionId;
    }
  }

  throw new Error('Smoke resume requires a captured Claude runtime session id.');
}

export function describeCallbackProbeResult(input: {
  supportsStructuredPermissions: boolean;
  supportsStructuredQuestions: boolean;
  provedPermissionCallback: boolean;
  provedQuestionCallback: boolean;
}): string {
  if (!input.supportsStructuredPermissions || !input.supportsStructuredQuestions) {
    return 'Structured permission/question callbacks are unavailable in the adapter.';
  }

  if (input.provedPermissionCallback || input.provedQuestionCallback) {
    return `Structured callback probe results: permission proved=${input.provedPermissionCallback}, question proved=${input.provedQuestionCallback}.`;
  }

  return 'Structured permission/question callbacks are configured in the adapter but were not auto-proven by this safe local spike.';
}

export type SmokeAuthMode = 'api-key' | 'local-login';

export function describeSmokeAuthMode(authMode: SmokeAuthMode): string {
  if (authMode === 'api-key') {
    return 'Smoke auth mode: ANTHROPIC_API_KEY environment variable.';
  }

  return 'Smoke auth mode: local Claude login/subscription via the Claude CLI on this machine.';
}

export function validateSmokeEnvironment(env: NodeJS.ProcessEnv): {
  authMode: SmokeAuthMode;
  model: string;
} {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();

  return {
    authMode: apiKey ? 'api-key' : 'local-login',
    model: env.CLAUDE_MODEL?.trim() || 'sonnet'
  };
}

export async function loadClaudeSdkPackageVersion(): Promise<string> {
  try {
    const require = createRequire(import.meta.url);
    const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk');
    const packageJson = JSON.parse(
      await readFile(join(dirname(sdkEntryPath), 'package.json'), 'utf8')
    ) as { version?: string };
    const version = packageJson.version;
    return version ?? 'unknown';
  } catch (error) {
    throw new Error(
      `Unable to load the installed @anthropic-ai/claude-agent-sdk version: ${formatError(error)}. Install the SDK before running smoke validation.`
    );
  }
}

async function runRunnerSmoke(args: string[]): Promise<void> {
  const env = validateSmokeEnvironment(process.env);
  console.log(describeSmokeAuthMode(env.authMode));

  if (args.includes('--sdk-spike')) {
    const { runClaudeSdkSpike } = await import(new URL('./claude-sdk-spike.ts', import.meta.url).href);
    await runClaudeSdkSpike();
    return;
  }

  const [{ createSessionContext, SessionState }, { createClaudeSdkAdapter }] = await Promise.all([
    import(new URL('../shared/domain/session.ts', import.meta.url).href),
    import(new URL('../local-runner/runtime/claude-sdk-adapter.ts', import.meta.url).href)
  ]);
  const context = createSessionContext({
    cwd: process.cwd(),
    allowedRoot: process.cwd(),
    model: env.model,
    runtimeOptions: { permissionMode: 'default' },
    createdBy: 'smoke'
  });
  const adapter = createClaudeSdkAdapter();
  await adapter.createSession({
    sessionId: 'smoke-session',
    context
  });

  await collect(adapter.sendTurn({ sessionId: 'smoke-session', prompt: buildSmokePrompt() }));
  console.log('Smoke turn completed.');

  if (args.includes('--resume-check')) {
    const runtimeSessionId = findSmokeRuntimeSessionId(adapter.getInternalEvents('smoke-session'));
    const beforeResume = await adapter.resumeSession({
      sessionId: 'smoke-session',
      state: SessionState.idle,
      context,
      runtimeSessionId
    });
    await collect(
      adapter.sendTurn({ sessionId: 'smoke-session', prompt: 'Reply with exactly: resume check ok' })
    );
    const resumedRuntimeSessionId = findSmokeRuntimeSessionId(adapter.getInternalEvents('smoke-session'));
    const afterResume = await adapter.resumeSession({
      sessionId: 'smoke-session',
      state: SessionState.idle,
      context,
      runtimeSessionId: resumedRuntimeSessionId
    });
    console.log(
      buildResumeEvidenceMessage({
        previousRuntimeSessionId: beforeResume.runtimeSessionId,
        resumedRuntimeSessionId: afterResume.runtimeSessionId
      })
    );
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRunnerSmoke(process.argv.slice(2)).catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
