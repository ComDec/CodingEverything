import { describe, expect, it } from 'vitest';
import {
  applyRunnerEvent,
  createRenderModel,
  startNewTurn
} from '../../src/discord-control/render-model.js';
import { renderSessionMessage } from '../../src/discord-control/message-renderer.js';

describe('message renderer', () => {
  it('renders assistant replies as blue-gray embeds instead of plain text messages', () => {
    let model = createRenderModel({
      sessionId: 'session-embed-1',
      threadId: 'thread-embed-1',
      rootMessageId: 'discord-root-embed-1'
    });

    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: 'discord-root-embed-1' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Waiting for runner output.' }]
          }
        ]
      }
    ]);

    model = applyRunnerEvent(model, {
      seq: 1,
      event: { type: 'text.delta', messageId: 'msg-embed-1', delta: 'Hello embed world' }
    });

    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: 'discord-root-embed-1' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Hello embed world' }]
          }
        ]
      }
    ]);
  });

  it('renders a custom waiting placeholder before assistant text arrives', () => {
    const model = createRenderModel({
      sessionId: 'session-waiting-1',
      threadId: 'thread-waiting-1',
      rootMessageId: 'discord-root-waiting-1'
    });

    expect(renderSessionMessage(model, { waitingPlaceholder: 'Typing...' })).toEqual([
      {
        anchor: { rootMessageId: 'discord-root-waiting-1' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Typing...' }]
          }
        ]
      }
    ]);
  });

  it('renders only the assistant reply text and preserves the current anchor', () => {
    let model = createRenderModel({
      sessionId: 'session-1',
      threadId: 'thread-1',
      rootMessageId: 'discord-root-1'
    });

    model = applyRunnerEvent(model, {
      seq: 1,
      event: { type: 'text.delta', messageId: 'msg-1', delta: 'Hello' }
    });
    model = applyRunnerEvent(model, {
      seq: 2,
      event: { type: 'text.delta', messageId: 'msg-1', delta: ' world' }
    });
    model = applyRunnerEvent(model, {
      seq: 3,
      event: { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' }
    });

    expect(model).toMatchObject({
      lastConsumedEventSeq: 3,
      text: 'Hello world',
      anchor: { rootMessageId: 'discord-root-1' },
      activePrompt: {
        kind: 'permission',
        promptId: 'perm-1',
        text: 'Allow write?'
      }
    });
    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: 'discord-root-1' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Hello world' }]
          }
        ]
      }
    ]);
  });

  it('ignores already-consumed events and clears the active prompt on resolution', () => {
    let model = createRenderModel({
      sessionId: 'session-2',
      threadId: 'thread-2'
    });

    model = applyRunnerEvent(model, {
      seq: 1,
      event: { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' }
    });
    model = applyRunnerEvent(model, {
      seq: 1,
      event: { type: 'text.delta', messageId: 'msg-1', delta: 'stale' }
    });
    model = applyRunnerEvent(model, {
      seq: 2,
      event: { type: 'permission.resolved', promptId: 'perm-1', resolution: 'allow_once' }
    });

    expect(model.lastConsumedEventSeq).toBe(2);
    expect(model.text).toBe('');
    expect(model.activePrompt).toBeNull();
    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: null },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Waiting for runner output.' }]
          }
        ]
      }
    ]);
  });

  it('chunks long assistant output into safe message-sized parts', () => {
    let model = createRenderModel({
      sessionId: 'session-3',
      threadId: 'thread-3'
    });

    model = applyRunnerEvent(model, {
      seq: 1,
      event: { type: 'text.delta', messageId: 'msg-1', delta: 'A'.repeat(70) }
    });
    model = applyRunnerEvent(model, {
      seq: 2,
      event: { type: 'permission.requested', requestId: 'perm-2', prompt: 'Approve deploy?' }
    });

    expect(renderSessionMessage(model, { maxChunkLength: 30 })).toEqual([
      {
        anchor: { rootMessageId: null },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }]
          }
        ]
      },
      {
        anchor: { rootMessageId: null },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }]
          }
        ]
      },
      {
        anchor: { rootMessageId: null },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'AAAAAAAAAA' }]
          }
        ]
      }
    ]);
  });

  it('starts a new turn by clearing assistant text and forcing a new anchor while keeping the cursor', () => {
    let model = createRenderModel({
      sessionId: 'session-4',
      threadId: 'thread-4',
      rootMessageId: 'assistant-1'
    });

    model = applyRunnerEvent(model, {
      seq: 7,
      event: { type: 'text.delta', messageId: 'msg-7', delta: 'Old reply' }
    });

    const nextTurn = startNewTurn(model, 'thread-4');

    expect(nextTurn).toMatchObject({
      sessionId: 'session-4',
      threadId: 'thread-4',
      lastConsumedEventSeq: 7,
      text: '',
      anchor: { rootMessageId: null },
      activePrompt: null
    });
  });

  it('strips duplicated Bash output from the assistant reply when the same output is available as a detail card', () => {
    let model = createRenderModel({
      sessionId: 'session-5',
      threadId: 'thread-5',
      rootMessageId: 'assistant-5'
    });

    model = applyRunnerEvent(model, {
      seq: 1,
      event: {
        type: 'tool.started',
        toolUseId: 'tool-bash-5',
        toolName: 'Bash',
        command: 'pwd'
      }
    });
    model = applyRunnerEvent(model, {
      seq: 2,
      event: {
        type: 'tool.completed',
        toolUseId: 'tool-bash-5',
        toolName: 'Bash',
        command: 'pwd',
        output: '/workspace/app',
        stdout: '/workspace/app',
        stderr: '',
        isError: false
      }
    });
    model = applyRunnerEvent(model, {
      seq: 3,
      event: {
        type: 'text.delta',
        messageId: 'msg-5',
        delta: '`/workspace/app`\nThe current directory is shown above.'
      }
    });

    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: 'assistant-5' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'The current directory is shown above.' }]
          }
        ]
      }
    ]);
  });

  it('does not strip ordinary prose that only mentions a short Bash output substring', () => {
    let model = createRenderModel({
      sessionId: 'session-5b',
      threadId: 'thread-5b',
      rootMessageId: 'assistant-5b'
    });

    model = applyRunnerEvent(model, {
      seq: 1,
      event: {
        type: 'tool.started',
        toolUseId: 'tool-bash-5b',
        toolName: 'Bash',
        command: 'ls src'
      }
    });
    model = applyRunnerEvent(model, {
      seq: 2,
      event: {
        type: 'tool.completed',
        toolUseId: 'tool-bash-5b',
        toolName: 'Bash',
        command: 'ls src',
        output: 'src',
        stdout: 'src',
        stderr: '',
        isError: false
      }
    });
    model = applyRunnerEvent(model, {
      seq: 3,
      event: {
        type: 'text.delta',
        messageId: 'msg-5b',
        delta: 'Use the src directory for the implementation.'
      }
    });

    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: 'assistant-5b' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Use the src directory for the implementation.' }]
          }
        ]
      }
    ]);
  });

  it('falls back to a compact completion message when assistant text only repeats Bash output', () => {
    let model = createRenderModel({
      sessionId: 'session-6',
      threadId: 'thread-6',
      rootMessageId: 'assistant-6'
    });

    model = applyRunnerEvent(model, {
      seq: 1,
      event: {
        type: 'tool.started',
        toolUseId: 'tool-bash-6',
        toolName: 'Bash',
        command: 'ls'
      }
    });
    model = applyRunnerEvent(model, {
      seq: 2,
      event: {
        type: 'tool.completed',
        toolUseId: 'tool-bash-6',
        toolName: 'Bash',
        command: 'ls',
        output: 'README.md\nsrc',
        stdout: 'README.md\nsrc',
        stderr: '',
        isError: false
      }
    });
    model = applyRunnerEvent(model, {
      seq: 3,
      event: {
        type: 'text.delta',
        messageId: 'msg-6',
        delta: 'README.md\nsrc'
      }
    });

    expect(renderSessionMessage(model)).toEqual([
      {
        anchor: { rootMessageId: 'assistant-6' },
        content: '',
        flags: 32768,
        embeds: [],
        components: [
          {
            type: 17,
            accent_color: 0xe0613a,
            components: [{ type: 10, content: 'Waiting for runner output.' }]
          }
        ]
      }
    ]);
  });
});
