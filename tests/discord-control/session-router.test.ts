import { describe, expect, it } from 'vitest';
import { createSessionRouter } from '../../src/discord-control/session-router.js';

describe('session router', () => {
  it('maps a Discord thread to a runner session in both directions', () => {
    const router = createSessionRouter({
      bindings: [],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    router.bindThread({ threadId: 'thread-1', sessionId: 'session-1' });

    expect(router.getSessionIdByThread('thread-1')).toBe('session-1');
    expect(router.getThreadIdBySession('session-1')).toBe('thread-1');
    expect(router.listBindings()).toEqual([
      {
        threadId: 'thread-1',
        sessionId: 'session-1',
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z'
      }
    ]);
  });

  it('replaces stale reverse mappings when a thread is rebound', () => {
    const router = createSessionRouter({
      bindings: [
        {
          threadId: 'thread-1',
          sessionId: 'session-1',
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:00:00.000Z'
        }
      ],
      now: () => '2026-03-25T00:00:00.000Z'
    });

    router.bindThread({ threadId: 'thread-1', sessionId: 'session-2' });

    expect(router.getSessionIdByThread('thread-1')).toBe('session-2');
    expect(router.getThreadIdBySession('session-1')).toBeNull();
    expect(router.getThreadIdBySession('session-2')).toBe('thread-1');
  });
});
