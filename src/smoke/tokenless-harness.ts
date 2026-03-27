import { createCommandHandlers } from '../discord-control/command-handlers.js';
import { renderSessionMessage } from '../discord-control/message-renderer.js';
import { replaySessionEvents } from '../discord-control/replay-controller.js';
import { createRenderModel, startNewTurn } from '../discord-control/render-model.js';
import { createDatabase } from '../shared/db/database.js';
import { createRepositories } from '../shared/db/repositories.js';
import { createSessionOrchestrator } from '../local-runner/session-orchestrator.js';
import { SessionState } from '../shared/domain/session.js';
import type { RuntimeEvent } from '../shared/domain/events.js';
import type {
  RuntimeAdapter,
  RuntimeSessionHandle,
  RuntimeTurnPromptResolution
} from '../local-runner/runtime/runtime-adapter.js';

export type TokenlessFlowResult = Readonly<{
  finalState: string;
  rendered: Readonly<{
    latestText: string;
  }>;
  auditActions: string[];
}>; 

export type TokenlessMultiTurnFlowResult = Readonly<{
  finalState: string;
  replies: readonly string[];
}>;

export async function runTokenlessFlow(): Promise<TokenlessFlowResult> {
  const database = createDatabase({ filename: ':memory:' });

  try {
    const repositories = createRepositories(database);
    const runtime = createScriptedRuntime([
      { type: 'text.delta', messageId: 'msg-1', delta: 'Preparing workspace\n' },
      {
        type: 'permission.requested',
        requestId: 'perm-1',
        runtimePromptId: 'prompt-1',
        prompt: 'Allow workspace write?'
      },
      { type: 'text.delta', messageId: 'msg-1', delta: 'Finished successfully' },
      { type: 'turn.completed', exitCode: 0 }
    ]);
    const orchestrator = createSessionOrchestrator({
      repositories,
      runtime,
      now: () => '2026-03-25T00:00:00.000Z',
      createId: createIncrementingId()
    });
    const runnerClient = createInMemoryRunnerClient(orchestrator, repositories);
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    const created = await handlers.handleCreateSession({
      channelId: 'thread-1',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      userId: 'discord-user-1',
      roleIds: ['operator']
    });

    let model = createRenderModel({
      sessionId: created.sessionId,
      threadId: 'thread-1'
    });

    const turn = runnerClient.sendTurn({
      sessionId: created.sessionId,
      prompt: 'Run the task'
    });

    const pendingPrompt = await waitForPendingPrompt(orchestrator, created.sessionId);

    model = (await replaySessionEvents({
      sessionId: created.sessionId,
      model,
      runnerClient
    })).model;

    await handlers.handleResolvePrompt({
      promptId: pendingPrompt.id,
      resolution: 'allow_once',
      userId: 'discord-user-1',
      sessionId: created.sessionId,
      roleIds: ['operator']
    });
    await turn;

    model = (await replaySessionEvents({
      sessionId: created.sessionId,
      model,
      runnerClient
    })).model;

    const rendered = renderSessionMessage(model);
    const session = await orchestrator.getSession(created.sessionId);
    const auditActions = (
      database
        .prepare('SELECT action FROM audit_log ORDER BY id ASC')
        .all() as Array<{ action: string }>
    ).map((row) => row.action);

    return {
      finalState: session.state,
      rendered: {
        latestText: getRenderedMessagesText(rendered)
      },
      auditActions
    };
  } finally {
    database.close();
  }
}

export async function runTokenlessMultiTurnFlow(): Promise<TokenlessMultiTurnFlowResult> {
  const database = createDatabase({ filename: ':memory:' });

  try {
    const repositories = createRepositories(database);
    const runtime = createStatefulContextRuntime();
    const orchestrator = createSessionOrchestrator({
      repositories,
      runtime,
      now: () => '2026-03-25T00:00:00.000Z',
      createId: createIncrementingId()
    });
    const runnerClient = createInMemoryRunnerClient(orchestrator, repositories);
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    const created = await handlers.handleCreateSession({
      channelId: 'thread-context',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      userId: 'discord-user-1',
      roleIds: ['operator']
    });

    let model = createRenderModel({
      sessionId: created.sessionId,
      threadId: 'thread-context'
    });
    const replies: string[] = [];

    await runnerClient.sendTurn({
      sessionId: created.sessionId,
      prompt: 'remember alpha'
    });

    model = (await replaySessionEvents({
      sessionId: created.sessionId,
      model,
      runnerClient
    })).model;
    replies.push(getRenderedMessagesText(renderSessionMessage(model)));

    model = startNewTurn(model, 'thread-context');

    await runnerClient.sendTurn({
      sessionId: created.sessionId,
      prompt: 'what did i ask you to remember?'
    });

    model = (await replaySessionEvents({
      sessionId: created.sessionId,
      model,
      runnerClient
    })).model;
    replies.push(getRenderedMessagesText(renderSessionMessage(model)));

    const session = await orchestrator.getSession(created.sessionId);

    return {
      finalState: session.state,
      replies
    };
  } finally {
    database.close();
  }
}

function getRenderedMessagesText(
  renderedMessages: ReturnType<typeof renderSessionMessage>
): string {
  return renderedMessages
    .map((rendered) => {
      const embedText = rendered.embeds.map((embed) => embed.description).join('\n');
      if (embedText.length > 0) {
        return embedText;
      }

      const componentText = collectRenderedComponentText(rendered.components ?? []).join('\n');
      return componentText || rendered.content;
    })
    .join('');
}

function collectRenderedComponentText(components: readonly unknown[]): string[] {
  const lines: string[] = [];

  for (const component of components) {
    if (typeof component !== 'object' || component === null) {
      continue;
    }

    if ('content' in component && typeof (component as { content?: unknown }).content === 'string') {
      lines.push((component as { content: string }).content);
    }

    if ('components' in component && Array.isArray((component as { components?: unknown[] }).components)) {
      lines.push(...collectRenderedComponentText((component as { components: unknown[] }).components));
    }
  }

  return lines;
}

function createInMemoryRunnerClient(
  orchestrator: ReturnType<typeof createSessionOrchestrator>,
  repositories: ReturnType<typeof createRepositories>
) {
  return {
    async createSession(input: Parameters<typeof orchestrator.createSession>[0]) {
      const session = await orchestrator.createSession(input);
      return { sessionId: session.sessionId };
    },
    async sendTurn(input: { sessionId: string; prompt: string }) {
      await orchestrator.sendTurn(input.sessionId, input.prompt);
    },
    async resolvePrompt(input: { promptId: string; resolution: 'allow_once' | 'deny_once' }) {
      await orchestrator.resolvePrompt(input);
      return { status: 'resolved' as const };
    },
    async answerQuestion(input: { promptId: string; answer: string }) {
      await orchestrator.answerQuestion(input);
    },
    async listEvents(input: { sessionId: string; fromSeq: number }) {
      const events = await orchestrator.listEvents(input.sessionId, input.fromSeq - 1);
      return events.map((record) => ({
        seq: record.id,
        event: record.event
      }));
    },
    async *subscribeEvents(input: { sessionId: string; fromSeq: number }) {
      const events = await orchestrator.listEvents(input.sessionId, input.fromSeq - 1);
      for (const record of events) {
        yield {
          seq: record.id,
          event: record.event
        };
      }
    },
    async health() {
      return { ok: true };
    },
    async getPendingPrompt(input: { sessionId: string }) {
      const prompt = repositories.prompts.getPendingPrompt(input.sessionId);

      if (!prompt) {
        return null;
      }

      return {
        kind: prompt.kind,
        promptId: prompt.id,
        runtimePromptId:
          prompt.payload.runtimePromptId ?? prompt.payload.requestId ?? prompt.payload.questionId ?? prompt.id,
        text: prompt.payload.prompt ?? prompt.payload.text ?? ''
      };
    },
    async getSession(input: { sessionId: string }) {
      const session = await orchestrator.getSession(input.sessionId);
      const prompt = repositories.prompts.getPendingPrompt(input.sessionId);

      return {
        sessionId: session.sessionId,
        state: session.state,
        recoveryStatus: session.recoveryStatus,
        pendingPrompt: prompt
          ? {
              kind: prompt.kind,
              promptId: prompt.id,
              runtimePromptId:
                prompt.payload.runtimePromptId ??
                prompt.payload.requestId ??
                prompt.payload.questionId ??
                prompt.id,
              text: prompt.payload.prompt ?? prompt.payload.text ?? ''
            }
          : null
      };
    }
  };
}

async function waitForPendingPrompt(
  orchestrator: ReturnType<typeof createSessionOrchestrator>,
  sessionId: string
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const prompt = orchestrator.getPendingPrompt(sessionId);
    if (prompt) {
      return prompt;
    }

    await Promise.resolve();
  }

  throw new Error('timed out waiting for a pending prompt');
}

function createIncrementingId(): (prefix: string) => string {
  const counters = new Map<string, number>();

  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function createScriptedRuntime(script: RuntimeEvent[]): RuntimeAdapter {
  const handles = new Map<string, RuntimeSessionHandle>();

  return {
    async createSession(input) {
      const handle = { sessionId: input.sessionId, runtimeSessionId: `runtime-${input.sessionId}` };
      handles.set(input.sessionId, handle);
      return handle;
    },
    async resumeSession(input) {
      const handle = handles.get(input.sessionId);
      if (!handle) {
        throw new Error(`missing session ${input.sessionId}`);
      }

      return handle;
    },
    async *sendTurn() {
      for (const event of script) {
        yield event;
      }
    },
    async resolvePrompt(_input: {
      sessionId: string;
      promptId: string;
      resolution: RuntimeTurnPromptResolution;
    }) {},
    async interrupt() {},
    async closeSession() {}
  };
}

function createStatefulContextRuntime(): RuntimeAdapter {
  const handles = new Map<string, RuntimeSessionHandle>();
  const memoryBySession = new Map<string, string>();

  return {
    async createSession(input) {
      const handle = { sessionId: input.sessionId, runtimeSessionId: `runtime-${input.sessionId}` };
      handles.set(input.sessionId, handle);
      return handle;
    },
    async resumeSession(input) {
      const handle = handles.get(input.sessionId);
      if (!handle) {
        throw new Error(`missing session ${input.sessionId}`);
      }

      return handle;
    },
    async *sendTurn(input) {
      const normalizedPrompt = input.prompt.trim().toLowerCase();

      if (normalizedPrompt === 'remember alpha') {
        memoryBySession.set(input.sessionId, 'alpha');
        yield { type: 'text.delta', messageId: 'msg-context-1', delta: 'I will remember alpha.' };
        yield { type: 'turn.completed', exitCode: 0 };
        return;
      }

      if (normalizedPrompt === 'what did i ask you to remember?') {
        const memory = memoryBySession.get(input.sessionId) ?? 'nothing';
        yield {
          type: 'text.delta',
          messageId: 'msg-context-2',
          delta: `You asked me to remember ${memory}.`
        };
        yield { type: 'turn.completed', exitCode: 0 };
        return;
      }

      yield { type: 'text.delta', messageId: 'msg-context-default', delta: 'Unhandled prompt.' };
      yield { type: 'turn.completed', exitCode: 0 };
    },
    async resolvePrompt() {},
    async interrupt() {},
    async closeSession() {}
  };
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) {
  const result = await runTokenlessFlow();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.finalState !== SessionState.idle) {
    process.exitCode = 1;
  }
}
