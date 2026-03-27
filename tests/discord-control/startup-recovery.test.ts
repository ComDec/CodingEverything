import { describe, expect, it } from 'vitest';
import { recoverStartupState } from '../../src/discord-control/startup-recovery.js';
import { SessionState, createSessionContext } from '../../src/shared/domain/session.js';

describe('startup recovery', () => {
  it('reloads bindings, restores root anchors, and marks active sessions runner_unavailable when the runner is down', async () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1'
    });

    const result = await recoverStartupState({
      bindings: [
        {
          threadId: 'thread-1',
          sessionId: 'session-1',
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        }
      ],
      sessions: [
        {
          id: 'session-1',
          state: SessionState.running,
          runtimeSessionId: null,
          context,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        },
        {
          id: 'session-2',
          state: SessionState.closed,
          runtimeSessionId: null,
          context,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        }
      ],
      rootAnchors: {
        'session-1': 'discord-root-1',
        'session-2': 'discord-root-2'
      },
      runnerClient: {
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          throw new Error('runner is offline');
        },
        async getPendingPrompt() {
          return null;
        }
      }
    });

    expect(result.router.getSessionIdByThread('thread-1')).toBe('session-1');
    expect(result.recoveredSessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        threadId: 'thread-1',
        runnerStatus: 'runner_unavailable',
        model: expect.objectContaining({
          anchor: { rootMessageId: 'discord-root-1' }
        })
      })
    ]);
  });

  it('skips sessions that no longer have a Discord thread binding', async () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1'
    });

    const result = await recoverStartupState({
      bindings: [],
      sessions: [
        {
          id: 'session-orphan',
          state: SessionState.idle,
          runtimeSessionId: 'runtime-orphan',
          context,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        }
      ],
      rootAnchors: {
        'session-orphan': 'discord-root-orphan'
      },
      runnerClient: {
        async listEvents() {
          return [];
        },
        async *subscribeEvents() {},
        async health() {
          return { ok: true };
        },
        async getPendingPrompt() {
          return null;
        }
      }
    });

    expect(result.recoveredSessions).toEqual([]);
  });
});
