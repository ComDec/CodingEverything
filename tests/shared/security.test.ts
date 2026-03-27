import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import {
  assertPathWithinRoots,
  canManageSessions,
  isPromptExpired
} from '../../src/shared/security.js';

describe('security helpers', () => {
  it('rejects paths outside allowed roots', () => {
    expect(() =>
      assertPathWithinRoots('/srv/app/src/index.ts', ['/srv/app', '/srv/shared'])
    ).not.toThrow();

    expect(() =>
      assertPathWithinRoots('/tmp/escape.txt', ['/srv/app', '/srv/shared'])
    ).toThrowError('Path is outside the allowed roots.');
  });

  it('expands a leading tilde before checking allowed roots', () => {
    const root = `${homedir()}/project/remote-coding`;
    expect(() =>
      assertPathWithinRoots('~/project/remote-coding', [root])
    ).not.toThrow();
  });

  it('detects expired prompts', () => {
    expect(
      isPromptExpired('2026-03-25T00:05:00.000Z', '2026-03-25T00:05:00.000Z')
    ).toBe(true);
    expect(
      isPromptExpired('2026-03-25T00:05:00.000Z', '2026-03-25T00:04:59.000Z')
    ).toBe(false);
  });

  it('allows session management from configured user and role ids', () => {
    expect(
      canManageSessions({
        userId: 'viewer-1',
        roles: ['viewer-role'],
        allowedUserIds: ['manager-1'],
        allowedRoleIds: ['discord-role-1']
      })
    ).toBe(false);
    expect(
      canManageSessions({
        userId: 'manager-1',
        roles: ['viewer-role'],
        allowedUserIds: ['manager-1'],
        allowedRoleIds: ['discord-role-1']
      })
    ).toBe(true);
    expect(
      canManageSessions({
        userId: 'viewer-1',
        roles: ['discord-role-1'],
        allowedUserIds: ['manager-1'],
        allowedRoleIds: ['discord-role-1']
      })
    ).toBe(true);
  });
});
