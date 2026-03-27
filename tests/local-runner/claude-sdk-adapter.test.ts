import { describe, expect, it, vi, afterEach } from 'vitest';
import { SessionState, createSessionContext } from '../../src/shared/domain/session.js';

const sdkState = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock(
  '@anthropic-ai/claude-agent-sdk',
  () => ({
    query: sdkState.query
  })
);

import {
  createClaudeSdkAdapter,
  type ClaudeSdkAdapter,
  type ClaudeSdkPermissionResult,
  type ClaudeSdkQueryOptions
} from '../../src/local-runner/runtime/claude-sdk-adapter.js';
import {
  buildResumeEvidenceMessage,
  buildSmokePrompt,
  describeSmokeAuthMode,
  describeCallbackProbeResult,
  findSmokeRuntimeSessionId,
  validateSmokeEnvironment
} from '../../src/smoke/runner-smoke.js';
import { validateClaudeSdkSpikeEvidence } from '../../src/smoke/claude-sdk-spike.js';

afterEach(() => {
  sdkState.query.mockReset();
});

describe('Claude SDK adapter', () => {
  it('passes persistent Claude Code query options and records partial text deltas', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    sdkState.query.mockReturnValue(
      createMockQuery([
        { type: 'system', subtype: 'init', session_id: 'sdk-session-1' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hello' }
          }
        },
        { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'hello' }] } },
        { type: 'result', subtype: 'success' }
      ])
    );

    await adapter.createSession({
      sessionId: 'session-1',
      context: createContext('discord-user-1')
    });

    const events = await collect(adapter.sendTurn({ sessionId: 'session-1', prompt: 'say hello' }));

    expect(events).toEqual([
      {
        type: 'text.delta',
        messageId: 'stream',
        delta: 'hello'
      },
      { type: 'turn.completed', exitCode: 0 }
    ]);
    expect(sdkState.query).toHaveBeenCalledTimes(1);
    const firstCall = sdkState.query.mock.calls[0]?.[0] as {
      prompt: string;
      options: ClaudeSdkQueryOptions;
    };
    expect(firstCall.prompt).toBe('say hello');
    expect(firstCall.options).toMatchObject({
      cwd: '/workspace/app',
      model: 'sonnet',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      persistSession: true,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } }
    });
    expect(typeof firstCall.options.canUseTool).toBe('function');
    expect(adapter.getInternalEvents('session-1')).toContainEqual({
      type: 'text.delta',
      sessionId: 'session-1',
      messageId: 'msg-1',
      delta: 'hello'
    });
  });

  it('passes session effort through to Claude Code query options', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    sdkState.query.mockReturnValue(createMockQuery([{ type: 'result', subtype: 'success' }]));

    await adapter.createSession({
      sessionId: 'session-effort-1',
      context: createSessionContext({
        cwd: '/workspace/app',
        allowedRoot: '/workspace',
        model: 'sonnet',
        runtimeOptions: { permissionMode: 'default', effort: 'low' },
        createdBy: 'discord-user-effort'
      })
    });

    await collect(adapter.sendTurn({ sessionId: 'session-effort-1', prompt: 'do the thing' }));

    const firstCall = sdkState.query.mock.calls.at(-1)?.[0] as {
      options: ClaudeSdkQueryOptions;
    };
    expect(firstCall.options.effort).toBe('low');
  });

  it('passes session skills through to Claude Code query options', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    sdkState.query.mockReturnValue(createMockQuery([{ type: 'result', subtype: 'success' }]));

    await adapter.createSession({
      sessionId: 'session-skills-1',
      context: createSessionContext({
        cwd: '/workspace/app',
        allowedRoot: '/workspace',
        model: 'sonnet',
        runtimeOptions: {
          permissionMode: 'default',
          skills: ['project-memory', 'safe-bash']
        },
        createdBy: 'discord-user-skills'
      })
    });

    await collect(adapter.sendTurn({ sessionId: 'session-skills-1', prompt: 'do the thing' }));

    const firstCall = sdkState.query.mock.calls.at(-1)?.[0] as {
      options: ClaudeSdkQueryOptions;
    };
    expect(firstCall.options.skills).toEqual(['project-memory', 'safe-bash']);
  });

  it('surfaces structured permission and question callbacks and resolves them explicitly', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    let queryOptions: ClaudeSdkQueryOptions | undefined;
    let permissionResolution: Promise<ClaudeSdkPermissionResult> | undefined;
    let questionResolution: Promise<string> | undefined;

    sdkState.query.mockImplementation(({ options }: { options: ClaudeSdkQueryOptions }) => {
      queryOptions = options;

      return {
        async *[Symbol.asyncIterator]() {
          permissionResolution = options.canUseTool?.('Write', { file_path: 'notes.txt' }, {
            signal: new AbortController().signal,
            title: 'Allow Claude to use Write?',
            toolUseID: 'perm-1'
          });
          await permissionResolution;

          questionResolution = options.toolConfig?.askUserQuestion?.onQuestion?.({
            id: 'question-1',
            question: 'Continue anyway?'
          });
          await questionResolution;

          yield { type: 'result', subtype: 'success' };
        }
      };
    });

    await adapter.createSession({
      sessionId: 'session-1',
      context: createContext('discord-user-2')
    });

    const turn = collect(adapter.sendTurn({ sessionId: 'session-1', prompt: 'proceed' }));

    await vi.waitFor(() => {
      expect(adapter.getPendingPrompt('session-1')).toMatchObject({
        kind: 'permission',
        id: 'perm-1',
        requestId: 'perm-1',
        prompt: 'Allow Claude to use Write?'
      });
    });
    expect(adapter.capabilities).toMatchObject({
      supportsStructuredPermissions: true,
      supportsStructuredQuestions: true,
      supportsResume: true,
      supportsInterrupt: true
    });

    await adapter.resolvePrompt({
      sessionId: 'session-1',
      promptId: 'perm-1',
      resolution: 'allow_once'
    });
    await expect(permissionResolution).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'notes.txt' }
    });

    await vi.waitFor(() => {
      expect(adapter.getPendingPrompt('session-1')).toMatchObject({
        kind: 'question',
        id: 'question-1',
        questionId: 'question-1',
        text: 'Continue anyway?'
      });
    });

    await adapter.resolvePrompt({
      sessionId: 'session-1',
      promptId: 'question-1',
      resolution: 'answer:yes'
    });
    await expect(questionResolution).resolves.toBe('yes');
    await expect(turn).resolves.toEqual([
      {
        type: 'permission.requested',
        requestId: 'perm-1',
        runtimePromptId: 'perm-1',
        prompt: 'Allow Claude to use Write?'
      },
      {
        type: 'question.asked',
        questionId: 'question-1',
        runtimePromptId: 'question-1',
        text: 'Continue anyway?'
      },
      { type: 'turn.completed', exitCode: 0 }
    ]);
    expect(queryOptions?.toolConfig?.askUserQuestion?.previewFormat).toBe('markdown');
  });

  it('emits Bash tool start and completion events from Claude tool-use traffic', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    sdkState.query.mockReturnValue(
      createMockQuery([
        {
          type: 'assistant',
          message: {
            id: 'msg-tool-1',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01bash',
                name: 'Bash',
                input: {
                  command: 'pwd',
                  description: 'Print working directory'
                }
              }
            ]
          }
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_01bash',
                content: '/workspace/app',
                is_error: false
              }
            ]
          },
          tool_use_result: {
            stdout: '/workspace/app',
            stderr: '',
            interrupted: false,
            isImage: false,
            noOutputExpected: false
          }
        },
        { type: 'result', subtype: 'success' }
      ])
    );

    await adapter.createSession({
      sessionId: 'session-tool-1',
      context: createContext('discord-user-tool')
    });

    const events = await collect(adapter.sendTurn({ sessionId: 'session-tool-1', prompt: 'run pwd' }));

    expect(events).toEqual([
      {
        type: 'tool.started',
        toolUseId: 'toolu_01bash',
        toolName: 'Bash',
        command: 'pwd',
        description: 'Print working directory'
      },
      {
        type: 'tool.completed',
        toolUseId: 'toolu_01bash',
        toolName: 'Bash',
        command: 'pwd',
        description: 'Print working directory',
        output: '/workspace/app',
        stdout: '/workspace/app',
        stderr: '',
        isError: false
      },
      { type: 'turn.completed', exitCode: 0 }
    ]);
  });

  it('reuses the SDK session id on resume and interrupts the active query when available', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    const interrupt = vi.fn();
    const blocker = createDeferred<void>();

    sdkState.query
      .mockReturnValueOnce(
        createMockQuery(
          [
            { type: 'system', subtype: 'init', session_id: 'sdk-session-9' },
            blocker.promise.then(() => ({ type: 'result', subtype: 'success' }))
          ],
          { interrupt }
        )
      )
      .mockReturnValueOnce(createMockQuery([{ type: 'result', subtype: 'success' }]));

    await adapter.createSession({
      sessionId: 'session-1',
      context: createContext('discord-user-3')
    });

    const firstTurn = collect(adapter.sendTurn({ sessionId: 'session-1', prompt: 'first turn' }));

    await vi.waitFor(() => {
      expect(adapter.getInternalEvents('session-1')).toContainEqual({
        type: 'session.init',
        sessionId: 'session-1',
        runtimeSessionId: 'sdk-session-9'
      });
    });
    expect(adapter.hasActiveInterrupt('session-1')).toBe(true);

    await expect(
      adapter.resumeSession({
        sessionId: 'session-1',
        state: SessionState.idle,
        context: createContext('discord-user-3'),
        runtimeSessionId: 'sdk-session-9'
      })
    ).resolves.toEqual({
      sessionId: 'session-1',
      runtimeSessionId: 'sdk-session-9'
    });

    await adapter.interrupt({ sessionId: 'session-1' });
    expect(interrupt).toHaveBeenCalledTimes(1);

    blocker.resolve();
    await firstTurn;
    expect(adapter.hasActiveInterrupt('session-1')).toBe(false);

    await collect(adapter.sendTurn({ sessionId: 'session-1', prompt: 'second turn' }));

    const secondCall = sdkState.query.mock.calls[1]?.[0] as { options: ClaudeSdkQueryOptions };
    expect(secondCall.options.resume).toBe('sdk-session-9');
  });

  it('rebuilds resumable Claude state from a persisted runtime session id after process restart', async () => {
    const adapter = createAdapter({ executablePath: '/usr/local/bin/claude' });
    sdkState.query.mockReturnValueOnce(createMockQuery([{ type: 'result', subtype: 'success' }]));

    await adapter.resumeSession({
      sessionId: 'session-restore-1',
      state: SessionState.idle,
      context: createContext('discord-user-restore'),
      runtimeSessionId: 'sdk-session-restored'
    });

    await collect(adapter.sendTurn({ sessionId: 'session-restore-1', prompt: 'resume me' }));

    const call = sdkState.query.mock.calls[0]?.[0] as { options: ClaudeSdkQueryOptions };
    expect(call.options.resume).toBe('sdk-session-restored');
    await expect(
      adapter.resumeSession({
        sessionId: 'session-restore-1',
        state: SessionState.idle,
        context: createContext('discord-user-restore'),
        runtimeSessionId: 'sdk-session-restored'
      })
    ).resolves.toEqual({
      sessionId: 'session-restore-1',
      runtimeSessionId: 'sdk-session-restored'
    });
  });
});

describe('runner smoke helpers', () => {
  it('builds a read-only Sonnet validation prompt', () => {
    expect(buildSmokePrompt()).toContain('Return a one-line confirmation');
    expect(buildSmokePrompt()).toContain('Do not edit any files');
  });

  it('describes resume evidence explicitly for smoke logging', () => {
    expect(
      buildResumeEvidenceMessage({
        previousRuntimeSessionId: 'sdk-session-1',
        resumedRuntimeSessionId: 'sdk-session-1'
      })
    ).toContain('resumed runtime session sdk-session-1 from sdk-session-1');
  });

  it('extracts the runtime session id for smoke resume from a session.init event', () => {
    expect(
      findSmokeRuntimeSessionId([
        { type: 'text.delta', sessionId: 'smoke-session', messageId: 'msg-1', delta: 'hello' },
        { type: 'session.init', sessionId: 'smoke-session', runtimeSessionId: 'sdk-session-42' }
      ])
    ).toBe('sdk-session-42');
  });

  it('fails clearly when smoke resume cannot find a runtime session id', () => {
    expect(() => findSmokeRuntimeSessionId([])).toThrow(
      'Smoke resume requires a captured Claude runtime session id.'
    );
  });

  it('is explicit when callback wiring is configured but not auto-proven by the spike', () => {
    expect(
      describeCallbackProbeResult({
        supportsStructuredPermissions: true,
        supportsStructuredQuestions: true,
        provedPermissionCallback: false,
        provedQuestionCallback: false
      })
    ).toContain('configured in the adapter but were not auto-proven');
  });

  it('uses API key auth mode when ANTHROPIC_API_KEY is present', () => {
    expect(
      validateSmokeEnvironment({ ANTHROPIC_API_KEY: ' test-key ', CLAUDE_MODEL: 'haiku' })
    ).toEqual({ authMode: 'api-key', model: 'haiku' });
  });

  it('falls back to local Claude login auth mode when ANTHROPIC_API_KEY is missing', () => {
    expect(validateSmokeEnvironment({ ANTHROPIC_API_KEY: '' })).toEqual({
      authMode: 'local-login',
      model: 'sonnet'
    });
  });

  it('describes local Claude login auth mode explicitly for smoke logging', () => {
    expect(describeSmokeAuthMode('local-login')).toContain('local Claude login/subscription');
  });

  it('fails the spike when callback wiring is not actually proven', () => {
    expect(() =>
      validateClaudeSdkSpikeEvidence({
        sdkVersion: '0.2.83',
        hasInitEvent: true,
        partialTextEventCount: 1,
        supportsInterrupt: true,
        interruptProved: true,
        previousRuntimeSessionId: 'sdk-session-1',
        resumedRuntimeSessionId: 'sdk-session-1',
        supportsStructuredPermissions: true,
        supportsStructuredQuestions: true,
        provedPermissionCallback: false,
        provedQuestionCallback: false
      })
    ).toThrow('could not auto-prove permission/question callback wiring');
  });

  it('fails the spike when partial text translation or interrupt support is missing', () => {
    expect(() =>
      validateClaudeSdkSpikeEvidence({
        sdkVersion: '0.2.83',
        hasInitEvent: true,
        partialTextEventCount: 0,
        supportsInterrupt: false,
        interruptProved: false,
        previousRuntimeSessionId: 'sdk-session-1',
        resumedRuntimeSessionId: 'sdk-session-1',
        supportsStructuredPermissions: true,
        supportsStructuredQuestions: true,
        provedPermissionCallback: true,
        provedQuestionCallback: true
      })
    ).toThrow('missing translated partial text events; interrupt support is unavailable');
  });

  it('returns explicit pass evidence when the spike proves all required behaviors', () => {
    expect(
      validateClaudeSdkSpikeEvidence({
        sdkVersion: '0.2.83',
        hasInitEvent: true,
        partialTextEventCount: 2,
        supportsInterrupt: true,
        interruptProved: true,
        previousRuntimeSessionId: 'sdk-session-1',
        resumedRuntimeSessionId: 'sdk-session-1',
        supportsStructuredPermissions: true,
        supportsStructuredQuestions: true,
        provedPermissionCallback: true,
        provedQuestionCallback: true
      })
    ).toEqual([
      'Claude SDK version: 0.2.83',
      'Resume evidence: resumed runtime session sdk-session-1 from sdk-session-1.',
      'Partial text translation verified with 2 text.delta event(s).',
      'Interrupt support verified through the active query handle.',
      'Structured callback probe results: permission proved=true, question proved=true.'
    ]);
  });
});

function createAdapter(options?: { executablePath?: string }): ClaudeSdkAdapter {
  return createClaudeSdkAdapter(options);
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

function createMockQuery(events: unknown[], options?: { interrupt?: () => void }) {
  return {
    ...options,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield await event;
      }
    }
  };
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });

  return { promise, resolve };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
