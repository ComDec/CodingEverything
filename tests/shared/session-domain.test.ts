import { describe, expect, it } from 'vitest';
import { getSessionManagerAllowlistWarning, parseAppConfig } from '../../src/shared/config.js';
import {
  EVENT_TYPES,
  type RuntimeEvent
} from '../../src/shared/domain/events.js';
import {
  type CreateSessionRequest,
  type SessionSummary
} from '../../src/shared/contracts/runner-api.js';
import { createFakeRuntime } from '../support/fake-runtime.js';
import {
  SessionState,
  SESSION_STATES,
  createSessionContext,
  createApprovalMatcher
} from '../../src/shared/domain/session.js';

describe('session domain', () => {
  it('creates immutable session context', () => {
    const cwd = '/tmp/project';
    const runtimeOptions = {
      permissionMode: 'default' as const,
      skills: ['project-memory', 'safe-bash']
    };

    const context = createSessionContext({
      cwd,
      allowedRoot: '/tmp/project',
      model: 'sonnet',
      runtimeOptions,
      createdBy: 'discord-user-1'
    });

    expect(context).toEqual({
      cwd,
      allowedRoot: '/tmp/project',
      model: 'sonnet',
      runtimeOptions,
      createdBy: 'discord-user-1'
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.runtimeOptions)).toBe(true);
    expect(Object.isFrozen(context.runtimeOptions.skills)).toBe(true);

    const mutableRuntimeOptions = runtimeOptions as { permissionMode: string; skills: string[] };
    mutableRuntimeOptions.permissionMode = 'acceptEdits';
    mutableRuntimeOptions.skills.push('extra-skill');

    expect(context.runtimeOptions).toEqual({
      permissionMode: 'default',
      skills: ['project-memory', 'safe-bash']
    });
  });

  it('preserves displayName on immutable session context', () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1',
      displayName: 'pretty-fire'
    });

    expect(context.displayName).toBe('pretty-fire');
  });

  it('normalizes invalid and overlong displayName values at the shared boundary', () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1',
      displayName: `  Pretty   Fire_room ${'A'.repeat(120)}  `
    });

    expect(context.displayName).toMatch(/^pretty-fire-room-a+$/);
    expect(context.displayName).toHaveLength(100);
  });

  it('drops displayName when normalization removes all content', () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1',
      displayName: '---___   '
    });

    expect(context.displayName).toBeUndefined();
  });

  it('downgrades matcher to once when scope is not normalizable', () => {
    expect(
      createApprovalMatcher({
        scope: 'workspace-write',
        target: undefined
      })
    ).toEqual({
      scope: 'once'
    });
  });

  it('exposes recovery-aware session states', () => {
    expect(SessionState.awaitingPermission).toBe('awaiting_permission');
    expect(SessionState.awaitingUserAnswer).toBe('awaiting_user_answer');
    expect(SessionState.failed).toBe('failed');
    expect(SESSION_STATES).toEqual(
      expect.arrayContaining(['created', 'idle', 'recovering', 'closed'])
    );
  });
});

describe('shared config', () => {
  it('parses roots and RBAC allowlists and defaults the Claude model to sonnet', () => {
    const config = parseAppConfig({
      DISCORD_TOKEN: 'discord-token',
      DISCORD_CLIENT_ID: 'discord-client-id',
      RUNNER_DATABASE_PATH: './var/runner.db',
      ALLOWED_ROOTS: ' /srv/app, /srv/shared ,, ',
      SESSION_MANAGER_USER_IDS: ' user-1, user-2 ,, ',
      SESSION_MANAGER_ROLE_IDS: ' role-1, role-2 ,, '
    });

    expect(config.allowedRoots).toEqual(['/srv/app', '/srv/shared']);
    expect(config.sessionManagerUserIds).toEqual(['user-1', 'user-2']);
    expect(config.sessionManagerRoleIds).toEqual(['role-1', 'role-2']);
    expect(config.claudeModel).toBe('sonnet');
    expect(config.discordClientId).toBe('discord-client-id');
    expect(config.runnerDatabasePath).toBe('./var/runner.db');
  });

  it('warns when both RBAC allowlists are unset because Discord command actions will be denied', () => {
    const config = parseAppConfig({
      DISCORD_TOKEN: 'discord-token',
      DISCORD_CLIENT_ID: 'discord-client-id',
      RUNNER_DATABASE_PATH: './var/runner.db',
      ALLOWED_ROOTS: '/srv/app'
    });

    expect(getSessionManagerAllowlistWarning(config)).toBe(
      'Discord control RBAC is locked down: set SESSION_MANAGER_USER_IDS or SESSION_MANAGER_ROLE_IDS or all command actions will be denied.'
    );
  });
});

describe('shared events and contracts', () => {
  it('exposes the planned runtime event types', () => {
    expect(EVENT_TYPES).toEqual([
      'text.delta',
      'tool.started',
      'tool.completed',
      'permission.requested',
      'question.asked',
      'turn.completed'
    ]);
  });

  it('supports runner DTOs against the shared domain types', () => {
    const context = createSessionContext({
      cwd: '/srv/app',
      allowedRoot: '/srv',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-2'
    });

    const request: CreateSessionRequest = {
      channelId: 'thread-1',
      context
    };

    const summary: SessionSummary = {
      sessionId: 'session-1',
      state: SessionState.idle,
      context
    };

    const event: RuntimeEvent = {
      type: 'turn.completed',
      exitCode: 0
    };

    expect(request.context.createdBy).toBe('discord-user-2');
    expect(summary.state).toBe('idle');
    expect(event.type).toBe('turn.completed');
  });
});

describe('fake runtime support', () => {
  it('emits scripted permission, question, and completion events deterministically', async () => {
    const runtime = createFakeRuntime([
      { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' },
      { type: 'question.asked', questionId: 'q-1', text: 'Continue?' },
      { type: 'turn.completed', exitCode: 0 }
    ]);

    await expect(runtime.nextEvent()).resolves.toEqual({
      type: 'permission.requested',
      requestId: 'perm-1',
      prompt: 'Allow write?'
    });
    await expect(runtime.nextEvent()).resolves.toEqual({
      type: 'question.asked',
      questionId: 'q-1',
      text: 'Continue?'
    });
    await expect(runtime.nextEvent()).resolves.toEqual({
      type: 'turn.completed',
      exitCode: 0
    });
    await expect(runtime.nextEvent()).resolves.toBeNull();
  });
});
