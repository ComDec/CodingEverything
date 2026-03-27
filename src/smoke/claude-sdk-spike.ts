import type { ClaudeAdapterInternalEvent } from '../local-runner/runtime/claude-event-normalizer.js';
import type { RuntimeEvent } from '../shared/domain/events.js';

export type ClaudeSdkSpikeEvidence = Readonly<{
  sdkVersion: string;
  hasInitEvent: boolean;
  partialTextEventCount: number;
  supportsInterrupt: boolean;
  interruptProved: boolean;
  previousRuntimeSessionId: string;
  resumedRuntimeSessionId: string;
  supportsStructuredPermissions: boolean;
  supportsStructuredQuestions: boolean;
  provedPermissionCallback: boolean;
  provedQuestionCallback: boolean;
}>;

export async function runClaudeSdkSpike(): Promise<void> {
  const [
    {
      buildResumeEvidenceMessage,
      describeSmokeAuthMode,
      describeCallbackProbeResult,
      findSmokeRuntimeSessionId,
      loadClaudeSdkPackageVersion,
      validateSmokeEnvironment
    },
    { createSessionContext },
    { createClaudeSdkAdapter }
  ] = await Promise.all([
    import(new URL('./runner-smoke.ts', import.meta.url).href),
    import(new URL('../shared/domain/session.ts', import.meta.url).href),
    import(new URL('../local-runner/runtime/claude-sdk-adapter.ts', import.meta.url).href)
  ]);
  const env = validateSmokeEnvironment(process.env);
  const context = createSessionContext({
    cwd: process.cwd(),
    allowedRoot: process.cwd(),
    model: env.model,
    runtimeOptions: { permissionMode: 'default' },
    createdBy: 'smoke'
  });
  const adapter = createClaudeSdkAdapter();
  const sdkVersion = await loadClaudeSdkPackageVersion();

  console.log(describeSmokeAuthMode(env.authMode));
  console.log(`Claude SDK version: ${sdkVersion}`);

  await adapter.createSession({
    sessionId: 'smoke-session',
    context
  });

  const firstTurnEvents = await collect<RuntimeEvent>(
    adapter.sendTurn({ sessionId: 'smoke-session', prompt: 'Reply with exactly: sdk spike ok' })
  );
  const initEvent = adapter
    .getInternalEvents('smoke-session')
    .find(
      (event: ClaudeAdapterInternalEvent): event is Extract<ClaudeAdapterInternalEvent, { type: 'session.init' }> =>
        event.type === 'session.init'
    );

  if (!initEvent) {
    throw new Error('SDK spike failed: missing system/init event; verify the installed SDK emits session init metadata.');
  }

  console.log(`Init event captured for runtime session ${initEvent.runtimeSessionId}.`);
  console.log(`First turn emitted ${firstTurnEvents.length} runtime event(s).`);

  const runtimeSessionId = findSmokeRuntimeSessionId(adapter.getInternalEvents('smoke-session'));
  const beforeResume = await adapter.resumeSession({
    sessionId: 'smoke-session',
    state: 'idle',
    context,
    runtimeSessionId
  });
  const interruptProved = await proveInterruptSupport(adapter);
  const resumedTurnEvents = await collect<RuntimeEvent>(
    adapter.sendTurn({ sessionId: 'smoke-session', prompt: 'Reply with exactly: resume spike ok' })
  );
  const resumedRuntimeSessionId = findSmokeRuntimeSessionId(adapter.getInternalEvents('smoke-session'));
  const afterResume = await adapter.resumeSession({
    sessionId: 'smoke-session',
    state: 'idle',
    context,
    runtimeSessionId: resumedRuntimeSessionId
  });
  console.log(
    buildResumeEvidenceMessage({
      previousRuntimeSessionId: beforeResume.runtimeSessionId,
      resumedRuntimeSessionId: afterResume.runtimeSessionId
    })
  );
  console.log(`Resume turn emitted ${resumedTurnEvents.length} runtime event(s).`);

  const internalEvents = adapter.getInternalEvents('smoke-session');
  const partialTextEventCount = firstTurnEvents.filter((event) => event.type === 'text.delta').length;
  const provedPermissionCallback = internalEvents.some(
    (event: ClaudeAdapterInternalEvent) => event.type === 'permission.requested'
  );
  const provedQuestionCallback = internalEvents.some(
    (event: ClaudeAdapterInternalEvent) => event.type === 'question.asked'
  );
  for (const line of validateClaudeSdkSpikeEvidence({
    sdkVersion,
    hasInitEvent: true,
    partialTextEventCount,
    supportsInterrupt: adapter.capabilities.supportsInterrupt,
    interruptProved,
    previousRuntimeSessionId: beforeResume.runtimeSessionId,
    resumedRuntimeSessionId: afterResume.runtimeSessionId,
    supportsStructuredPermissions: adapter.capabilities.supportsStructuredPermissions,
    supportsStructuredQuestions: adapter.capabilities.supportsStructuredQuestions,
    provedPermissionCallback,
    provedQuestionCallback
  })) {
    if (!line.startsWith('Claude SDK version:') && !line.startsWith('Resume evidence:')) {
      console.log(line);
    }
  }
}

export function validateClaudeSdkSpikeEvidence(evidence: ClaudeSdkSpikeEvidence): string[] {
  const failures: string[] = [];

  if (!evidence.hasInitEvent) {
    failures.push('missing system/init event');
  }

  if (evidence.partialTextEventCount < 1) {
    failures.push('missing translated partial text events');
  }

  if (!evidence.supportsInterrupt) {
    failures.push('interrupt support is unavailable');
  } else if (!evidence.interruptProved) {
    failures.push('interrupt support could not be proved through the active query handle');
  }

  if (
    !evidence.supportsStructuredPermissions ||
    !evidence.supportsStructuredQuestions ||
    !evidence.provedPermissionCallback ||
    !evidence.provedQuestionCallback
  ) {
    failures.push(
      'could not auto-prove permission/question callback wiring; run a local prompt that triggers both a permission gate and AskUserQuestion callback, then re-run `CLAUDE_MODEL=sonnet npm run smoke:runner -- --sdk-spike`'
    );
  }

  if (failures.length > 0) {
    throw new Error(`SDK spike failed: ${failures.join('; ')}`);
  }

  return [
    `Claude SDK version: ${evidence.sdkVersion}`,
    `Resume evidence: resumed runtime session ${evidence.resumedRuntimeSessionId} from ${evidence.previousRuntimeSessionId}.`,
    `Partial text translation verified with ${evidence.partialTextEventCount} text.delta event(s).`,
    'Interrupt support verified through the active query handle.',
    `Structured callback probe results: permission proved=${evidence.provedPermissionCallback}, question proved=${evidence.provedQuestionCallback}.`
  ];
}

async function proveInterruptSupport(adapter: {
  sendTurn(input: { sessionId: string; prompt: string }): AsyncIterable<RuntimeEvent>;
  hasActiveInterrupt(sessionId: string): boolean;
  interrupt(input: { sessionId: string }): Promise<void>;
}): Promise<boolean> {
  try {
    const interruptedTurn = collect<RuntimeEvent>(
      adapter.sendTurn({
        sessionId: 'smoke-session',
        prompt: 'Write a deliberately slow response with many numbered lines so interrupt validation can cancel it.'
      })
    );

    const active = await waitForActiveInterrupt(adapter, 'smoke-session');
    if (!active) {
      return false;
    }

    await adapter.interrupt({ sessionId: 'smoke-session' });
    await interruptedTurn.catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function waitForActiveInterrupt(
  adapter: { hasActiveInterrupt(sessionId: string): boolean },
  sessionId: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (adapter.hasActiveInterrupt(sessionId)) {
      return true;
    }

    await Promise.resolve();
  }

  return false;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
