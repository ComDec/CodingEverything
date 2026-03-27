import { describe, expect, it } from 'vitest';
import { buildHealthSnapshot } from '../../src/shared/health.js';

describe('health helpers', () => {
  it('builds a frozen health snapshot with counters and component states', () => {
    const snapshot = buildHealthSnapshot({
      service: 'runner-shared',
      checkedAt: '2026-03-25T00:00:00.000Z',
      counters: {
        activeSessions: 2,
        pendingPrompts: 1,
        queuedEvents: 4
      },
      components: {
        database: 'ok',
        persistence: 'ok'
      }
    });

    expect(snapshot).toEqual({
      ok: true,
      service: 'runner-shared',
      checkedAt: '2026-03-25T00:00:00.000Z',
      counters: {
        activeSessions: 2,
        pendingPrompts: 1,
        queuedEvents: 4
      },
      components: {
        database: 'ok',
        persistence: 'ok'
      }
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
    expect(Object.isFrozen(snapshot.components)).toBe(true);
  });
});
