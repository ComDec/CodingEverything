import { describe, expect, it, vi } from 'vitest';
import { createDiscordControlBot } from '../../src/discord-control/bot.js';
import { createCommandHandlers } from '../../src/discord-control/command-handlers.js';
import type { RunnerEventEnvelope } from '../../src/discord-control/runner-client.js';

describe('discord control bot', () => {
  it('logs in, registers commands, and creates a thread-backed session from a slash command', async () => {
    const events = createEventBus();
    const registerCalls: string[][] = [];
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
        registerCommands: async (commands) => {
          registerCalls.push(commands.map((command) => command.name));
        }
      }
    });

    await bot.start();
    await events.emit('interactionCreate', interaction);

    expect(events.loginCalls).toEqual(['discord-token']);
    expect(registerCalls).toEqual([['session-new']]);
    expect(createSessionCalls).toEqual([{ channelId: 'thread-1', userId: 'discord-user-1' }]);
    expect(channel.createdThreadNames).toEqual(['Claude session']);
    expect(thread.sentMessages).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            color: 0x6b7280,
            description: 'Session session-1\ncwd: /workspace/app\nmodel: sonnet\neffort: default\nskills: none'
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

  it('replies with a user-facing error when session creation input is invalid', async () => {
    const events = createEventBus();
    const interaction = createCreateSessionInteraction(undefined, {
      channelId: 'channel-invalid',
      values: { cwd: '/tmp/not-allowed', model: 'sonnet' }
    });
    const thread = createFakeThread('thread-invalid');
    const channel = createFakeChannel(thread);
    const handlers = createCommandHandlers({
      runnerClient: {
        async createSession() {
          return { sessionId: 'session-invalid' };
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
        async getSession() { return { sessionId: 'session-invalid', state: 'idle', recoveryStatus: 'ok', pendingPrompt: null }; }
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
    await events.emit('interactionCreate', interaction);

    expect(interaction.replies).toEqual([
      {
        content: 'Path is outside the allowed roots.',
        ephemeral: true
      }
    ]);
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
          return null;
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
    expect(restartedMessages).toEqual([]);
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
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'prompt:allow_once:prompt-ok:session-1',
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

function createCreateSessionInteraction(
  channel?: ReturnType<typeof createFakeChannel>,
  options?: {
    channelId?: string;
    throwOnChannelAccess?: boolean;
    values?: Record<string, string>;
  }
) {
  const replies: Array<{ content: string; ephemeral: boolean }> = [];

  const interaction = {
    replies,
    isChatInputCommand: () => true,
    isButton: () => false,
    commandName: 'session-new',
    channelId: options?.channelId ?? 'channel-1',
    user: { id: 'discord-user-1' },
    member: { roles: { cache: new Map([['operator', { id: 'operator' }]]) } },
    options: {
      getString(name: string) {
        const values: Record<string, string> = {
          cwd: '/workspace/app',
          model: 'sonnet',
          ...(options?.values ?? {})
        };
        return values[name] ?? null;
      }
    },
    async reply(input: { content: string; ephemeral: boolean }) {
      replies.push(input);
    }
  } as {
    replies: Array<{ content: string; ephemeral: boolean }>;
    isChatInputCommand: () => boolean;
    isButton: () => boolean;
    commandName: string;
    channelId: string;
    user: { id: string };
    member: { roles: { cache: Map<string, { id: string }> } };
    options: { getString(name: string): string | null };
    reply(input: { content: string; ephemeral: boolean }): Promise<void>;
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
