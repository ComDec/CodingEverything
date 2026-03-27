import { describe, expect, it } from 'vitest';
import { SessionState, createSessionContext } from '../../src/shared/domain/session.js';
import { recoverRunnerState } from '../../src/local-runner/recovery.js';

describe('recoverRunnerState', () => {
  it('restores pending permissions and questions as synthetic recovery events', async () => {
    const context = createSessionContext({
      cwd: '/workspace/app',
      allowedRoot: '/workspace',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'discord-user-1'
    });

    const result = await recoverRunnerState({
      sessions: [
        {
          id: 'session-1',
          state: SessionState.awaitingPermission,
          runtimeSessionId: null,
          context,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        },
        {
          id: 'session-2',
          state: SessionState.awaitingUserAnswer,
          runtimeSessionId: null,
          context,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        },
        {
          id: 'session-3',
          state: SessionState.closed,
          runtimeSessionId: null,
          context,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z'
        }
      ],
      prompts: [
        {
          id: 'prompt-1',
          sessionId: 'session-1',
          kind: 'permission',
          status: 'pending',
          payload: { requestId: 'perm-1', prompt: 'Allow write?' },
          expiresAt: '2026-03-25T00:05:00.000Z',
          createdAt: '2026-03-25T00:00:00.000Z'
        },
        {
          id: 'prompt-2',
          sessionId: 'session-2',
          kind: 'question',
          status: 'pending',
          payload: { questionId: 'q-1', text: 'Continue?' },
          expiresAt: '2026-03-25T00:05:00.000Z',
          createdAt: '2026-03-25T00:00:00.000Z'
        },
        {
          id: 'prompt-3',
          sessionId: 'session-3',
          kind: 'permission',
          status: 'pending',
          payload: { requestId: 'perm-2', prompt: 'Should not replay' },
          expiresAt: '2026-03-25T00:05:00.000Z',
          createdAt: '2026-03-25T00:00:00.000Z'
        }
      ]
    });

    expect(result.syntheticEvents).toEqual([
      { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' },
      { type: 'question.asked', questionId: 'q-1', text: 'Continue?' }
    ]);
  });
});
