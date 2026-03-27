import { describe, expect, it } from 'vitest';
import { replaySessionEvents } from '../../src/discord-control/replay-controller.js';
import type { RunnerClient } from '../../src/discord-control/runner-client.js';
import { createRenderModel } from '../../src/discord-control/render-model.js';

describe('replay controller', () => {
  it('replays from lastConsumedEventSeq plus one', async () => {
    const calls: number[] = [];
    const runnerClient: RunnerClient = {
      async listEvents(input) {
        calls.push(input.fromSeq);
        return [
          {
            seq: 5,
            event: { type: 'text.delta', messageId: 'msg-1', delta: 'Hello' }
          },
          {
            seq: 6,
            event: { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' }
          }
        ];
      },
      async health() {
        return { ok: true };
      },
      async *subscribeEvents() {},
      async getPendingPrompt() {
        return null;
      }
    };

    const initialModel = {
      ...createRenderModel({ sessionId: 'session-1', threadId: 'thread-1' }),
      lastConsumedEventSeq: 4
    };

    const result = await replaySessionEvents({
      sessionId: 'session-1',
      model: initialModel,
      runnerClient
    });

    expect(calls).toEqual([5]);
    expect(result.replayedCount).toBe(2);
    expect(result.model).toMatchObject({
      lastConsumedEventSeq: 6,
      text: 'Hello',
      activePrompt: {
        kind: 'permission',
        promptId: 'perm-1'
      }
    });
  });

  it('refreshes an already-pending prompt after restart when replay has no newer prompt event', async () => {
    const runnerClient: RunnerClient = {
      async listEvents() {
        return [];
      },
      async health() {
        return { ok: true };
      },
      async *subscribeEvents() {},
      async getPendingPrompt(input) {
        expect(input.sessionId).toBe('session-2');
        return {
          kind: 'permission',
          promptId: 'perm-9',
          runtimePromptId: 'sdk-perm-9',
          text: 'Approve restart recovery?'
        };
      }
    };

    const initialModel = {
      ...createRenderModel({ sessionId: 'session-2', threadId: 'thread-2' }),
      lastConsumedEventSeq: 9
    };

    const result = await replaySessionEvents({
      sessionId: 'session-2',
      model: initialModel,
      runnerClient
    });

    expect(result.replayedCount).toBe(0);
    expect(result.model.activePrompt).toEqual({
      kind: 'permission',
      promptId: 'perm-9',
      runtimePromptId: 'sdk-perm-9',
      text: 'Approve restart recovery?'
    });
    expect(result.model.lastConsumedEventSeq).toBe(9);
  });
});
