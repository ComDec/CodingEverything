import { afterEach, describe, expect, it } from 'vitest';
import { createCommandHandlers } from '../../src/discord-control/command-handlers.js';
import { createDatabase, type Database } from '../../src/shared/db/database.js';
import { createRepositories } from '../../src/shared/db/repositories.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('command handlers', () => {
  it('creates a runner session for a Discord command', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({
      createSessionResult: { sessionId: 'session-1' }
    });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    const result = await handlers.handleCreateSession({
      channelId: 'thread-1',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      userId: 'discord-user-1',
      roleIds: ['operator']
    });

    expect(result).toEqual({ sessionId: 'session-1' });
    expect(runnerClient.createSessionCalls).toEqual([
      {
        channelId: 'thread-1',
        context: {
          cwd: '/workspace/app',
          allowedRoot: '/workspace',
          model: 'sonnet',
          runtimeOptions: { permissionMode: 'default' },
          createdBy: 'discord-user-1',
          displayName: 'pretty-fire'
        }
      }
    ]);
  });

  it('passes an explicit effort level into the session runtime options', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({
      createSessionResult: { sessionId: 'session-effort-1' }
    });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await handlers.handleCreateSession({
      channelId: 'thread-effort-1',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      effort: 'high' as 'high',
      userId: 'discord-user-1',
      roleIds: ['operator']
    } as any);

    expect(runnerClient.createSessionCalls.at(-1)).toEqual({
      channelId: 'thread-effort-1',
      context: {
        cwd: '/workspace/app',
        allowedRoot: '/workspace',
        model: 'sonnet',
        runtimeOptions: { permissionMode: 'default', effort: 'high' },
        createdBy: 'discord-user-1',
        displayName: 'pretty-fire'
      }
    });
  });

  it('passes normalized skills into the session runtime options', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({
      createSessionResult: { sessionId: 'session-skills-1' }
    });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await handlers.handleCreateSession({
      channelId: 'thread-skills-1',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      skills: ['project-memory', ' safe-bash ', '', 'project-memory'],
      userId: 'discord-user-1',
      roleIds: ['operator']
    } as any);

    expect(runnerClient.createSessionCalls.at(-1)).toEqual({
      channelId: 'thread-skills-1',
      context: {
        cwd: '/workspace/app',
        allowedRoot: '/workspace',
        model: 'sonnet',
        runtimeOptions: {
          permissionMode: 'default',
          skills: ['project-memory', 'safe-bash']
        },
        createdBy: 'discord-user-1',
        displayName: 'pretty-fire'
      }
    });
  });

  it('writes the resolved display name into session context', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({
      createSessionResult: { sessionId: 'session-name-1' }
    });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await handlers.handleCreateSession({
      channelId: 'thread-name-1',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      userId: 'discord-user-1',
      roleIds: ['operator']
    } as any);

    expect(runnerClient.createSessionCalls.at(-1)?.context.displayName).toBe('pretty-fire');
  });

  it('resolves a pending permission prompt', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble();
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    const result = await handlers.handleResolvePrompt({
      promptId: 'prompt-1',
      resolution: 'allow_once',
      userId: 'discord-user-1',
      roleIds: ['operator']
    });

    expect(result).toEqual({ status: 'resolved' });
    expect(runnerClient.resolvePromptCalls).toEqual([
      {
        promptId: 'prompt-1',
        resolution: 'allow_once'
      }
    ]);
  });

  it('surfaces stale prompt resolution status', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({ resolvePromptStatus: 'stale' });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    const result = await handlers.handleResolvePrompt({
      promptId: 'prompt-stale',
      resolution: 'allow_once',
      userId: 'discord-user-1',
      roleIds: ['operator']
    });

    expect(result).toEqual({ status: 'stale' });
  });

  it('rejects unauthorized permission resolutions', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble();
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => false
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await expect(
      handlers.handleResolvePrompt({
        promptId: 'prompt-unauthorized',
        resolution: 'allow_once',
        userId: 'discord-user-3',
        roleIds: []
      })
    ).rejects.toThrow('User is not authorized to resolve prompts');
    expect(runnerClient.resolvePromptCalls).toEqual([]);
  });

  it('answers a pending question', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble();
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    const result = await handlers.handleAnswerQuestion({
      promptId: 'prompt-9',
      answer: 'yes',
      userId: 'discord-user-1',
      roleIds: ['operator']
    });

    expect(result).toEqual({ status: 'answered' });
    expect(runnerClient.answerQuestionCalls).toEqual([
      {
        promptId: 'prompt-9',
        answer: 'yes'
      }
    ]);
  });

  it('rejects unauthorized question answers', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble();
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => false
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await expect(
      handlers.handleAnswerQuestion({
        promptId: 'prompt-10',
        answer: 'no',
        userId: 'discord-user-4',
        roleIds: []
      })
    ).rejects.toThrow('User is not authorized to answer questions');
    expect(runnerClient.answerQuestionCalls).toEqual([]);
  });

  it('rejects unauthorized session creation attempts', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble();
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => false
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await expect(
      handlers.handleCreateSession({
        channelId: 'thread-2',
        cwd: '/workspace/app',
        model: 'sonnet',
        displayName: 'pretty-fire',
        userId: 'discord-user-2',
        roleIds: []
      })
    ).rejects.toThrow('User is not authorized to create sessions');
    expect(runnerClient.createSessionCalls).toEqual([]);
  });

  it('audits sensitive command actions', async () => {
    const { database, repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({
      createSessionResult: { sessionId: 'session-7' }
    });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await handlers.handleCreateSession({
      channelId: 'thread-7',
      cwd: '/workspace/app',
      model: 'sonnet',
      displayName: 'pretty-fire',
      userId: 'discord-user-7',
      roleIds: ['admin']
    });
    await handlers.handleResolvePrompt({
      promptId: 'prompt-7',
      resolution: 'allow_once',
      userId: 'discord-user-7',
      sessionId: 'session-7',
      roleIds: ['admin']
    });
    await handlers.handleAnswerQuestion({
      promptId: 'prompt-8',
      answer: 'yes',
      userId: 'discord-user-7',
      sessionId: 'session-7',
      roleIds: ['admin']
    });

    const auditRows = database
      .prepare(
        `SELECT action, actor_id, source, session_id, metadata_json FROM audit_log ORDER BY id ASC`
      )
      .all() as Array<{
      action: string;
      actor_id: string;
      source: string;
      session_id: string | null;
      metadata_json: string;
    }>;

    expect(auditRows).toEqual([
      {
        action: 'discord.session.create',
        actor_id: 'discord-user-7',
        source: 'discord-control',
        session_id: 'session-7',
        metadata_json: JSON.stringify({
          channelId: 'thread-7',
          cwd: '/workspace/app',
          model: 'sonnet'
        })
      },
      {
        action: 'discord.prompt.resolve',
        actor_id: 'discord-user-7',
        source: 'discord-control',
        session_id: 'session-7',
        metadata_json: JSON.stringify({
          promptId: 'prompt-7',
          resolution: 'allow_once'
        })
      },
      {
        action: 'discord.question.answer',
        actor_id: 'discord-user-7',
        source: 'discord-control',
        session_id: 'session-7',
        metadata_json: JSON.stringify({
          promptId: 'prompt-8',
          answer: 'yes'
        })
      }
    ]);
  });

  it('uses configured allowed roots instead of trusting user supplied root values', async () => {
    const { repositories } = createTestContext();
    const runnerClient = createRunnerClientDouble({
      createSessionResult: { sessionId: 'session-secure' }
    });
    const handlers = createCommandHandlers({
      runnerClient,
      audit: repositories.audit,
      access: {
        canManageSessions: () => true
      },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await expect(
      handlers.handleCreateSession({
        channelId: 'thread-secure',
        cwd: '/tmp/outside',
        model: 'sonnet',
        displayName: 'pretty-fire',
        userId: 'discord-user-8',
        roleIds: ['operator']
      })
    ).rejects.toThrow('Path is outside the allowed roots.');

    await handlers.handleCreateSession({
      channelId: 'thread-secure',
      cwd: '/workspace/project',
      model: 'sonnet',
      displayName: 'pretty-fire',
      userId: 'discord-user-8',
      roleIds: ['operator']
    });

    expect(runnerClient.createSessionCalls).toEqual([
      {
        channelId: 'thread-secure',
        context: {
          cwd: '/workspace/project',
          allowedRoot: '/workspace',
          model: 'sonnet',
          runtimeOptions: { permissionMode: 'default' },
          createdBy: 'discord-user-8',
          displayName: 'pretty-fire'
        }
      }
    ]);
  });
});

function createTestContext() {
  const database = createDatabase({ filename: ':memory:' });
  databases.push(database);

  return {
    database,
    repositories: createRepositories(database)
  };
}

function createRunnerClientDouble(options?: {
  createSessionResult?: { sessionId: string };
  resolvePromptStatus?: 'resolved' | 'already_resolved' | 'stale';
}) {
  const createSessionCalls: Array<{
    channelId: string;
    context: {
      cwd: string;
      allowedRoot: string;
      model: string;
      runtimeOptions: { permissionMode: string };
      createdBy: string;
      displayName?: string;
    };
  }> = [];
  const resolvePromptCalls: Array<{
    promptId: string;
    resolution: 'allow_once' | 'deny_once';
  }> = [];
  const answerQuestionCalls: Array<{
    promptId: string;
    answer: string;
  }> = [];

  return {
    createSessionCalls,
    resolvePromptCalls,
    answerQuestionCalls,
    async createSession(input: {
      channelId: string;
        context: {
          cwd: string;
          allowedRoot: string;
          model: string;
          runtimeOptions: { permissionMode: string };
          createdBy: string;
          displayName?: string;
        };
      }) {
      createSessionCalls.push(input);
      return options?.createSessionResult ?? { sessionId: 'session-1' };
    },
    async resolvePrompt(input: { promptId: string; resolution: 'allow_once' | 'deny_once' }) {
      resolvePromptCalls.push(input);
      return { status: options?.resolvePromptStatus ?? 'resolved' };
    },
    async answerQuestion(input: { promptId: string; answer: string }) {
      answerQuestionCalls.push(input);
    }
  };
}
