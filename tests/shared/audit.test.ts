import { describe, expect, it } from 'vitest';
import { buildAuditEntry } from '../../src/shared/audit.js';

describe('audit helpers', () => {
  it('builds structured audit entries with explicit provenance fields', () => {
    const entry = buildAuditEntry({
      action: 'session.created',
      actorType: 'user',
      actorId: 'user-1',
      source: 'discord-bot',
      sessionId: 'session-1',
      metadata: { command: 'run' },
      createdAt: '2026-03-25T00:00:00.000Z'
    });

    expect(entry).toEqual({
      action: 'session.created',
      actorType: 'user',
      actorId: 'user-1',
      source: 'discord-bot',
      sessionId: 'session-1',
      metadata: { command: 'run' },
      createdAt: '2026-03-25T00:00:00.000Z'
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metadata)).toBe(true);
  });

  it('defaults missing session ids to null', () => {
    expect(
      buildAuditEntry({
        action: 'auth.denied',
        actorType: 'system',
        actorId: 'user-2',
        source: 'runner-core',
        metadata: { reason: 'role_missing' },
        createdAt: '2026-03-25T00:01:00.000Z'
      })
    ).toEqual({
      action: 'auth.denied',
      actorType: 'system',
      actorId: 'user-2',
      source: 'runner-core',
      sessionId: null,
      metadata: { reason: 'role_missing' },
      createdAt: '2026-03-25T00:01:00.000Z'
    });
  });
});
