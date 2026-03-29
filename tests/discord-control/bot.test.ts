import { describe, expect, it, vi } from 'vitest';
import { createDiscordControlBot, listDiscordCommandDefinitions } from '../../src/discord-control/bot.js';
import { createCommandHandlers } from '../../src/discord-control/command-handlers.js';
import type { RunnerEventEnvelope } from '../../src/discord-control/runner-client.js';

describe('discord control bot', () => {
  it('logs in, registers commands, and creates a thread-backed session from a slash command', async () => {
    const events = createEventBus();
    const registerCalls: string[][] = [];
    const registeredCommands: Array<{ name: string; options: Array<{ name: string }> }> = [];
    const createSessionCalls: Array<{ channelId: string; userId: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({ channelId: input.channelId, userId: input.context.createdBy });
          return { sessionId: 'session-1' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-1');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(channel);
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        subscribeEvents({ abortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) {
                  resolve();
                  return;
                }

                abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              });
            }
          };
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: {
        getByThreadId() {
          return null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async (commands) => {
          registerCalls.push(commands.map((command) => command.name));
          registeredCommands.push(...commands.map((command) => ({
            name: command.name,
            options: (command.options ?? []).map((option) => ({ name: option.name }))
          })));
        }
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(events.loginCalls).toEqual(['discord-token']);
    expect(registerCalls).toEqual([['session-new']]);
    expect(registeredCommands[0]?.options.map((option) => option.name)).toEqual([
      'cwd',
      'name',
      'model',
      'effort',
      'skills'
    ]);
    expect(createSessionCalls).toEqual([{ channelId: 'thread-1', userId: 'discord-user-1' }]);
    expect(channel.createdThreadNames).toEqual(['pretty-fire']);
    expect(thread.sentMessages).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Session session-1\nname: pretty-fire\ncwd: /workspace/app\nmodel: sonnet\neffort: default\nskills: none'
          })
        ]
      })
    ]);
    expect(interaction.replies).toEqual([
      {
        content: 'Session session-1 created in thread thread-1.',
        ephemeral: true
      }
    ]);
  });

  it('stores a thread binding so later thread messages continue the created session', async () => {
    const events = createEventBus();
    const sendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
    const bindingMap = new Map<string, { threadId: string; sessionId: string; createdAt: string; updatedAt: string }>();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-thread-binding-1' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-binding-1');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(channel);
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn(input) {
          sendTurnCalls.push(input);
        },
        async getSession() {
          return { sessionId: 'session-thread-binding-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return bindingMap.get(threadId) ?? null;
        },
        upsert(record) {
          bindingMap.set(record.threadId, record);
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);
    await events.emit('messageCreate', {
      author: { id: 'discord-user-1', bot: false },
      content: 'hi',
      channelId: 'thread-binding-1',
      channel: thread,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(sendTurnCalls).toEqual([
      { sessionId: 'session-thread-binding-1', prompt: 'hi' }
    ]);
  });

  it('continues a named session after restart from persisted binding without creating a new thread', async () => {
    const initialCreateSessionCalls: number[] = [];
    const restartedCreateSessionCalls: number[] = [];
    const sendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
    const bindingMap = new Map<string, { threadId: string; sessionId: string; createdAt: string; updatedAt: string }>();
    const thread = createFakeThread('thread-explicit-name-1');
    const { channel, startBot, emitInteraction } = createNamedSessionHarness({
      thread,
      bindingMap,
      createSessionCalls: initialCreateSessionCalls,
      sessionId: 'session-explicit-name-1',
      interactionValues: {
        cwd: '/workspace/app',
        model: 'sonnet',
        name: 'Deploy War Room'
      }
    });

    await startBot();
    await emitInteraction();

    expect(bindingMap.get('thread-explicit-name-1')).toEqual({
      threadId: 'thread-explicit-name-1',
      sessionId: 'session-explicit-name-1',
      createdAt: '2026-03-25T00:00:00.000Z',
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    const restartedHarness = createNamedSessionHarness({
      thread,
      bindingMap,
      sendTurnCalls,
      createSessionCalls: restartedCreateSessionCalls,
      sessionId: 'session-explicit-name-1',
      interactionValues: {
        cwd: '/workspace/app',
        model: 'sonnet',
        name: 'Deploy War Room'
      }
    });

    await restartedHarness.startBot();
    await restartedHarness.emitMessage('hi');

    expect(channel.createdThreadNames).toEqual(['deploy-war-room']);
    expect(restartedHarness.threadChannel.sentContents).toHaveLength(1);
    expect(isWaitingPlaceholderFrame(restartedHarness.threadChannel.sentContents[0] ?? '')).toBe(true);
    expect(thread.sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })]
      })
    ]));
    expect(initialCreateSessionCalls).toEqual([1]);
    expect(restartedCreateSessionCalls).toEqual([]);
    expect(sendTurnCalls).toEqual([
      { sessionId: 'session-explicit-name-1', prompt: 'hi' }
    ]);
  });

  it('continues a named session immediately after creation for the first follow-up thread message', async () => {
    const createSessionCalls: number[] = [];
    const sendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
    const bindingMap = new Map<string, { threadId: string; sessionId: string; createdAt: string; updatedAt: string }>();
    const thread = createFakeThread('thread-explicit-name-immediate-1');
    const harness = createNamedSessionHarness({
      thread,
      bindingMap,
      sendTurnCalls,
      createSessionCalls,
      sessionId: 'session-explicit-name-immediate-1',
      interactionValues: {
        cwd: '/workspace/app',
        model: 'sonnet',
        name: 'Deploy War Room'
      }
    });

    await harness.startBot();
    await harness.emitInteraction();
    await harness.emitMessage('hi');

    expect(bindingMap.get('thread-explicit-name-immediate-1')).toEqual({
      threadId: 'thread-explicit-name-immediate-1',
      sessionId: 'session-explicit-name-immediate-1',
      createdAt: '2026-03-25T00:00:00.000Z',
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
    expect(harness.channel.createdThreadNames).toEqual(['deploy-war-room']);
    expect(harness.threadChannel.sentContents).toHaveLength(1);
    expect(isWaitingPlaceholderFrame(harness.threadChannel.sentContents[0] ?? '')).toBe(true);
    expect(thread.sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })]
      })
    ]));
    expect(createSessionCalls).toEqual([1]);
    expect(sendTurnCalls).toEqual([
      { sessionId: 'session-explicit-name-immediate-1', prompt: 'hi' }
    ]);
  });

  it('uses the resolved display name for new thread creation and summary rendering', async () => {
    const thread = createFakeThread('thread-explicit-name-1');
    const { channel, interaction, startBot, emitInteraction } = createNamedSessionHarness({
      thread,
      sessionId: 'session-explicit-name-1',
      interactionValues: {
        cwd: '/workspace/app',
        model: 'sonnet',
        name: 'Deploy War Room'
      }
    });

    await startBot();
    await emitInteraction();

    expect(channel.createdThreadNames).toEqual(['deploy-war-room']);
    expect(thread.sentMessages).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })]
      })
    ]);
  });

  it('falls back to a generated display name when name is omitted', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-generated-name-1' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-generated-name-1');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(channel, {
      values: { cwd: '/workspace/app', model: 'sonnet' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-generated-name-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(channel.createdThreadNames).toEqual(['pretty-fire']);
  });

  it('keeps an existing thread title unchanged while still storing the resolved display name', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-existing-thread-1' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const existingThread = createFakeThread('thread-existing');
    const interaction = createCreateSessionInteraction(existingThread as any, {
      values: { cwd: '/workspace/app', model: 'sonnet', name: 'Deploy War Room' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-existing-thread-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(existingThread.sentMessages).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('name: deploy-war-room') })]
      })
    ]);
  });

  it('creates a session even when the slash interaction only has channelId and requires channel fetch', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({ channelId: input.channelId, userId: input.context.createdBy });
          return { sessionId: 'session-2' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-2');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(undefined, { channelId: 'channel-2' });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        subscribeEvents({ abortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) {
                  resolve();
                  return;
                }

                abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              });
            }
          };
        },
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-2', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async (channelId) => channelId === 'channel-2' ? channel : null
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(createSessionCalls).toEqual([{ channelId: 'thread-2', userId: 'discord-user-1' }]);
    expect(interaction.replies).toEqual([
      {
        content: 'Session session-2 created in thread thread-2.',
        ephemeral: true
      }
    ]);
  });

  it('does not create a thread for an unauthorized session-new request', async () => {
    const createSessionCalls: number[] = [];
    const { channel, interaction, startBot, emitInteraction } = createRejectedSessionNewHarness({
      canManageSessions: false,
      createSessionCalls,
      interaction: {
        channelId: 'channel-unauthorized',
        userId: 'discord-user-2',
        roleIds: []
      }
    });

    await startBot();
    await emitInteraction();

    expect(interaction.replies).toEqual([
      {
        content: 'User is not authorized to create sessions',
        ephemeral: true
      }
    ]);
    expect(channel.createdThreadNames).toEqual([]);
    expect(createSessionCalls).toEqual([]);
  });

  it('does not create a thread for an invalid cwd session-new request', async () => {
    const createSessionCalls: number[] = [];
    const { channel, interaction, startBot, emitInteraction } = createRejectedSessionNewHarness({
      createSessionCalls,
      interaction: {
        channelId: 'channel-invalid',
        values: { cwd: '/tmp/not-allowed', model: 'sonnet' }
      }
    });

    await startBot();
    await emitInteraction();

    expect(interaction.replies).toEqual([
      {
        content: 'Path is outside the allowed roots.',
        ephemeral: true
      }
    ]);
    expect(channel.createdThreadNames).toEqual([]);
    expect(createSessionCalls).toEqual([]);
  });

  it('creates a session without touching interaction.channel when that getter throws', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({ channelId: input.channelId, userId: input.context.createdBy });
          return { sessionId: 'session-3' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-3');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(channel, {
      channelId: 'channel-3',
      throwOnChannelAccess: true
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-3', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async (channelId) => channelId === 'channel-3' ? channel : null
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(createSessionCalls).toEqual([{ channelId: 'thread-3', userId: 'discord-user-1' }]);
    expect(interaction.replies).toEqual([
      {
        content: 'Session session-3 created in thread thread-3.',
        ephemeral: true
      }
    ]);
  });

  it('preserves the thread manager this-binding when creating a thread from a fetched channel', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({ channelId: input.channelId, userId: input.context.createdBy });
          return { sessionId: 'session-4' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const interaction = createCreateSessionInteraction(undefined, { channelId: 'channel-4' });
    const channel = {
      isThread: () => false,
      threads: {
        channel: { id: 'channel-4' },
        async create(this: { channel?: { id: string } }, input: { name: string }) {
          if (!this.channel) {
            throw new Error('thread manager lost its channel binding');
          }

          return {
            id: 'thread-4',
            name: input.name,
            isThread: () => true,
            async send() {
              return;
            }
          };
        }
      }
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-4', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async (channelId) => channelId === 'channel-4' ? channel : null
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(createSessionCalls).toEqual([{ channelId: 'thread-4', userId: 'discord-user-1' }]);
    expect(interaction.replies).toEqual([
      {
        content: 'Session session-4 created in thread thread-4.',
        ephemeral: true
      }
    ]);
  });

  it('shows a picker-first session-new wizard when cwd is omitted', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({ channelId: input.channelId, userId: input.context.createdBy });
          return { sessionId: 'session-wizard' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-wizard');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(channel, {
      values: { cwd: null, model: 'haiku', effort: 'high', skills: 'git,notes' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        subscribeEvents({ abortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) {
                  resolve();
                  return;
                }

                abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              });
            }
          };
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-wizard', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: {
        getByThreadId() {
          return null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(createSessionCalls).toEqual([]);
    expect(channel.createdThreadNames).toEqual([]);
    expect(interaction.replies).toEqual([
      expect.objectContaining({
        ephemeral: true,
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Choose how to pick a working directory before choosing model, effort, and skills.'
          })
        ]
      })
    ]);
    expect(collectButtonLabels(interaction.replies[0]?.components ?? [])).toEqual(['Use history', 'Search new', 'Manual input']);
  });

  it('opens manual cwd input and then shows session options with defaults', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-manual-wizard' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-manual-wizard'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-manual-wizard',
      values: { cwd: null }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-manual-wizard', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const manualButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[2] ?? '');
    await events.emit('interactionCreate', manualButton);

    expect(manualButton.replies).toEqual([]);
    expect(manualButton.updates).toEqual([]);
    expect(manualButton.modals).toEqual([
      expect.objectContaining({
        custom_id: expect.stringMatching(/^session-new:modal:manual:[^:]+$/),
        title: 'Enter workdir path'
      })
    ]);

    const modalInteraction = createModalSubmitInteraction(
      String(manualButton.modals[0]?.custom_id ?? ''),
      { cwd: '/workspace/manual-app' }
    );
    await events.emit('interactionCreate', modalInteraction);

    expect(modalInteraction.replies).toEqual([
      {
        ephemeral: true,
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Review session options before creating the new session.\nworkdir: /workspace/manual-app\nmodel: sonnet\neffort: default\nskills: none'
          })
        ],
        components: expect.any(Array)
      }
    ]);
    expect(collectButtonLabels(modalInteraction.replies[0]?.components ?? [])).toEqual(['Model', 'Effort', 'Skills', 'Create session']);
  });

  it('lets the user customize model, effort, and skills before creating the session', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{
      channelId: string;
      userId: string;
      cwd: string;
      model: string;
      effort?: string;
      skills: readonly string[];
    }> = [];
    const saveWorkdirCalls: Array<{ path: string; displayName?: string; createdBy: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd,
            model: input.context.model,
            effort: input.context.runtimeOptions.effort,
            skills: input.context.runtimeOptions.skills ?? [],
          });
          return { sessionId: 'session-custom-options' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-custom-options'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-custom-options',
      values: { cwd: null }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          saveWorkdirCalls.push(input);
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-custom-options', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const manualButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[2] ?? '');
    await events.emit('interactionCreate', manualButton);

    const cwdModal = createModalSubmitInteraction(String(manualButton.modals[0]?.custom_id ?? ''), { cwd: '/workspace/custom-options-app' });
    await events.emit('interactionCreate', cwdModal);

    const modelButton = createButtonInteraction(findButtonCustomIdByLabel(cwdModal.replies[0]?.components ?? [], 'Model') ?? '');
    await events.emit('interactionCreate', modelButton);
    const modelSelect = createStringSelectInteraction(
      collectStringSelectCustomIds(modelButton.updates[0]?.components ?? [])[0] ?? '',
      ['opus']
    );
    await events.emit('interactionCreate', modelSelect);

    const effortButton = createButtonInteraction(findButtonCustomIdByLabel(modelSelect.updates[0]?.components ?? [], 'Effort') ?? '');
    await events.emit('interactionCreate', effortButton);
    const effortSelect = createStringSelectInteraction(
      collectStringSelectCustomIds(effortButton.updates[0]?.components ?? [])[0] ?? '',
      ['max']
    );
    await events.emit('interactionCreate', effortSelect);

    const skillsButton = createButtonInteraction(findButtonCustomIdByLabel(effortSelect.updates[0]?.components ?? [], 'Skills') ?? '');
    await events.emit('interactionCreate', skillsButton);
    const skillsModal = createModalSubmitInteraction(String(skillsButton.modals[0]?.custom_id ?? ''), { skills: 'git, notes' });
    await events.emit('interactionCreate', skillsModal);

    const createButton = createButtonInteraction(findButtonCustomIdByLabel(skillsModal.replies[0]?.components ?? [], 'Create session') ?? '');
    await events.emit('interactionCreate', createButton);

    expect(saveWorkdirCalls).toEqual([
      { path: '/workspace/custom-options-app', displayName: 'custom-options-app', createdBy: 'discord-user-1' }
    ]);
    expect(createSessionCalls).toEqual([
      {
        channelId: 'thread-custom-options',
        userId: 'discord-user-1',
        cwd: '/workspace/custom-options-app',
        model: 'opus',
        effort: 'max',
        skills: ['git', 'notes']
      }
    ]);
  });

  it('keeps session-new compatible with direct creation when cwd is supplied', async () => {
    expect(listDiscordCommandDefinitions()).toContainEqual(
      expect.objectContaining({
        name: 'session-new',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'cwd',
            required: false
          })
        ])
      })
    );

    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-compat' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-compat');
    const channel = createFakeChannel(thread);
    const interaction = createCreateSessionInteraction(channel, {
      values: { cwd: '/workspace/compat', model: 'sonnet' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        subscribeEvents({ abortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) {
                  resolve();
                  return;
                }

                abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              });
            }
          };
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-compat', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: {
        getByThreadId() {
          return null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(createSessionCalls).toEqual([
      { channelId: 'thread-compat', userId: 'discord-user-1', cwd: '/workspace/compat' }
    ]);
    expect(channel.createdThreadNames).toEqual(['pretty-fire']);
    expect(interaction.replies).toEqual([
      {
        content: 'Session session-compat created in thread thread-compat.',
        ephemeral: true
      }
    ]);
  });

  it('loads saved workdirs for the session-new history picker and paginates results', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-history' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-history'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history',
      values: { cwd: null, model: 'haiku', effort: 'high', skills: 'git,notes' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return Array.from({ length: 26 }, (_, index) => ({
            id: `workdir-${index + 1}`,
            path: `/workspace/history-${index + 1}`,
            displayName: `History ${index + 1}`,
            source: 'scan' as const,
            createdBy: 'discord-user-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z',
            lastUsedAt: '2026-03-25T00:00:00.000Z',
            useCount: 1
          }));
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    expect(extractEmbedDescriptions(buttonInteraction.updates[0]?.embeds ?? [])).toEqual([
      'Choose a saved working directory for the new session.'
    ]);
    expect(collectStringSelectCustomIds(buttonInteraction.updates[0]?.components ?? [])).toEqual([
      expect.stringMatching(/^session-new:select:history:[^:]+$/)
    ]);
    expect(collectStringSelectOptionLabels(buttonInteraction.updates[0]?.components ?? [])).toEqual(
      Array.from({ length: 25 }, (_, index) => `History ${index + 1}`)
    );
    expect(collectButtonLabels(buttonInteraction.updates[0]?.components ?? [])).toEqual(['Back', 'Next']);

    const nextPageInteraction = createButtonInteraction(
      findButtonCustomIdByLabel(buttonInteraction.updates[0]?.components ?? [], 'Next') ?? ''
    );
    await events.emit('interactionCreate', nextPageInteraction);

    expect(collectStringSelectOptionLabels(nextPageInteraction.updates[0]?.components ?? [])).toEqual(['History 26']);
    expect(collectButtonLabels(nextPageInteraction.updates[0]?.components ?? [])).toEqual(['Back', 'Previous']);

    const previousPageInteraction = createButtonInteraction(
      findButtonCustomIdByLabel(nextPageInteraction.updates[0]?.components ?? [], 'Previous') ?? ''
    );
    await events.emit('interactionCreate', previousPageInteraction);

    expect(collectStringSelectOptionLabels(previousPageInteraction.updates[0]?.components ?? [])).toEqual(
      Array.from({ length: 25 }, (_, index) => `History ${index + 1}`)
    );
    expect(collectButtonLabels(previousPageInteraction.updates[0]?.components ?? [])).toEqual(['Back', 'Next']);
  });

  it('lets the user go back from the history picker to the source picker', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-history-back' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const interaction = createCreateSessionInteraction(undefined, {
      channelId: 'channel-history-back',
      values: { cwd: null }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [{
            id: 'history-1',
            path: '/workspace/history-1',
            displayName: 'History 1',
            source: 'scan' as const,
            createdBy: 'discord-user-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z',
            lastUsedAt: '2026-03-25T00:00:00.000Z',
            useCount: 1
          }];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-back', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as Parameters<typeof createDiscordControlBot>[0]['runnerClient'],
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    const historyButton = createButtonInteraction(findButtonCustomIdByLabel(interaction.replies[0]?.components ?? [], 'Use history') ?? '');
    await events.emit('interactionCreate', historyButton);

    const backButton = createButtonInteraction(findButtonCustomIdByLabel(historyButton.updates[0]?.components ?? [], 'Back') ?? '');
    await events.emit('interactionCreate', backButton);

    expect(collectButtonLabels(backButton.updates[0]?.components ?? [])).toEqual(['Use history', 'Search new', 'Manual input']);
  });

  it('shows a short message when session-new history is unavailable', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-history-unavailable' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-history-unavailable'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-unavailable',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-unavailable', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    expect(buttonInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Saved workdir history is unavailable right now.'
          })
        ],
        components: []
      }
    ]);
  });

  it('shows the same short message when session-new history loading rejects', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-history-rejected' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-history-rejected'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-rejected',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          throw new Error('not supported');
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-rejected', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    expect(buttonInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Saved workdir history is unavailable right now.'
          })
        ],
        components: []
      }
    ]);
  });

  it('shows a short message when session-new history is empty', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-history-empty' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-history-empty'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-empty',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-empty', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    expect(buttonInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'No saved workdirs are available yet.'
          })
        ],
        components: []
      }
    ]);
  });

  it('loads paginated scan results for the session-new scan picker and stores the selected path', async () => {
    const events = createEventBus();
    const scanCalls: Array<{ offset?: number; limit?: number }> = [];
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const saveWorkdirCalls: Array<{ path: string; displayName?: string; createdBy: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-search' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-search'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-search',
      values: { cwd: null, model: 'opus', skills: 'review' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: ({
        async scanWorkdirs(input: { offset?: number; limit?: number }) {
          scanCalls.push(input);
          const offset = input.offset ?? 0;

          if (offset === 0) {
            return {
              items: Array.from({ length: 25 }, (_, index) => ({
                path: `/workspace/scan-${index + 1}`,
                displayName: `Scan ${index + 1}`,
                score: 100 - index,
              })),
              nextOffset: 25
            };
          }

          return {
            items: [
              {
                path: '/workspace/scan-26',
                displayName: 'Scan 26',
                score: 74
              }
            ],
            nextOffset: null
          };
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          saveWorkdirCalls.push(input);
          return createSavedWorkdirResult(input);
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-search', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as unknown as Parameters<typeof createDiscordControlBot>[0]['runnerClient']),
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const searchButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', searchButton);

    expect(scanCalls).toEqual([{ offset: 0, limit: 25 }]);
    expect(extractEmbedDescriptions(searchButton.updates[0]?.embeds ?? [])).toEqual([
      'Choose a newly discovered working directory for the new session.'
    ]);
    expect(collectStringSelectOptionLabels(searchButton.updates[0]?.components ?? [])).toEqual(
      Array.from({ length: 25 }, (_, index) => `Scan ${index + 1}`)
    );
    expect(collectButtonLabels(searchButton.updates[0]?.components ?? [])).toEqual(['Back', 'Next']);

    const nextPageButton = createButtonInteraction(
      findButtonCustomIdByLabel(searchButton.updates[0]?.components ?? [], 'Next') ?? ''
    );
    await events.emit('interactionCreate', nextPageButton);

    expect(scanCalls).toEqual([
      { offset: 0, limit: 25 },
      { offset: 25, limit: 25 }
    ]);
    expect(collectStringSelectOptionLabels(nextPageButton.updates[0]?.components ?? [])).toEqual(['Scan 26']);
    expect(collectButtonLabels(nextPageButton.updates[0]?.components ?? [])).toEqual(['Back', 'Previous']);

    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(nextPageButton.updates[0]?.components ?? [])[0] ?? '',
      [collectStringSelectOptionValues(nextPageButton.updates[0]?.components ?? [])[0] ?? '']
    );
    await events.emit('interactionCreate', selectInteraction);

    expect(selectInteraction.modals).toEqual([
      {
        custom_id: expect.stringMatching(/^session-new:modal:rename:[^:]+$/),
        title: 'Rename workdir',
        components: expect.any(Array)
      }
    ]);

    const modalInteraction = createModalSubmitInteraction(
      String(selectInteraction.modals[0]?.custom_id ?? ''),
      { displayName: 'Scan 26 Saved' }
    );
    await events.emit('interactionCreate', modalInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(modalInteraction.replies[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(saveWorkdirCalls).toEqual([
      { path: '/workspace/scan-26', displayName: 'Scan 26 Saved', createdBy: 'discord-user-1' }
    ]);
    expect(createSessionCalls).toEqual([
      { channelId: 'thread-search', userId: 'discord-user-1', cwd: '/workspace/scan-26' }
    ]);
  });

  it('lets the user go back from the scan picker to the source picker', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-scan-back' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const interaction = createCreateSessionInteraction(undefined, {
      channelId: 'channel-scan-back',
      values: { cwd: null }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: ({
        async scanWorkdirs() {
          return {
            items: [{ path: '/workspace/scan-1', displayName: 'Scan 1', score: 100 }],
            nextOffset: null
          };
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-scan-back', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as unknown as Parameters<typeof createDiscordControlBot>[0]['runnerClient']),
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    const searchButton = createButtonInteraction(findButtonCustomIdByLabel(interaction.replies[0]?.components ?? [], 'Search new') ?? '');
    await events.emit('interactionCreate', searchButton);

    const backButton = createButtonInteraction(findButtonCustomIdByLabel(searchButton.updates[0]?.components ?? [], 'Back') ?? '');
    await events.emit('interactionCreate', backButton);

    expect(collectButtonLabels(backButton.updates[0]?.components ?? [])).toEqual(['Use history', 'Search new', 'Manual input']);
  });

  it('opens a rename modal and defaults blank rename submissions to the scanned path basename', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const saveWorkdirCalls: Array<{ path: string; displayName?: string; createdBy: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-rename-default' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-rename-default');
    const channel = createFakeChannel(thread);
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-rename-default',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [];
        },
        async scanWorkdirs() {
          return {
            items: [
              {
                path: '/workspace/projects/renamed-app',
                displayName: 'Scanned App',
                score: 100
              }
            ],
            nextOffset: null
          };
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          saveWorkdirCalls.push(input);
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-rename-default', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const searchButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', searchButton);
    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(searchButton.updates[0]?.components ?? [])[0] ?? '',
      [collectStringSelectOptionValues(searchButton.updates[0]?.components ?? [])[0] ?? '']
    );
    await events.emit('interactionCreate', selectInteraction);

    expect(selectInteraction.modals).toEqual([
      expect.objectContaining({
        custom_id: expect.stringMatching(/^session-new:modal:rename:[^:]+$/),
        title: 'Rename workdir'
      })
    ]);

    const modalInteraction = createModalSubmitInteraction(
      String(selectInteraction.modals[0]?.custom_id ?? ''),
      { displayName: '   ' }
    );
    await events.emit('interactionCreate', modalInteraction);

    expect(saveWorkdirCalls).toEqual([]);
    expect(createSessionCalls).toEqual([]);
    expect(modalInteraction.replies).toEqual([
      {
        ephemeral: true,
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Review session options before creating the new session.\nworkdir: /workspace/projects/renamed-app\nmodel: haiku\neffort: default\nskills: none'
          })
        ],
        components: expect.any(Array)
      }
    ]);
    expect(collectButtonLabels(modalInteraction.replies[0]?.components ?? [])).toEqual(['Model', 'Effort', 'Skills', 'Create session']);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(modalInteraction.replies[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(saveWorkdirCalls).toEqual([
      { path: '/workspace/projects/renamed-app', displayName: 'renamed-app', createdBy: 'discord-user-1' }
    ]);
    expect(createSessionCalls).toEqual([
      { channelId: 'thread-rename-default', userId: 'discord-user-1', cwd: '/workspace/projects/renamed-app' }
    ]);
  });

  it('uses the submitted rename when the scan rename modal has a custom name', async () => {
    const events = createEventBus();
    const saveWorkdirCalls: Array<{ path: string; displayName?: string; createdBy: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-rename-custom' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-rename-custom'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-rename-custom',
      values: { cwd: null, model: 'sonnet' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [];
        },
        async scanWorkdirs() {
          return {
            items: [
              {
                path: '/workspace/projects/custom-app',
                displayName: 'Custom App',
                score: 100
              }
            ],
            nextOffset: null
          };
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          saveWorkdirCalls.push(input);
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-rename-custom', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const searchButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', searchButton);
    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(searchButton.updates[0]?.components ?? [])[0] ?? '',
      [collectStringSelectOptionValues(searchButton.updates[0]?.components ?? [])[0] ?? '']
    );
    await events.emit('interactionCreate', selectInteraction);
    const modalInteraction = createModalSubmitInteraction(
      String(selectInteraction.modals[0]?.custom_id ?? ''),
      { displayName: 'Team Favorite' }
    );
    await events.emit('interactionCreate', modalInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(modalInteraction.replies[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(saveWorkdirCalls).toEqual([
      { path: '/workspace/projects/custom-app', displayName: 'Team Favorite', createdBy: 'discord-user-1' }
    ]);
  });

  it('preserves an existing custom rename when the scan rename modal is submitted blank', async () => {
    const events = createEventBus();
    const saveWorkdirCalls: Array<{ path: string; displayName?: string; createdBy: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-rename-preserve' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-rename-preserve'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-rename-preserve',
      values: { cwd: null, model: 'opus' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'saved-custom-app',
              path: '/workspace/projects/custom-preserved',
              displayName: 'Existing Custom Name',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 2
            }
          ];
        },
        async scanWorkdirs() {
          return {
            items: [
              {
                path: '/workspace/projects/custom-preserved',
                displayName: 'Scanner Label',
                score: 100
              }
            ],
            nextOffset: null
          };
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          saveWorkdirCalls.push(input);
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-rename-preserve', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const searchButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', searchButton);
    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(searchButton.updates[0]?.components ?? [])[0] ?? '',
      [collectStringSelectOptionValues(searchButton.updates[0]?.components ?? [])[0] ?? '']
    );
    await events.emit('interactionCreate', selectInteraction);
    const modalInteraction = createModalSubmitInteraction(
      String(selectInteraction.modals[0]?.custom_id ?? ''),
      { displayName: '   ' }
    );
    await events.emit('interactionCreate', modalInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(modalInteraction.replies[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(saveWorkdirCalls).toEqual([
      { path: '/workspace/projects/custom-preserved', displayName: 'Existing Custom Name', createdBy: 'discord-user-1' }
    ]);
  });

  it('shows a short message when saving after a scan rename fails', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-rename-save-fail' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-rename-save-fail'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-rename-save-fail',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [];
        },
        async scanWorkdirs() {
          return {
            items: [
              {
                path: '/workspace/projects/fail-save',
                displayName: 'Fail Save',
                score: 100
              }
            ],
            nextOffset: null
          };
        },
        async saveWorkdir() {
          throw new Error('database unavailable');
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-rename-save-fail', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const searchButton = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', searchButton);
    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(searchButton.updates[0]?.components ?? [])[0] ?? '',
      [collectStringSelectOptionValues(searchButton.updates[0]?.components ?? [])[0] ?? '']
    );
    await events.emit('interactionCreate', selectInteraction);
    const modalInteraction = createModalSubmitInteraction(
      String(selectInteraction.modals[0]?.custom_id ?? ''),
      { displayName: 'Whatever' }
    );
    await events.emit('interactionCreate', modalInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(modalInteraction.replies[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(createSessionCalls).toEqual([]);
    expect(createButton.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Saved workdir is unavailable right now. Please choose another directory.'
          })
        ],
        components: []
      }
    ]);
  });

  it('shows a short message when session-new scan finds no candidates', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-scan-empty' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-scan-empty'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-scan-empty',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: ({
        async scanWorkdirs() {
          return { items: [], nextOffset: null };
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-scan-empty', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as unknown as Parameters<typeof createDiscordControlBot>[0]['runnerClient']),
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    expect(buttonInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'No new working directories were found.'
          })
        ],
        components: []
      }
    ]);
  });

  it('shows a short message when session-new scan is unavailable', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-scan-unavailable' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-scan-unavailable'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-scan-unavailable',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-scan-unavailable', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    expect(buttonInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Directory search is unavailable right now.'
          })
        ],
        components: []
      }
    ]);
  });

  it('keeps separate session-new wizard instances for repeated launches in the same channel', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-repeat' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-repeat'));
    const firstSlash = createCreateSessionInteraction(channel, {
      channelId: 'channel-repeat',
      values: { cwd: null, model: 'haiku', skills: 'git' }
    });
    const secondSlash = createCreateSessionInteraction(channel, {
      channelId: 'channel-repeat',
      values: { cwd: null, model: 'opus', skills: 'review' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: ({
        async scanWorkdirs() {
          return {
            items: [
              {
                path: '/workspace/repeat-search',
                displayName: 'Repeat Search',
                score: 100
              }
            ],
            nextOffset: null
          };
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-repeat', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as unknown as Parameters<typeof createDiscordControlBot>[0]['runnerClient']),
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', firstSlash);
    await events.emit('interactionCreate', secondSlash);

    const firstIds = collectButtonCustomIds(firstSlash.replies[0]?.components ?? []);
    const secondIds = collectButtonCustomIds(secondSlash.replies[0]?.components ?? []);
    expect(firstIds).toHaveLength(3);
    expect(secondIds).toHaveLength(3);
    expect(firstIds).not.toEqual(secondIds);

    const firstButton = createButtonInteraction(firstIds[0] ?? '');
    const secondButton = createButtonInteraction(secondIds[1] ?? '');

    await events.emit('interactionCreate', firstButton);
    await events.emit('interactionCreate', secondButton);

    expect(firstButton.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Saved workdir history is unavailable right now.'
          })
        ],
        components: []
      }
    ]);
    expect(secondButton.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Choose a newly discovered working directory for the new session.'
          })
        ],
        components: expect.any(Array)
      }
    ]);
  });

  it('rejects stale session-new scan selections after the picker page changes', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-scan-stale' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-scan-stale'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-scan-stale',
      values: { cwd: null, model: 'sonnet' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: ({
        async scanWorkdirs(input: { offset?: number; limit?: number }) {
          if ((input.offset ?? 0) === 0) {
            return {
              items: Array.from({ length: 25 }, (_, index) => ({
                path: `/workspace/stale-${index + 1}`,
                displayName: `Stale ${index + 1}`,
                score: 100 - index,
              })),
              nextOffset: 25
            };
          }

          return {
            items: [
              {
                path: '/workspace/stale-26',
                displayName: 'Stale 26',
                score: 74
              }
            ],
            nextOffset: null
          };
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-scan-stale', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as unknown as Parameters<typeof createDiscordControlBot>[0]['runnerClient']),
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const searchButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[1] ?? '';
    const firstPageButton = createButtonInteraction(searchButtonId);
    await events.emit('interactionCreate', firstPageButton);

    const staleSelect = createStringSelectInteraction(
      collectStringSelectCustomIds(firstPageButton.updates[0]?.components ?? [])[0] ?? '',
      [collectStringSelectOptionValues(firstPageButton.updates[0]?.components ?? [])[0] ?? '']
    );
    const nextPageButton = createButtonInteraction(
      findButtonCustomIdByLabel(firstPageButton.updates[0]?.components ?? [], 'Next') ?? ''
    );
    await events.emit('interactionCreate', nextPageButton);
    await events.emit('interactionCreate', staleSelect);

    expect(staleSelect.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Session setup expired. Please run /session-new again.'
          })
        ],
        components: []
      }
    ]);
  });

  it('returns a stale-safe message after a session-new wizard button has already been used', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-stale' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-stale'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-stale',
      values: { cwd: null, model: 'sonnet' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-stale', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const buttonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const firstButton = createButtonInteraction(buttonId);
    const staleButton = createButtonInteraction(buttonId);

    await events.emit('interactionCreate', firstButton);
    await events.emit('interactionCreate', staleButton);

    expect(firstButton.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Saved workdir history is unavailable right now.'
          })
        ],
        components: []
      }
    ]);
    expect(staleButton.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Session setup expired. Please run /session-new again.'
          })
        ],
        components: []
      }
    ]);
  });

  it('rejects foreign-user history interactions without mutating the initiator picker state', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-foreign-button' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-foreign-button');
    const channel = createFakeChannel(thread);
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-foreign-button',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'workdir-foreign',
              path: '/workspace/initiator-app',
              displayName: 'Initiator App',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-foreign-button', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const historyButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const initiatorButton = createButtonInteraction(historyButtonId, 'discord-user-1');
    await events.emit('interactionCreate', initiatorButton);

    const initialPickerComponents = initiatorButton.updates[0]?.components ?? [];
    const initialPickerLabels = collectStringSelectOptionLabels(initialPickerComponents);
    const initialPickerButtons = collectButtonLabels(initialPickerComponents);
    const foreignButton = createButtonInteraction(historyButtonId, 'discord-user-2');

    await events.emit('interactionCreate', foreignButton);

    expect(foreignButton.replies).toEqual([
      {
        ephemeral: true,
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Only the user who started this session setup can use it.'
          })
        ],
        components: []
      }
    ]);
    expect(foreignButton.updates).toEqual([]);
    expect(collectStringSelectOptionLabels(initiatorButton.updates[0]?.components ?? [])).toEqual(initialPickerLabels);
    expect(collectButtonLabels(initiatorButton.updates[0]?.components ?? [])).toEqual(initialPickerButtons);

    const selectId = collectStringSelectCustomIds(initiatorButton.updates[0]?.components ?? [])[0] ?? '';
    const foreignSelect = createStringSelectInteraction(selectId, ['workdir-foreign'], 'discord-user-2');
    const initiatorSelect = createStringSelectInteraction(selectId, ['workdir-foreign'], 'discord-user-1');

    await events.emit('interactionCreate', foreignSelect);
    await events.emit('interactionCreate', initiatorSelect);

    expect(foreignSelect.replies).toEqual([
      {
        ephemeral: true,
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Only the user who started this session setup can use it.'
          })
        ],
        components: []
      }
    ]);
    expect(foreignSelect.updates).toEqual([]);
    expect(createSessionCalls).toEqual([]);
    expect(thread.sentMessages).toEqual([]);
  });

  it('creates a session from a selected history item', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const saveWorkdirCalls: Array<{ path: string; displayName?: string; createdBy: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-workdir-select' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-workdir-select');
    const channel = createFakeChannel(thread);
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-workdir-select',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'workdir-history-app',
              path: '/workspace/history-app',
              displayName: 'History App',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          saveWorkdirCalls.push(input);
          return {
            id: 'workdir-history-app',
            path: input.path,
            displayName: input.displayName ?? null,
            source: 'scan' as const,
            createdBy: input.createdBy,
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z',
            lastUsedAt: '2026-03-25T00:00:00.000Z',
            useCount: 2
          };
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-workdir-select', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0)
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const historyButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const historyButton = createButtonInteraction(historyButtonId);
    await events.emit('interactionCreate', historyButton);

    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(historyButton.updates[0]?.components ?? [])[0] ?? '',
      ['workdir-history-app']
    );
    await events.emit('interactionCreate', selectInteraction);

    expect(saveWorkdirCalls).toEqual([]);
    expect(createSessionCalls).toEqual([]);
    expect(selectInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Review session options before creating the new session.\nworkdir: /workspace/history-app\nmodel: haiku\neffort: default\nskills: none'
          })
        ],
        components: expect.any(Array)
      }
    ]);
    expect(collectButtonLabels(selectInteraction.updates[0]?.components ?? [])).toEqual(['Model', 'Effort', 'Skills', 'Create session']);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(selectInteraction.updates[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(saveWorkdirCalls).toEqual([
      { path: '/workspace/history-app', displayName: 'History App', createdBy: 'discord-user-1' }
    ]);
    expect(createSessionCalls).toEqual([
      { channelId: 'thread-workdir-select', userId: 'discord-user-1', cwd: '/workspace/history-app' }
    ]);
    expect(channel.createdThreadNames).toEqual(['pretty-fire']);
    expect(thread.sentMessages).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Session session-workdir-select\nname: pretty-fire\ncwd: /workspace/history-app\nmodel: haiku\neffort: default\nskills: none'
          })
        ]
      })
    ]);
  });

  it('does not create a session when refreshing saved history recency fails', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-history-best-effort' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-history-best-effort');
    const channel = createFakeChannel(thread);
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-best-effort',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'workdir-best-effort',
              path: '/workspace/best-effort-app',
              displayName: 'Best Effort App',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async saveWorkdir() {
          throw new Error('database temporarily unavailable');
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-best-effort', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const historyButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const historyButton = createButtonInteraction(historyButtonId);
    await events.emit('interactionCreate', historyButton);

    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(historyButton.updates[0]?.components ?? [])[0] ?? '',
      ['workdir-best-effort']
    );
    await events.emit('interactionCreate', selectInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(selectInteraction.updates[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(createSessionCalls).toEqual([]);
    expect(channel.createdThreadNames).toEqual([]);
    expect(thread.sentMessages).toEqual([]);
    expect(extractEmbedDescriptions(createButton.updates[0]?.embeds ?? [])).toEqual([
      'Saved workdir is unavailable right now. Please choose another directory.'
    ]);
    expect(collectButtonLabels(createButton.updates[0]?.components ?? [])).toEqual([]);
  });

  it('does not create a session when history refresh is unavailable', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-history-missing-refresh' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-history-missing');
    const channel = createFakeChannel(thread);
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-missing',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: ({
        async listWorkdirs() {
          return [
            {
              id: 'workdir-missing-refresh',
              path: '/workspace/missing-refresh-app',
              displayName: 'Missing Refresh App',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-missing-refresh', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      } as unknown as Parameters<typeof createDiscordControlBot>[0]['runnerClient']),
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const historyButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const historyButton = createButtonInteraction(historyButtonId);
    await events.emit('interactionCreate', historyButton);

    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(historyButton.updates[0]?.components ?? [])[0] ?? '',
      ['workdir-missing-refresh']
    );
    await events.emit('interactionCreate', selectInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(selectInteraction.updates[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(createSessionCalls).toEqual([]);
    expect(channel.createdThreadNames).toEqual([]);
    expect(thread.sentMessages).toEqual([]);
    expect(extractEmbedDescriptions(createButton.updates[0]?.embeds ?? [])).toEqual([
      'Saved workdir is unavailable right now. Please choose another directory.'
    ]);
    expect(collectButtonLabels(createButton.updates[0]?.components ?? [])).toEqual([]);
  });

  it('does not create a session when history refresh fails with a path-validity error', async () => {
    const events = createEventBus();
    const createSessionCalls: Array<{ channelId: string; userId: string; cwd: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession(input) {
          createSessionCalls.push({
            channelId: input.channelId,
            userId: input.context.createdBy,
            cwd: input.context.cwd
          });
          return { sessionId: 'session-history-invalid-path' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const thread = createFakeThread('thread-history-invalid-path');
    const channel = createFakeChannel(thread);
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-invalid-path',
      values: { cwd: null, model: 'haiku' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'workdir-invalid-path',
              path: '/workspace/moved-app',
              displayName: 'Moved App',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async saveWorkdir() {
          throw new Error('workdir path does not exist: /workspace/moved-app');
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-invalid-path', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const historyButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const historyButton = createButtonInteraction(historyButtonId);
    await events.emit('interactionCreate', historyButton);

    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(historyButton.updates[0]?.components ?? [])[0] ?? '',
      ['workdir-invalid-path']
    );
    await events.emit('interactionCreate', selectInteraction);

    const createButton = createButtonInteraction(
      findButtonCustomIdByLabel(selectInteraction.updates[0]?.components ?? [], 'Create session') ?? ''
    );
    await events.emit('interactionCreate', createButton);

    expect(createSessionCalls).toEqual([]);
    expect(channel.createdThreadNames).toEqual([]);
    expect(thread.sentMessages).toEqual([]);
    expect(extractEmbedDescriptions(createButton.updates[0]?.embeds ?? [])).toEqual([
      'Saved workdir is unavailable right now. Please choose another directory.'
    ]);
    expect(collectButtonLabels(createButton.updates[0]?.components ?? [])).toEqual([]);
  });

  it('truncates long history option labels and descriptions to Discord-safe lengths', async () => {
    const events = createEventBus();
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-history-truncation' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const channel = createFakeChannel(createFakeThread('thread-history-truncation'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-history-truncation',
      values: { cwd: null, model: 'haiku' }
    });
    const veryLongDisplayName = 'History '.repeat(20);
    const veryLongPath = `/workspace/${'nested/'.repeat(18)}project-name`;
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'workdir-long',
              path: veryLongPath,
              displayName: veryLongDisplayName,
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-history-truncation', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);
    const buttonInteraction = createButtonInteraction(collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '');
    await events.emit('interactionCreate', buttonInteraction);

    const optionLabels = collectStringSelectOptionLabels(buttonInteraction.updates[0]?.components ?? []);
    const optionDescriptions = collectStringSelectOptionDescriptions(buttonInteraction.updates[0]?.components ?? []);
    expect(optionLabels).toHaveLength(1);
    expect(optionDescriptions).toHaveLength(1);
    expect(optionLabels[0]?.length).toBeLessThanOrEqual(100);
    expect(optionDescriptions[0]?.length).toBeLessThanOrEqual(100);
    expect(optionLabels[0]).toMatch(/\.\.\.$/);
    expect(optionDescriptions[0]).toMatch(/\.\.\.$/);
  });

  it('expires history selection after the wizard state ages out', async () => {
    const events = createEventBus();
    let currentTime = '2026-03-25T00:00:00.000Z';
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-workdir-expired' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => currentTime
    });
    const channel = createFakeChannel(createFakeThread('thread-workdir-expired'));
    const slashInteraction = createCreateSessionInteraction(channel, {
      channelId: 'channel-workdir-expired',
      values: { cwd: null, model: 'sonnet' }
    });
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async listWorkdirs() {
          return [
            {
              id: 'workdir-expired',
              path: '/workspace/expired-app',
              displayName: 'Expired App',
              source: 'scan' as const,
              createdBy: 'discord-user-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z',
              lastUsedAt: '2026-03-25T00:00:00.000Z',
              useCount: 1
            }
          ];
        },
        async saveWorkdir(input: { path: string; displayName?: string; createdBy: string }) {
          return createSavedWorkdirResult(input);
        },
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-workdir-expired', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getChannel: async () => channel
      },
      now: () => currentTime
    });

    await bot.start();
    await events.emit('interactionCreate', slashInteraction);

    const historyButtonId = collectButtonCustomIds(slashInteraction.replies[0]?.components ?? [])[0] ?? '';
    const historyButton = createButtonInteraction(historyButtonId);
    await events.emit('interactionCreate', historyButton);

    currentTime = '2026-03-25T00:11:00.000Z';
    const selectInteraction = createStringSelectInteraction(
      collectStringSelectCustomIds(historyButton.updates[0]?.components ?? [])[0] ?? '',
      ['workdir-expired']
    );
    await events.emit('interactionCreate', selectInteraction);

    expect(selectInteraction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Session setup expired. Please run /session-new again.'
          })
        ],
        components: []
      }
    ]);
  });

  it('answers pending questions from thread messages', async () => {
    const events = createEventBus();
    const answerCalls: Array<{ promptId: string; answer: string; userId: string }> = [];
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-1' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion(input) {
          answerCalls.push({ promptId: input.promptId, answer: input.answer, userId: 'discord-user-2' });
        }
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    });
    const sentMessages: string[] = [];
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers,
      runnerClient: {
        async getPendingPrompt() {
          return {
            kind: 'question',
            promptId: 'prompt-question-1',
            runtimePromptId: 'runtime-question-1',
            text: 'Continue?'
          };
        },
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'awaiting_user_answer', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          if (threadId === 'thread-9') {
            return {
              threadId: 'thread-9',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            };
          }

          return null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-2' },
      content: 'yes',
      channelId: 'thread-9',
      channel: {
        isThread: () => true,
        send: async (content: string) => {
          sentMessages.push(content);
        }
      },
      reply: async (content: string) => {
        sentMessages.push(content);
      },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(answerCalls).toEqual([
      {
        promptId: 'prompt-question-1',
        answer: 'yes',
        userId: 'discord-user-2'
      }
    ]);
    expect(sentMessages).toContain('Answered question for session session-1.');
  });

  it('surfaces approval buttons after a turn creates a pending permission prompt', async () => {
    const events = createEventBus();
    let pendingPromptAvailable = false;
    const sentMessages: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }> = [];
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return pendingPromptAvailable
            ? {
                kind: 'permission',
                promptId: 'prompt-permission-1',
                runtimePromptId: 'runtime-permission-1',
                text: 'Allow write?'
              }
            : null;
        },
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {
          pendingPromptAvailable = true;
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'awaiting_permission', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return {
            threadId: 'thread-10',
            sessionId: 'session-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-5' },
      content: 'run tests',
      channelId: 'thread-10',
      channel: {
        isThread: () => true,
        send: async (content: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }) => {
          sentMessages.push(content);
        }
      },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Approval needed for session session-1: Allow write?'
          })
        ]
      })
    );
  });

  it('reconnects the runner event stream after a transient failure and still surfaces permission prompts', async () => {
    const events = createEventBus();
    const sentMessages: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }> = [];
    let subscribeCalls = 0;

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-reconnect' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-reconnect', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return {
            kind: 'permission',
            promptId: 'prompt-reconnect',
            runtimePromptId: 'perm-reconnect',
            text: 'Approve after reconnect?'
          };
        },
        async listEvents(input) {
          expect(input.fromSeq).toBe(1);
          return [];
        },
        subscribeEvents(input) {
          subscribeCalls += 1;
          expect(input.fromSeq).toBe(1);

          if (subscribeCalls === 1) {
            return {
              async *[Symbol.asyncIterator]() {
                throw new TypeError('fetch failed');
              }
            };
          }

          return createAsyncIterable<RunnerEventEnvelope>([
            {
              seq: 1,
              event: { type: 'permission.requested', requestId: 'perm-reconnect', prompt: 'Approve after reconnect?' }
            }
          ]);
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return {
            sessionId: 'session-reconnect',
            state: 'running',
            recoveryStatus: 'ok',
            pendingPrompt: null
          };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-reconnect',
              sessionId: 'session-reconnect',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-reconnect',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => ({
          isThread: () => true,
          send: async (content: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }) => {
            sentMessages.push(content);
          }
        })
      }
    });

    await bot.start();

    await vi.waitFor(() => {
      expect(subscribeCalls).toBe(2);
      expect(sentMessages).toContainEqual(
        expect.objectContaining({
          embeds: [
            expect.objectContaining({
              color: 0x6b7280,
              description: 'Approval needed for session session-reconnect: Approve after reconnect?'
            })
          ],
          components: expect.any(Array)
        })
      );
    });
  });

  it('replays startup state and renders runner output for live thread messages', async () => {
    const events = createEventBus();
    const sentMessages: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[] }> = [];
    let pendingPromptAvailable = false;
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return pendingPromptAvailable
            ? {
                kind: 'permission',
                promptId: 'prompt-1',
                runtimePromptId: 'perm-1',
                text: 'Allow write?'
              }
            : null;
        },
        async listEvents() {
          pendingPromptAvailable = true;
          return [
            {
              seq: 1,
              event: { type: 'text.delta', messageId: 'msg-1', delta: 'Streaming line 1\n' }
            },
            {
              seq: 2,
              event: { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' }
            }
          ];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return {
            sessionId: 'session-1',
            state: 'awaiting_permission',
            recoveryStatus: 'ok',
            pendingPrompt: null
          };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          if (threadId !== 'thread-22') {
            return null;
          }

          return {
            threadId: 'thread-22',
            sessionId: 'session-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        },
        listAll() {
          return [
            {
              threadId: 'thread-22',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-5' },
      content: 'run tests',
      channelId: 'thread-22',
      channel: {
        isThread: () => true,
        send: async (content: string | { content?: string; embeds?: unknown[]; components?: unknown[] }) => {
          sentMessages.push(content);
        }
      },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        flags: 32768,
        components: [
          expect.objectContaining({
            type: 17,
            accent_color: 0xe0613a,
            components: [expect.objectContaining({ type: 10, content: 'Streaming line 1' })]
          })
        ]
      })
    );
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Approval needed for session session-1: Allow write?'
          })
        ]
      })
    );
  });

  it('starts a background runner subscription and persists delivery checkpoints across restarts', async () => {
    const initialEvents = createEventBus();
    const firstChannelMessages: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }> = [];
    const firstDeliverySaves: Array<{ sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }> = [];
    let firstDeliveryState: {
      sessionId: string;
      cursor: string;
      rootMessageId: string | null;
      updatedAt: string;
    } = {
      sessionId: 'session-1',
      cursor: '1',
      rootMessageId: null,
      updatedAt: '2026-03-25T00:00:00.000Z'
    };
    let pendingPromptAvailable = false;
    const streamEvents = {
      async *[Symbol.asyncIterator]() {
        yield { seq: 3, event: { type: 'text.delta', messageId: 'msg-1', delta: 'live output\n' } } as RunnerEventEnvelope;
        pendingPromptAvailable = true;
        yield {
          seq: 4,
          event: { type: 'permission.requested', requestId: 'perm-live', prompt: 'Approve live step?' }
        } as RunnerEventEnvelope;
      },
      async drain() {}
    };

    const firstBot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return pendingPromptAvailable
            ? {
                kind: 'permission',
                promptId: 'prompt-live',
                runtimePromptId: 'perm-live',
                text: 'Approve live step?'
              }
            : null;
        },
        async listEvents(input) {
          expect(input.fromSeq).toBe(2);
          return [
            { seq: 2, event: { type: 'text.delta', messageId: 'msg-1', delta: 'backlog output\n' } }
          ];
        },
        subscribeEvents(input) {
          expect(input.fromSeq).toBe(3);
          return streamEvents;
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-live',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId() {
          return firstDeliveryState;
        },
        save(record) {
          firstDeliverySaves.push(record);
          firstDeliveryState = record;
        }
      },
      now: () => '2026-03-25T00:00:00.000Z',
      discord: {
        login: initialEvents.login,
        destroy: initialEvents.destroy,
        on: initialEvents.on,
        registerCommands: async () => {},
        getThreadChannel: async () => ({
          isThread: () => true,
          send: async (content: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }) => {
            firstChannelMessages.push(content);
          }
        })
      }
    });

    await firstBot.start();
    await streamEvents.drain();

    await vi.waitFor(() => {
      expect(firstChannelMessages).toContainEqual(
        expect.objectContaining({
          flags: 32768,
          components: [
            expect.objectContaining({
              type: 17,
              accent_color: 0xe0613a,
              components: [expect.objectContaining({ type: 10, content: 'backlog output' })]
            })
          ]
        })
      );
      expect(firstChannelMessages).toContainEqual(
        expect.objectContaining({
          flags: 32768,
          components: [
            expect.objectContaining({
              type: 17,
              accent_color: 0xe0613a,
              components: [expect.objectContaining({ type: 10, content: 'backlog output\nlive output' })]
            })
          ]
        })
      );
      expect(firstChannelMessages).toContainEqual(
        expect.objectContaining({
          embeds: [
            expect.objectContaining({
              color: 0x6b7280,
              description: 'Approval needed for session session-1: Approve live step?'
            })
          ]
        })
      );
    });
    expect(firstDeliverySaves).toEqual([
      {
        sessionId: 'session-1',
        cursor: '2',
        rootMessageId: null,
        deliveredToolCallIds: [],
        updatedAt: '2026-03-25T00:00:00.000Z'
      },
      {
        sessionId: 'session-1',
        cursor: '3',
        rootMessageId: null,
        deliveredToolCallIds: [],
        updatedAt: '2026-03-25T00:00:00.000Z'
      },
      {
        sessionId: 'session-1',
        cursor: '4',
        rootMessageId: null,
        deliveredToolCallIds: [],
        updatedAt: '2026-03-25T00:00:00.000Z'
      }
    ]);

    const restartEvents = createEventBus();
    const restartCalls: number[] = [];
    const restartedMessages: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }> = [];
    const secondBot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return {
            kind: 'permission' as const,
            promptId: 'prompt-live',
            runtimePromptId: 'perm-live',
            text: 'Approve live step?'
          };
        },
        async listEvents(input) {
          restartCalls.push(input.fromSeq);
          return [];
        },
        subscribeEvents(input) {
          restartCalls.push(input.fromSeq);
          return createAsyncIterable<RunnerEventEnvelope>([]);
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-live',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId() {
          return {
            sessionId: 'session-1',
            cursor: '4',
            rootMessageId: null,
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        },
        save() {}
      },
      now: () => '2026-03-25T00:00:00.000Z',
      discord: {
        login: restartEvents.login,
        destroy: restartEvents.destroy,
        on: restartEvents.on,
        registerCommands: async () => {},
        getThreadChannel: async () => ({
          isThread: () => true,
          send: async (content: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }) => {
            restartedMessages.push(content);
          }
        })
      }
    });

    await secondBot.start();

    expect(restartCalls).toEqual([5, 5]);
    expect(restartedMessages).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Approval needed for session session-1: Approve live step?'
          })
        ],
        components: expect.any(Array)
      })
    ]);
  });

  it('renders approval buttons even when the runtime prompt id is very long', async () => {
    const events = createEventBus();
    const sentMessages: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[] }> = [];
    const longPromptId = 'prompt-'.repeat(30);
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-long-prompt' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-long-prompt', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return {
            kind: 'permission' as const,
            promptId: 'prompt-1',
            runtimePromptId: longPromptId,
            text: 'Allow long prompt id?'
          };
        },
        async listEvents() {
          return [
            {
              seq: 1,
              event: { type: 'permission.requested', requestId: 'prompt-1', runtimePromptId: longPromptId, prompt: 'Allow long prompt id?' }
            }
          ];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-long-prompt', state: 'awaiting_permission', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          if (threadId !== 'thread-long-prompt') {
            return null;
          }

          return {
            threadId: 'thread-long-prompt',
            sessionId: 'session-long-prompt',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-5' },
      content: 'run tests',
      channelId: 'thread-long-prompt',
      channel: {
        isThread: () => true,
        send: async (content: string | { content?: string; embeds?: unknown[]; components?: unknown[] }) => {
          sentMessages.push(content);
        }
      },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    const promptMessage = sentMessages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        extractEmbedDescriptions((message as { embeds?: unknown[] }).embeds ?? []).some((description) =>
          description.includes('Approval needed for session session-long-prompt: Allow long prompt id?')
        )
    ) as { components?: unknown[] } | undefined;
    expect(promptMessage).toBeDefined();
    expect(collectButtonCustomIds(promptMessage?.components ?? [])).toEqual([
      'prompt:allow_once:session-long-prompt',
      'prompt:deny_once:session-long-prompt'
    ]);
    expect(collectButtonCustomIds(promptMessage?.components ?? []).every((customId) => customId.length <= 100)).toBe(true);
  });

  it('does not re-send the same tool cards after restart recovery', async () => {
    const events = createEventBus();
    const sentMessages: Array<string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }> = [];
    const deliveredToolCallIds = ['tool-bash-1', 'tool-read-1'];

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (input.fromSeq === 1) {
            return [
              {
                seq: 1,
                event: {
                  type: 'tool.completed',
                  toolUseId: 'tool-bash-1',
                  toolName: 'Bash',
                  command: 'npm test',
                  description: 'Runs tests',
                  output: 'ok',
                  stdout: 'ok',
                  stderr: '',
                  isError: false
                }
              },
              {
                seq: 2,
                event: {
                  type: 'tool.completed',
                  toolUseId: 'tool-read-1',
                  toolName: 'Read',
                  description: 'Reads file',
                  output: '',
                  stdout: '',
                  stderr: '',
                  isError: false
                }
              }
            ];
          }

          return [];
        },
        subscribeEvents(input) {
          expect(input.fromSeq).toBe(3);
          return createAsyncIterable<RunnerEventEnvelope>([]);
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-live',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId() {
          return {
            sessionId: 'session-1',
            cursor: '2',
            rootMessageId: null,
            deliveredToolCallIds,
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        },
        save() {}
      },
      now: () => '2026-03-25T00:00:00.000Z',
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => ({
          isThread: () => true,
          send: async (content: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => {
            sentMessages.push(content);
          }
        })
      }
    });

    await bot.start();

    expect(sentMessages).toEqual([]);
  });

  it('stores delivered tool-card ids alongside the active anchor', async () => {
    const events = createEventBus();
    const savedRecords: Array<{
      sessionId: string;
      cursor: string;
      rootMessageId: string | null;
      deliveredToolCallIds: string[];
      updatedAt: string;
    }> = [];
    let currentDeliveryState: {
      sessionId: string;
      cursor: string;
      rootMessageId: string | null;
      deliveredToolCallIds: string[];
      updatedAt: string;
    } | null = {
      sessionId: 'session-1',
      cursor: '0',
      rootMessageId: 'message-1',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    };
    const streamEvents = createAsyncIterable<RunnerEventEnvelope>([
      {
        seq: 1,
        event: {
          type: 'tool.completed',
          toolUseId: 'tool-bash-1',
          toolName: 'Bash',
          command: 'npm test',
          description: 'Runs tests',
          output: 'ok',
          stdout: 'ok',
          stderr: '',
          isError: false
        }
      },
      {
        seq: 2,
        event: {
          type: 'tool.completed',
          toolUseId: 'tool-read-1',
          toolName: 'Read',
          description: 'Reads file',
          output: '',
          stdout: '',
          stderr: '',
          isError: false
        }
      }
    ]);

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        subscribeEvents(input) {
          expect(input.fromSeq).toBe(1);
          return streamEvents;
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-tools',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId() {
          return currentDeliveryState;
        },
        save(record) {
          currentDeliveryState = record as typeof savedRecords[number];
          savedRecords.push(currentDeliveryState);
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => createEditableThreadChannel({ existingMessageIds: ['message-1'] })
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await bot.start();
    await streamEvents.drain();

    expect(savedRecords).toContainEqual({
      sessionId: 'session-1',
      cursor: '2',
      rootMessageId: 'message-1',
      deliveredToolCallIds: ['tool-bash-1', 'tool-read-1'],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
  });

  it('persists the current assistant anchor and continues editing it during active-turn restart recovery', async () => {
    const firstEvents = createEventBus();
    const savedDeliveryState = new Map<string, { sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }>();
    const firstChannel = createEditableThreadChannel();
    let completedTurns = 0;

    const firstBot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (completedTurns === 1 && input.fromSeq === 1) {
            return [
              {
                seq: 1,
                event: { type: 'text.delta', messageId: 'msg-1', delta: 'first output' }
              },
              {
                seq: 2,
                event: { type: 'turn.completed', exitCode: 0 }
              }
            ];
          }

          if (completedTurns === 2 && input.fromSeq === 3) {
            return [
              {
                seq: 3,
                event: { type: 'text.delta', messageId: 'msg-2', delta: 'second output' }
              }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {
          completedTurns += 1;
        },
        async getSession() {
          return {
            sessionId: 'session-1',
            state: completedTurns === 1 ? 'idle' : 'running',
            recoveryStatus: 'ok',
            pendingPrompt: null
          };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          if (threadId !== 'thread-anchor') {
            return null;
          }

          return {
            threadId: 'thread-anchor',
            sessionId: 'session-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return savedDeliveryState.get(sessionId) ?? null;
        },
        save(record) {
          savedDeliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: firstEvents.login,
        destroy: firstEvents.destroy,
        on: firstEvents.on,
        registerCommands: async () => {},
        getThreadChannel: async () => firstChannel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await firstBot.start();
    await firstEvents.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'first turn',
      channelId: 'thread-anchor',
      channel: firstChannel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });
    await firstEvents.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'second turn',
      channelId: 'thread-anchor',
      channel: firstChannel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(firstChannel.sentContents).toHaveLength(2);
    expect(firstChannel.sentContents.every(isWaitingPlaceholderFrame)).toBe(true);
    expect(firstChannel.editCalls).toEqual([
      { messageId: 'message-1', content: 'first output' },
      { messageId: 'message-2', content: 'second output' }
    ]);
    expect(savedDeliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '3',
      rootMessageId: 'message-2',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    const restartEvents = createEventBus();
    const restartedChannel = createEditableThreadChannel({ existingMessageIds: ['message-2'] });
    const secondBot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (input.fromSeq === 1) {
            return [
              {
                seq: 1,
                event: { type: 'text.delta', messageId: 'msg-1', delta: 'first output' }
              },
              {
                seq: 2,
                event: { type: 'turn.completed', exitCode: 0 }
              },
              {
                seq: 3,
                event: { type: 'text.delta', messageId: 'msg-2', delta: 'second output + restarted output' }
              }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          if (threadId !== 'thread-anchor') {
            return null;
          }

          return {
            threadId: 'thread-anchor',
            sessionId: 'session-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        },
        listAll() {
          return [
            {
              threadId: 'thread-anchor',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: 'runtime-session-1',
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return savedDeliveryState.get(sessionId) ?? null;
        },
        save(record) {
          savedDeliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: restartEvents.login,
        destroy: restartEvents.destroy,
        on: restartEvents.on,
        registerCommands: async () => {},
        getThreadChannel: async () => restartedChannel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await secondBot.start();

    expect(restartedChannel.sentContents).toEqual([]);
    expect(restartedChannel.editCalls).toEqual([
      { messageId: 'message-2', content: 'second output + restarted output' }
    ]);
    expect(savedDeliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '3',
      rootMessageId: 'message-2',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
  });

  it('creates a fresh assistant message for each new user turn', async () => {
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    let completedTurns = 0;
    const deliveryState = new Map<string, { sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }>();

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (completedTurns === 1 && input.fromSeq === 1) {
            return [
              { seq: 1, event: { type: 'text.delta', messageId: 'msg-1', delta: 'first reply' } },
              { seq: 2, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          if (completedTurns === 2 && input.fromSeq === 3) {
            return [
              { seq: 3, event: { type: 'text.delta', messageId: 'msg-2', delta: 'second reply' } },
              { seq: 4, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {
          completedTurns += 1;
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          if (threadId !== 'thread-chat') {
            return null;
          }

          return {
            threadId: 'thread-chat',
            sessionId: 'session-1',
            createdAt: '2026-03-25T00:00:00.000Z',
            updatedAt: '2026-03-25T00:00:00.000Z'
          };
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return deliveryState.get(sessionId) ?? null;
        },
        save(record) {
          deliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'first user turn',
      channelId: 'thread-chat',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'second user turn',
      channelId: 'thread-chat',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(channel.sentContents).toHaveLength(2);
    expect(channel.sentContents.every(isWaitingPlaceholderFrame)).toBe(true);
    expect(channel.editCalls).toEqual([
      { messageId: 'message-1', content: 'first reply' },
      { messageId: 'message-2', content: 'second reply' }
    ]);
    expect(deliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '4',
      rootMessageId: 'message-2',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
  });

  it('rejects a new user turn while the session is still running and keeps the current anchor active', async () => {
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    const sendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
    let sessionState: 'idle' | 'running' = 'idle';
    let activeTurn = 0;
    const deliveryState = new Map<string, { sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }>();

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (activeTurn === 1 && input.fromSeq === 1) {
            return [
              { seq: 1, event: { type: 'text.delta', messageId: 'msg-1', delta: 'first reply' } }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn(input) {
          sendTurnCalls.push(input);
          activeTurn += 1;
          sessionState = 'running';
        },
        async getSession() {
          return { sessionId: 'session-1', state: sessionState, recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-chat'
            ? {
                threadId: 'thread-chat',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return deliveryState.get(sessionId) ?? null;
        },
        save(record) {
          deliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'first user turn',
      channelId: 'thread-chat',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'second user turn',
      channelId: 'thread-chat',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(sendTurnCalls).toEqual([
      { sessionId: 'session-1', prompt: 'first user turn' }
    ]);
    expect(channel.sentContents).toEqual([
      expect.stringMatching(/^(T|W).*$/),
      'Assistant is still responding. Please wait.'
    ]);
    expect(channel.editCalls).toEqual([
      { messageId: 'message-1', content: 'first reply' }
    ]);
    expect(deliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '1',
      rootMessageId: 'message-1',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
  });

  it('rejects a new user turn after restart when the active turn has only a persisted placeholder anchor', async () => {
    const firstEvents = createEventBus();
    const savedDeliveryState = new Map<string, { sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }>();
    const firstChannel = createEditableThreadChannel();
    const firstSendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];

    const firstBot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn(input) {
          firstSendTurnCalls.push(input);
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-placeholder'
            ? {
                threadId: 'thread-placeholder',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-placeholder',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return savedDeliveryState.get(sessionId) ?? null;
        },
        save(record) {
          savedDeliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: firstEvents.login,
        destroy: firstEvents.destroy,
        on: firstEvents.on,
        registerCommands: async () => {},
        getThreadChannel: async () => firstChannel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await firstBot.start();
    await firstEvents.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'first user turn',
      channelId: 'thread-placeholder',
      channel: firstChannel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(firstSendTurnCalls).toEqual([
      { sessionId: 'session-1', prompt: 'first user turn' }
    ]);
    expect(firstChannel.sentContents).toHaveLength(1);
    expect(isWaitingPlaceholderFrame(firstChannel.sentContents[0] ?? '')).toBe(true);
    expect(savedDeliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '0',
      rootMessageId: 'message-1',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    const restartEvents = createEventBus();
    const restartedChannel = createEditableThreadChannel({ existingMessageIds: ['message-1'] });
    const secondSendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
    const secondBot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn(input) {
          secondSendTurnCalls.push(input);
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-placeholder'
            ? {
                threadId: 'thread-placeholder',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-placeholder',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: 'runtime-session-1',
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return savedDeliveryState.get(sessionId) ?? null;
        },
        save(record) {
          savedDeliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: restartEvents.login,
        destroy: restartEvents.destroy,
        on: restartEvents.on,
        registerCommands: async () => {},
        getThreadChannel: async () => restartedChannel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await secondBot.start();
    await restartEvents.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'second user turn',
      channelId: 'thread-placeholder',
      channel: restartedChannel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(secondSendTurnCalls).toEqual([]);
    expect(restartedChannel.sentContents).toEqual(['Assistant is still responding. Please wait.']);
    expect(restartedChannel.editCalls).toEqual([]);
    expect(savedDeliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '0',
      rootMessageId: 'message-1',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
  });

  it('uses a random waiting placeholder word before the first assistant text arrives', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const events = createEventBus();
    const channel = createEditableThreadChannel();

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        subscribeEvents({ abortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) {
                  resolve();
                  return;
                }

                abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              });
            }
          };
        },
        async health() {
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-animated-waiting'
            ? {
                threadId: 'thread-animated-waiting',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      }
    });

    try {
      await bot.start();
      await events.emit('messageCreate', {
        author: { bot: false, id: 'discord-user-1' },
        content: 'hello',
        channelId: 'thread-animated-waiting',
        channel,
        member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
      });

      expect(channel.sentContents[0]).toBe('Typing...');
      expect(channel.editedContents).toEqual(['Typing...']);
    } finally {
      await bot.stop();
      randomSpy.mockRestore();
    }
  });

  it('does not leave the waiting placeholder as the terminal state after streamed text arrives', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    let completedTurns = 0;

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (completedTurns === 1 && input.fromSeq === 1) {
            return [
              { seq: 1, event: { type: 'text.delta', messageId: 'msg-1', delta: 'first reply' } },
              { seq: 2, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn() {
          completedTurns += 1;
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-animated-waiting'
            ? {
                threadId: 'thread-animated-waiting',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      }
    });

    try {
      await bot.start();
      await events.emit('messageCreate', {
        author: { bot: false, id: 'discord-user-1' },
        content: 'hello',
        channelId: 'thread-animated-waiting',
        channel,
        member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
      });

      expect(channel.sentContents[0]).toBe('Typing...');
      expect(channel.editCalls).toEqual([
        { messageId: 'message-1', content: 'first reply' }
      ]);
      expect(channel.editedContents.at(-1)).toBe('first reply');
      expect(channel.editedContents.every((value) => !isWaitingPlaceholderFrame(value))).toBe(true);
    } finally {
      await bot.stop();
      randomSpy.mockRestore();
    }
  });

  it('starts the next Discord turn on the same runner session after the previous turn completes', async () => {
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    const sendTurnCalls: Array<{ sessionId: string; prompt: string }> = [];
    let activeTurn = 0;
    let sessionState: 'idle' | 'running' = 'idle';
    const deliveryState = new Map<string, { sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }>();

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (activeTurn === 1 && input.fromSeq === 1) {
            sessionState = 'idle';
            return [
              { seq: 1, event: { type: 'text.delta', messageId: 'msg-1', delta: 'first reply' } },
              { seq: 2, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          if (activeTurn === 2 && input.fromSeq === 3) {
            return [
              { seq: 3, event: { type: 'text.delta', messageId: 'msg-2', delta: 'second reply' } },
              { seq: 4, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async sendTurn(input) {
          sendTurnCalls.push(input);
          activeTurn += 1;
          sessionState = 'running';
        },
        async getSession() {
          return { sessionId: 'session-1', state: sessionState, recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-chat'
            ? {
                threadId: 'thread-chat',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return deliveryState.get(sessionId) ?? null;
        },
        save(record) {
          deliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'first user turn',
      channelId: 'thread-chat',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'second user turn',
      channelId: 'thread-chat',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(sendTurnCalls).toEqual([
      { sessionId: 'session-1', prompt: 'first user turn' },
      { sessionId: 'session-1', prompt: 'second user turn' }
    ]);
    expect(channel.sentContents).toHaveLength(2);
    expect(channel.sentContents.every(isWaitingPlaceholderFrame)).toBe(true);
    expect(channel.editCalls).toEqual([
      { messageId: 'message-1', content: 'first reply' },
      { messageId: 'message-2', content: 'second reply' }
    ]);
    expect(deliveryState.get('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '4',
      rootMessageId: 'message-2',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
  });

  it('uses the latest turn anchor when background subscription events arrive after a new turn starts', async () => {
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    const control: { releaseLiveEvent: null | (() => void) } = { releaseLiveEvent: null };
    const liveEventReady = new Promise<void>((resolve) => {
      control.releaseLiveEvent = resolve;
    });
    const deliveryState = new Map<string, { sessionId: string; cursor: string; rootMessageId: string | null; updatedAt: string }>();

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (input.fromSeq === 1) {
            return [
              { seq: 1, event: { type: 'text.delta', messageId: 'msg-1', delta: 'old reply' } },
              { seq: 2, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          return [];
        },
        subscribeEvents() {
          return {
            async *[Symbol.asyncIterator]() {
              await liveEventReady;
              yield { seq: 3, event: { type: 'text.delta', messageId: 'msg-2', delta: 'new reply' } };
              yield { seq: 4, event: { type: 'turn.completed', exitCode: 0 } };
            }
          };
        },
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-race'
            ? {
                threadId: 'thread-race',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        },
        listAll() { return []; }
      },
      deliveryState: {
        getBySessionId(sessionId) {
          return deliveryState.get(sessionId) ?? null;
        },
        save(record) {
          deliveryState.set(record.sessionId, record);
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await bot.start();

    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'next turn',
      channelId: 'thread-race',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    if (control.releaseLiveEvent) {
      control.releaseLiveEvent();
    }
    await vi.waitFor(() => {
      expect(channel.editCalls).toContainEqual({ messageId: 'message-1', content: 'new reply' });
    });
  });

  it('uses the gateway thread wrapper for live message delivery instead of the raw discord channel object', async () => {
    const events = createEventBus();
    const wrappedChannel = createEditableThreadChannel();
    const rawDiscordThread = {
      isThread: () => true,
      async send(content: string | { content: string }) {
        return { id: `raw-${typeof content === 'string' ? content : content.content}` };
      },
      async edit() {
        throw new Error('raw discord thread edit should not be used');
      }
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() {
          return [
            { seq: 1, event: { type: 'text.delta', messageId: 'msg-1', delta: 'wrapped reply' } },
            { seq: 2, event: { type: 'turn.completed', exitCode: 0 } }
          ];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-live-raw'
            ? {
                threadId: 'thread-live-raw',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      deliveryState: {
        getBySessionId() { return null; },
        save() {}
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async (threadId) => threadId === 'thread-live-raw' ? wrappedChannel : null
      },
      now: () => '2026-03-25T00:00:00.000Z'
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'run wrapped test',
      channelId: 'thread-live-raw',
      channel: rawDiscordThread,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(wrappedChannel.sentContents).toHaveLength(1);
    expect(isWaitingPlaceholderFrame(wrappedChannel.sentContents[0] ?? '')).toBe(true);
    expect(wrappedChannel.editCalls.length).toBeGreaterThan(0);
  });

  it('waits until login and command registration finish before startup recovery touches Discord threads', async () => {
    const callOrder: string[] = [];
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          callOrder.push('listEvents');
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          callOrder.push('health');
          return { ok: true };
        },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId() {
          return null;
        },
        listAll() {
          return [
            {
              threadId: 'thread-recover',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: null,
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      discord: {
        async login() {
          callOrder.push('login');
        },
        async destroy() {},
        on() {},
        async registerCommands() {
          callOrder.push('registerCommands');
        },
        async getThreadChannel() {
          callOrder.push('getThreadChannel');
          return {
            isThread: () => true,
            async send() {
              return { id: 'message-1' };
            }
          };
        }
      }
    });

    await bot.start();

    expect(callOrder).toEqual([
      'login',
      'registerCommands',
      'health',
      'getThreadChannel',
      'listEvents'
    ]);
  });

  it('does not block startup on an endless runner subscription', async () => {
    const events = createEventBus();
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        subscribeEvents() {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise(() => undefined);
            }
          };
        },
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: {
        getByThreadId() { return null; },
        listAll() {
          return [
            {
              threadId: 'thread-live',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: 'runtime-session-1',
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => createEditableThreadChannel({ existingMessageIds: ['message-1'] })
      }
    });

    const startResult = await Promise.race([
      bot.start().then(() => 'resolved' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25))
    ]);

    expect(startResult).toBe('resolved');
  });

  it('prunes delivery-state records for sessions that no longer have a thread binding', async () => {
    const events = createEventBus();
    const deletedSessionIds: string[] = [];
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-kept', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: {
        getByThreadId() { return null; },
        listAll() {
          return [
            {
              threadId: 'thread-kept',
              sessionId: 'session-kept',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [];
        }
      },
      deliveryState: {
        getBySessionId() { return null; },
        save() {},
        deleteBySessionId(sessionId: string) {
          deletedSessionIds.push(sessionId);
        },
        listSessionIds() {
          return ['session-kept', 'session-orphan'];
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();

    expect(deletedSessionIds).toEqual(['session-orphan']);
  });

  it('acknowledges stale approval buttons instead of timing out', async () => {
    const events = createEventBus();
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'prompt:allow_once:prompt-stale:session-1',
      user: { id: 'discord-user-1' },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
      messageDeleted: false,
      message: {
        delete: async () => {
          interaction.messageDeleted = true;
        }
      },
      updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
      async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
        this.updates.push(input);
      },
      async deferUpdate() {}
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'stale' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(interaction.messageDeleted).toBe(true);
    expect(interaction.updates).toEqual([]);
  });

  it('acknowledges approved prompts with concise text', async () => {
    const events = createEventBus();
    const resolvedPromptIds: string[] = [];
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'prompt:allow_once:session-1',
      user: { id: 'discord-user-1' },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
      messageDeleted: false,
      message: {
        delete: async () => {
          interaction.messageDeleted = true;
        }
      },
      updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
      async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
        this.updates.push(input);
      },
      async deferUpdate() {}
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt(input) {
            resolvedPromptIds.push(input.promptId);
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return {
            kind: 'permission',
            promptId: 'prompt-ok',
            runtimePromptId: 'toolu_runtime_only',
            text: 'Allow write?'
          };
        },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(interaction.messageDeleted).toBe(true);
    expect(interaction.updates).toEqual([]);
    expect(resolvedPromptIds).toEqual(['prompt-ok']);
  });

  it('skips missing recovery threads instead of crashing startup', async () => {
    const events = createEventBus();
    const errors: string[] = [];
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() { return null; },
        async listEvents() { return []; },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() { return { sessionId: 'session-1', state: 'running', recoveryStatus: 'ok', pendingPrompt: null }; }
      },
      bindings: {
        getByThreadId() { return null; },
        listAll() {
          return [
            {
              threadId: 'thread-missing',
              sessionId: 'session-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      sessions: {
        listActive() {
          return [
            {
              id: 'session-1',
              state: 'running',
              runtimeSessionId: 'runtime-session-1',
              context: {
                cwd: '/workspace/app',
                allowedRoot: '/workspace',
                model: 'sonnet',
                runtimeOptions: { permissionMode: 'default' },
                createdBy: 'discord-user-1'
              },
              createdAt: '2026-03-25T00:00:00.000Z',
              updatedAt: '2026-03-25T00:00:00.000Z'
            }
          ];
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => {
          throw new Error('Unknown Channel');
        }
      },
      logger: {
        info() {},
        error(message) {
          errors.push(message);
        }
      }
    });

    await expect(bot.start()).resolves.toBeUndefined();
    expect(errors.some((message) => message.includes('Unknown Channel'))).toBe(true);
  });

  it('posts collapsed Bash detail cards and lets the user expand and collapse Bash output on demand', async () => {
    const events = createEventBus();
    const channelMessages: Array<string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }> = [];
    let turnStarted = false;
    const buttonReply = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'bash:view:session-1:tool-bash-1',
      user: { id: 'discord-user-1' },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
      updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
      async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
        this.updates.push(input);
      }
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (!turnStarted) {
            return [];
          }

          if (input.fromSeq === 1) {
            return [
              {
                seq: 1,
                event: {
                  type: 'tool.started',
                  toolUseId: 'tool-bash-1',
                  toolName: 'Bash',
                  command: 'pwd',
                  description: 'Print working directory'
                }
              },
              {
                seq: 2,
                event: {
                  type: 'tool.completed',
                  toolUseId: 'tool-bash-1',
                  toolName: 'Bash',
                  command: 'pwd',
                  description: 'Print working directory',
                  output: '/workspace/app',
                  stdout: '/workspace/app',
                  stderr: '',
                  isError: false
                }
              },
              { seq: 3, event: { type: 'text.delta', messageId: 'msg-1', delta: 'Done' } },
              { seq: 4, event: { type: 'turn.completed', exitCode: 0 } }
            ];
          }

          return [];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {
          turnStarted = true;
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-bash'
            ? {
                threadId: 'thread-bash',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'run pwd',
      channelId: 'thread-bash',
      channel: {
        isThread: () => true,
        send: async (content: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => {
          channelMessages.push(content);
          return { id: `message-${channelMessages.length}` };
        }
      },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(channelMessages).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Bash - Print working directory'
          })
        ]
      })
    );

    await events.emit('interactionCreate', buttonReply);

    expect(buttonReply.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Bash output for `pwd`\n```text\n/workspace/app\n```'
          })
        ],
        components: [expect.anything()]
      }
    ]);

    buttonReply.customId = 'bash:hide:session-1:tool-bash-1';
    await events.emit('interactionCreate', buttonReply);

    expect(buttonReply.updates).toContainEqual({
      embeds: [
        expect.objectContaining({
          color: 0x6b7280,
          description: 'Bash - Print working directory'
        })
      ],
      components: [expect.anything()]
    });
  });

  it('returns a short stale-safe message when Bash detail output is unavailable', async () => {
    const events = createEventBus();
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'bash:view:session-1:tool-missing',
      user: { id: 'discord-user-1' },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
      updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
      async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
        this.updates.push(input);
      }
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(interaction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Bash output is no longer available.'
          })
        ],
        components: []
      }
    ]);
  });

  it('shows No output when the Bash command completed without visible output', async () => {
    const events = createEventBus();
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'bash:view:session-1:tool-bash-empty',
      user: { id: 'discord-user-1' },
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
      updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
      async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
        this.updates.push(input);
      }
    };
    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents() {
          return [
            {
              seq: 1,
              event: {
                type: 'tool.completed',
                toolUseId: 'tool-bash-empty',
                toolName: 'Bash',
                command: 'true',
                description: 'Exit successfully without printing',
                output: '',
                stdout: '',
                stderr: '',
                isError: false
              }
            }
          ];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {},
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: { getByThreadId() { return null; } },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {}
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(interaction.updates).toEqual([
      {
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Bash output for `true`\n```text\nNo output\n```'
          })
        ],
        components: [expect.anything()]
      }
    ]);
  });

  it('keeps assistant text separate from compact Bash tool cards', async () => {
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    let turnStarted = false;

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (!turnStarted || input.fromSeq !== 1) {
            return [];
          }

          return [
            {
              seq: 1,
              event: {
                type: 'tool.started',
                toolUseId: 'tool-bash-embed-1',
                toolName: 'Bash',
                command: 'pwd',
                description: 'Print working directory'
              }
            },
            {
              seq: 2,
              event: {
                type: 'tool.completed',
                toolUseId: 'tool-bash-embed-1',
                toolName: 'Bash',
                command: 'pwd',
                description: 'Print working directory',
                output: '/workspace/app',
                stdout: '/workspace/app',
                stderr: '',
                isError: false
              }
            },
            {
              seq: 3,
              event: { type: 'text.delta', messageId: 'msg-bash-embed-1', delta: 'Current directory captured.' }
            }
          ];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {
          turnStarted = true;
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-bash-embed'
            ? {
                threadId: 'thread-bash-embed',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'run pwd',
      channelId: 'thread-bash-embed',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(channel.sentInputs[0]).toEqual({
      flags: 32768,
      components: [
        {
          type: 17,
          accent_color: 0xe0613a,
          components: [
            {
              type: 10,
              content: expect.stringMatching(/^(T|W).*$/)
            }
          ]
        }
      ]
    });
    expect(channel.editInputs).toEqual([
      {
        messageId: 'message-1',
        input: {
          components: [
            {
              type: 17,
              accent_color: 0xe0613a,
              components: [{ type: 10, content: 'Current directory captured.' }]
            }
          ]
        }
      }
    ]);
    expect(channel.sentInputs).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Bash - Print working directory'
          })
        ],
        components: [expect.anything()]
      })
    );
    expect(channel.editCalls).not.toContainEqual(
      expect.objectContaining({ content: expect.stringContaining('Print working directory') })
    );
  });

  it('posts one concise gray tool card per tool completion using description-first summaries', async () => {
    const events = createEventBus();
    const channel = createEditableThreadChannel();
    let turnStarted = false;

    const bot = createDiscordControlBot({
      token: 'discord-token',
      clientId: 'client-1',
      handlers: createCommandHandlers({
        runnerClient: {
          async createSession() {
            return { sessionId: 'session-1' };
          },
          async resolvePrompt() {
            return { status: 'resolved' as const };
          },
          async answerQuestion() {}
        },
        audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: 'session-1', metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
        access: { canManageSessions: () => true },
        allowedRoots: ['/workspace'],
        now: () => '2026-03-25T00:00:00.000Z'
      }),
      runnerClient: {
        async getPendingPrompt() {
          return null;
        },
        async listEvents(input) {
          if (!turnStarted || input.fromSeq !== 1) {
            return [];
          }

          return [
            {
              seq: 1,
              event: {
                type: 'tool.completed',
                toolUseId: 'tool-read-1',
                toolName: 'Read',
                command: '/tmp/ignored',
                description: 'Read package manifest',
                output: '{"name":"app"}',
                stdout: '',
                stderr: '',
                isError: false
              }
            },
            {
              seq: 2,
              event: {
                type: 'tool.completed',
                toolUseId: 'tool-bash-1',
                toolName: 'Bash',
                command: 'pwd',
                output: '/workspace/app',
                stdout: '/workspace/app',
                stderr: '',
                isError: false
              }
            },
            {
              seq: 3,
              event: {
                type: 'tool.completed',
                toolUseId: 'tool-webfetch-1',
                toolName: 'WebFetch',
                output: 'ok',
                stdout: '',
                stderr: '',
                isError: false
              }
            },
            {
              seq: 4,
              event: { type: 'text.delta', messageId: 'msg-tool-1', delta: 'Answer only.' }
            }
          ];
        },
        async *subscribeEvents() {},
        async health() { return { ok: true }; },
        async sendTurn() {
          turnStarted = true;
        },
        async getSession() {
          return { sessionId: 'session-1', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
        }
      },
      bindings: {
        getByThreadId(threadId) {
          return threadId === 'thread-tool-cards'
            ? {
                threadId: 'thread-tool-cards',
                sessionId: 'session-1',
                createdAt: '2026-03-25T00:00:00.000Z',
                updatedAt: '2026-03-25T00:00:00.000Z'
              }
            : null;
        }
      },
      discord: {
        login: events.login,
        destroy: events.destroy,
        on: events.on,
        registerCommands: async () => {},
        getThreadChannel: async () => channel
      }
    });

    await bot.start();
    await events.emit('messageCreate', {
      author: { bot: false, id: 'discord-user-1' },
      content: 'run tool sequence',
      channelId: 'thread-tool-cards',
      channel,
      member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
    });

    expect(channel.sentInputs).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Read - Read package manifest'
          })
        ],
        components: []
      })
    );
    expect(channel.sentInputs).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Bash - `pwd`'
          })
        ],
        components: [expect.anything()]
      })
    );
    expect(channel.sentInputs).toContainEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'WebFetch - WebFetch'
          })
        ],
        components: []
      })
    );
    expect(channel.editInputs).toContainEqual({
      messageId: 'message-1',
      input: {
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Answer only.' }]
          }
        ]
      }
    });
    expect(channel.sentInputs.every((input) => typeof input === 'string' || !('content' in input))).toBe(true);
    expect(channel.editInputs.every((entry) => typeof entry.input === 'string' || !('content' in entry.input))).toBe(true);
  });
});

function createEditableThreadChannel(input?: { existingMessageIds?: string[] }) {
  const sentContents: string[] = [];
  const editedContents: string[] = [];
  const editCalls: Array<{ messageId: string; content: string }> = [];
  const sentInputs: Array<string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }> = [];
  const editInputs: Array<{ messageId: string; input: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number } }> = [];
  const existingMessageIds = new Set(input?.existingMessageIds ?? []);
  let counter = existingMessageIds.size;

  return {
    sentContents,
    editedContents,
    editCalls,
    sentInputs,
    editInputs,
    isThread: () => true,
    async send(content: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }) {
      sentInputs.push(content);
      const text = typeof content === 'string'
        ? content
        : content.content || extractVisibleDiscordText(content);
      sentContents.push(text);
      counter += 1;
      const id = `message-${counter}`;
      existingMessageIds.add(id);
      return { id };
    },
    async edit(messageId: string, content: string | { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }) {
      if (!existingMessageIds.has(messageId)) {
        throw new Error(`unknown message ${messageId}`);
      }

      editInputs.push({ messageId, input: content });

      const text = typeof content === 'string'
        ? content
        : content.content || extractVisibleDiscordText(content);
      editedContents.push(text);
      editCalls.push({ messageId, content: text });
      return { id: messageId };
    }
  };
}

function extractVisibleDiscordText(input: {
  embeds?: unknown[];
  components?: unknown[];
}): string {
  const embedText = (input.embeds as Array<{ description?: string }> | undefined)?.map((embed) => embed.description ?? '').join('\n') ?? '';
  if (embedText.length > 0) {
    return embedText;
  }

  return collectComponentText(input.components ?? []).join('\n');
}

function isWaitingPlaceholderFrame(value: string): boolean {
  return ['Typing...', 'Thinking...', 'Wondering...'].includes(value);
}

function collectComponentText(components: readonly unknown[]): string[] {
  const lines: string[] = [];

  for (const component of components) {
    const value = typeof component === 'object' && component !== null && 'toJSON' in component && typeof (component as { toJSON: () => unknown }).toJSON === 'function'
      ? (component as { toJSON: () => unknown }).toJSON()
      : component;

    if (typeof value !== 'object' || value === null) {
      continue;
    }

    if ('content' in value && typeof (value as { content?: unknown }).content === 'string') {
      lines.push((value as { content: string }).content);
    }

    if ('components' in value && Array.isArray((value as { components?: unknown[] }).components)) {
      lines.push(...collectComponentText((value as { components: unknown[] }).components));
    }
  }

  return lines;
}

function collectButtonLabels(components: readonly unknown[]): string[] {
  const labels: string[] = [];

  for (const component of components) {
    const value = typeof component === 'object' && component !== null && 'toJSON' in component && typeof (component as { toJSON: () => unknown }).toJSON === 'function'
      ? (component as { toJSON: () => unknown }).toJSON()
      : component;

    if (typeof value !== 'object' || value === null) {
      continue;
    }

    if ('label' in value && typeof (value as { label?: unknown }).label === 'string') {
      labels.push((value as { label: string }).label);
    }

    if ('components' in value && Array.isArray((value as { components?: unknown[] }).components)) {
      labels.push(...collectButtonLabels((value as { components: unknown[] }).components));
    }
  }

  return labels;
}

function collectButtonCustomIds(components: readonly unknown[]): string[] {
  const ids: string[] = [];

  for (const component of components) {
    const value = typeof component === 'object' && component !== null && 'toJSON' in component && typeof (component as { toJSON: () => unknown }).toJSON === 'function'
      ? (component as { toJSON: () => unknown }).toJSON()
      : component;

    if (typeof value !== 'object' || value === null) {
      continue;
    }

    if ('custom_id' in value && typeof (value as { custom_id?: unknown }).custom_id === 'string') {
      ids.push((value as { custom_id: string }).custom_id);
    }

    if ('components' in value && Array.isArray((value as { components?: unknown[] }).components)) {
      ids.push(...collectButtonCustomIds((value as { components: unknown[] }).components));
    }
  }

  return ids;
}

function collectStringSelectCustomIds(components: readonly unknown[]): string[] {
  return collectSelectComponents(components).map((component) => component.customId);
}

function collectStringSelectOptionLabels(components: readonly unknown[]): string[] {
  return collectSelectComponents(components).flatMap((component) => component.optionLabels);
}

function collectStringSelectOptionDescriptions(components: readonly unknown[]): string[] {
  return collectSelectComponents(components).flatMap((component) => component.optionDescriptions);
}

function collectStringSelectOptionValues(components: readonly unknown[]): string[] {
  return collectSelectComponents(components).flatMap((component) => component.optionValues);
}

function findButtonCustomIdByLabel(components: readonly unknown[], label: string): string | null {
  for (const component of components) {
    const value = typeof component === 'object' && component !== null && 'toJSON' in component && typeof (component as { toJSON: () => unknown }).toJSON === 'function'
      ? (component as { toJSON: () => unknown }).toJSON()
      : component;

    if (typeof value !== 'object' || value === null) {
      continue;
    }

    if (
      'label' in value &&
      'custom_id' in value &&
      typeof (value as { label?: unknown }).label === 'string' &&
      typeof (value as { custom_id?: unknown }).custom_id === 'string' &&
      (value as { label: string }).label === label
    ) {
      return (value as { custom_id: string }).custom_id;
    }

    if ('components' in value && Array.isArray((value as { components?: unknown[] }).components)) {
      const nested = findButtonCustomIdByLabel((value as { components: unknown[] }).components, label);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function extractEmbedDescriptions(embeds: readonly unknown[]): string[] {
  return embeds.flatMap((embed) => {
    if (typeof embed !== 'object' || embed === null || !('description' in embed)) {
      return [];
    }

    return typeof (embed as { description?: unknown }).description === 'string'
      ? [(embed as { description: string }).description]
      : [];
  });
}

function collectSelectComponents(components: readonly unknown[]): Array<{
  customId: string;
  optionLabels: string[];
  optionDescriptions: string[];
  optionValues: string[];
}> {
  const collected: Array<{
    customId: string;
    optionLabels: string[];
    optionDescriptions: string[];
    optionValues: string[];
  }> = [];

  for (const component of components) {
    const value = typeof component === 'object' && component !== null && 'toJSON' in component && typeof (component as { toJSON: () => unknown }).toJSON === 'function'
      ? (component as { toJSON: () => unknown }).toJSON()
      : component;

    if (typeof value !== 'object' || value === null) {
      continue;
    }

    if (
      'custom_id' in value &&
      typeof (value as { custom_id?: unknown }).custom_id === 'string' &&
      'options' in value &&
      Array.isArray((value as { options?: unknown[] }).options)
    ) {
        collected.push({
          customId: (value as { custom_id: string }).custom_id,
          optionLabels: ((value as { options: unknown[] }).options).flatMap((option) => {
          if (typeof option !== 'object' || option === null || !('label' in option)) {
            return [];
          }

          return typeof (option as { label?: unknown }).label === 'string'
            ? [(option as { label: string }).label]
            : [];
        }),
          optionDescriptions: ((value as { options: unknown[] }).options).flatMap((option) => {
            if (typeof option !== 'object' || option === null || !('description' in option)) {
              return [];
          }

            return typeof (option as { description?: unknown }).description === 'string'
              ? [(option as { description: string }).description]
              : [];
          }),
          optionValues: ((value as { options: unknown[] }).options).flatMap((option) => {
            if (typeof option !== 'object' || option === null || !('value' in option)) {
              return [];
            }

            return typeof (option as { value?: unknown }).value === 'string'
              ? [(option as { value: string }).value]
              : [];
          })
        });
    }

    if ('components' in value && Array.isArray((value as { components?: unknown[] }).components)) {
      collected.push(...collectSelectComponents((value as { components: unknown[] }).components));
    }
  }

  return collected;
}

function createAsyncIterable<T>(values: T[]) {
  let resolveDrain: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });

  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        yield value;
      }
      resolveDrain();
    },
    async drain() {
      await drained;
    }
  };
}

function createSavedWorkdirResult(input: { path: string; displayName?: string; createdBy: string }) {
  return {
    id: `saved:${input.path}`,
    path: input.path,
    displayName: input.displayName ?? null,
    source: 'scan' as const,
    createdBy: input.createdBy,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T00:00:00.000Z',
    lastUsedAt: '2026-03-25T00:00:00.000Z',
    useCount: 1
  };
}

function createEventBus() {
  const handlers = new Map<string, Array<(value: unknown) => Promise<void> | void>>();
  const loginCalls: string[] = [];

  return {
    loginCalls,
    async login(token: string) {
      loginCalls.push(token);
    },
    async destroy() {},
    on(eventName: string, handler: (value: unknown) => Promise<void> | void) {
      const existing = handlers.get(eventName) ?? [];
      existing.push(handler);
      handlers.set(eventName, existing);
    },
    async emit(eventName: string, value: unknown) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(value);
      }
    }
  };
}

function createFakeThread(threadId: string) {
  const sentMessages: Array<unknown> = [];
  return {
    id: threadId,
    isThread: () => true,
    sentMessages,
    async send(input?: unknown) {
      sentMessages.push(input ?? null);
      return;
    }
  };
}

function createFakeChannel(thread: { id: string }) {
  const createdThreadNames: string[] = [];

  return {
    createdThreadNames,
    isThread: () => false,
    threads: {
      create: async (input: { name: string }) => {
        createdThreadNames.push(input.name);
        return thread;
      }
    }
  };
}

function createUserThreadMessage(thread: { id: string }, content: string) {
  return {
    author: { id: 'discord-user-1', bot: false },
    content,
    channelId: thread.id,
    channel: thread,
    member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } }
  };
}

function createNamedSessionHarness(options: {
  thread: ReturnType<typeof createFakeThread>;
  bindingMap?: Map<string, { threadId: string; sessionId: string; createdAt: string; updatedAt: string }>;
  sendTurnCalls?: Array<{ sessionId: string; prompt: string }>;
  createSessionCalls?: number[];
  interactionValues?: {
    cwd?: string;
    model?: string;
    name?: string;
  };
  sessionId?: string;
}) {
  const events = createEventBus();
  const channel = createFakeChannel(options.thread);
  const threadChannel = createEditableThreadChannel();
  const rawThread = {
    id: options.thread.id,
    isThread: () => true,
    async send(content: string | { content?: string }) {
      return { id: `raw-${typeof content === 'string' ? content : content.content ?? 'message'}` };
    },
    async edit() {
      throw new Error('raw discord thread edit should not be used in named session harness');
    }
  };
  const interaction = createCreateSessionInteraction(channel, {
    values: {
      cwd: '/workspace/app',
      model: 'sonnet',
      name: 'Deploy War Room',
      ...(options.interactionValues ?? {})
    }
  });
  const sessionId = options.sessionId ?? 'session-explicit-name-1';
  const bot = createDiscordControlBot({
    token: 'discord-token',
    clientId: 'client-1',
    handlers: createSessionCommandHandlers(sessionId, options.createSessionCalls),
    runnerClient: {
      async getPendingPrompt() {
        return null;
      },
      async listEvents() {
        return [];
      },
      async *subscribeEvents() {},
      async health() {
        return { ok: true };
      },
      async sendTurn(input) {
        options.sendTurnCalls?.push(input);
      },
      async getSession() {
        return { sessionId, state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
      }
    },
    bindings: {
      getByThreadId(threadId) {
        return options.bindingMap?.get(threadId) ?? null;
      },
      upsert(record) {
        options.bindingMap?.set(record.threadId, record);
      }
    },
    discord: {
      login: events.login,
      destroy: events.destroy,
      on: events.on,
      registerCommands: async () => {},
      getThreadChannel: async (threadId) => threadId === options.thread.id ? threadChannel : null
    },
    now: () => '2026-03-25T00:00:00.000Z'
  });

  return {
    channel,
    threadChannel,
    interaction,
    startBot: () => bot.start(),
    emitInteraction: () => events.emit('interactionCreate', interaction),
    emitMessage: (content: string) => events.emit('messageCreate', createUserThreadMessage(rawThread, content))
  };
}

function createRejectedSessionNewHarness(options?: {
  canManageSessions?: boolean;
  createSessionCalls?: number[];
  interaction?: {
    channelId?: string;
    userId?: string;
    roleIds?: string[];
    values?: Record<string, string>;
  };
}) {
  const events = createEventBus();
  const thread = createFakeThread('thread-rejected-session-new');
  const channel = createFakeChannel(thread);
  const interaction = createCreateSessionInteraction(undefined, options?.interaction);
  const bot = createDiscordControlBot({
    token: 'discord-token',
    clientId: 'client-1',
    handlers: createCommandHandlers({
      runnerClient: {
        async createSession() {
          options?.createSessionCalls?.push(1);
          return { sessionId: 'session-rejected-session-new' };
        },
        async resolvePrompt() {
          return { status: 'resolved' as const };
        },
        async answerQuestion() {}
      },
      audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
      access: { canManageSessions: () => options?.canManageSessions ?? true },
      allowedRoots: ['/workspace'],
      now: () => '2026-03-25T00:00:00.000Z'
    }),
    runnerClient: {
      async getPendingPrompt() { return null; },
      async listEvents() { return []; },
      async *subscribeEvents() {},
      async health() { return { ok: true }; },
      async sendTurn() {},
      async getSession() {
        return { sessionId: 'session-rejected-session-new', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null };
      }
    },
    bindings: { getByThreadId() { return null; } },
    discord: {
      login: events.login,
      destroy: events.destroy,
      on: events.on,
      registerCommands: async () => {},
      getChannel: async () => channel
    }
  });

  return {
    channel,
    interaction,
    startBot: () => bot.start(),
    emitInteraction: () => events.emit('interactionCreate', interaction)
  };
}

function createSessionCommandHandlers(sessionId: string, createSessionCalls?: number[]) {
  return createCommandHandlers({
    runnerClient: {
      async createSession() {
        createSessionCalls?.push(1);
        return { sessionId };
      },
      async resolvePrompt() {
        return { status: 'resolved' as const };
      },
      async answerQuestion() {}
    },
    audit: { append() { return { id: 1, action: 'a', actorType: 'user', actorId: 'u', source: 'discord-control', sessionId: null, metadata: {}, createdAt: '2026-03-25T00:00:00.000Z' }; } },
    access: { canManageSessions: () => true },
    allowedRoots: ['/workspace'],
    now: () => '2026-03-25T00:00:00.000Z'
  });
}

function createCreateSessionInteraction(
  channel?: ReturnType<typeof createFakeChannel>,
  options?: {
    channelId?: string;
    throwOnChannelAccess?: boolean;
    userId?: string;
    roleIds?: string[];
    values?: Record<string, string | null>;
  }
) {
  const replies: Array<{ content?: string; ephemeral: boolean; embeds?: unknown[]; components?: unknown[] }> = [];

  const interaction = {
    replies,
    isChatInputCommand: () => true,
    isButton: () => false,
    commandName: 'session-new',
    channelId: options?.channelId ?? 'channel-1',
    user: { id: options?.userId ?? 'discord-user-1' },
    member: {
      roles: {
        cache: new Map((options?.roleIds ?? ['operator']).map((roleId) => [roleId, { id: roleId }]))
      }
    },
    options: {
      getString(name: string) {
        const values: Record<string, string | null> = {
          cwd: '/workspace/app',
          model: 'sonnet',
          ...(options?.values ?? {})
        };
        return values[name] ?? null;
      }
    },
    async reply(input: { content?: string; ephemeral: boolean; embeds?: unknown[]; components?: unknown[] }) {
      replies.push(input);
    }
  } as {
    replies: Array<{ content?: string; ephemeral: boolean; embeds?: unknown[]; components?: unknown[] }>;
    isChatInputCommand: () => boolean;
    isButton: () => boolean;
    commandName: string;
    channelId: string;
    user: { id: string };
    member: { roles: { cache: Map<string, { id: string }> } };
    options: { getString(name: string): string | null };
    reply(input: { content?: string; ephemeral: boolean; embeds?: unknown[]; components?: unknown[] }): Promise<void>;
    channel?: ReturnType<typeof createFakeChannel>;
  };

  if (options?.throwOnChannelAccess) {
    Object.defineProperty(interaction, 'channel', {
      get() {
        throw new Error('interaction.channel getter should not be touched in this test');
      }
    });
    return interaction;
  }

  interaction.channel = channel;
  return interaction;
}

function createButtonInteraction(customId: string, userId = 'discord-user-1') {
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId,
    user: { id: userId },
    member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
    modals: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
    replies: [] as Array<{ content?: string; ephemeral: boolean; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
    async showModal(input: { toJSON?: () => Record<string, unknown> } | Record<string, unknown>) {
      this.modals.push(typeof input.toJSON === 'function' ? input.toJSON() : input);
    },
    async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
      this.updates.push(input);
    },
    async reply(input: { content?: string; ephemeral: boolean; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
      this.replies.push(input);
    }
  };
}

function createStringSelectInteraction(customId: string, values: string[], userId = 'discord-user-1') {
  return {
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    customId,
    values,
    channelId: 'channel-1',
    user: { id: userId },
    member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
    modals: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
    replies: [] as Array<{ content?: string; ephemeral: boolean; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
    async showModal(input: { toJSON?: () => Record<string, unknown> } | Record<string, unknown>) {
      this.modals.push(typeof input.toJSON === 'function' ? input.toJSON() : input);
    },
    async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
      this.updates.push(input);
    },
    async reply(input: { content?: string; ephemeral: boolean; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
      this.replies.push(input);
    }
  };
}

function createModalSubmitInteraction(customId: string, values: Record<string, string>, userId = 'discord-user-1') {
  return {
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId,
    channelId: 'channel-1',
    user: { id: userId },
    member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
    fields: {
      getTextInputValue(name: string) {
        return values[name] ?? '';
      }
    },
    updates: [] as Array<{ content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
    replies: [] as Array<{ content?: string; ephemeral: boolean; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }>,
    async update(input: { content?: string; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
      this.updates.push(input);
    },
    async reply(input: { content?: string; ephemeral: boolean; embeds?: Array<{ description?: string; color?: number }>; components?: unknown[] }) {
      this.replies.push(input);
    }
  };
}
