import type { RuntimeEvent } from '../../shared/domain/events.js';

export type ClaudeSdkRawEvent = Record<string, unknown> & { type: string };

export type ClaudeAdapterInternalEvent =
  | Readonly<{
      type: 'session.init';
      sessionId: string;
      runtimeSessionId: string;
    }>
  | Readonly<{
      type: 'text.delta';
      sessionId: string;
      messageId: string;
      delta: string;
    }>
  | Readonly<{
      type: 'tool.started';
      sessionId: string;
      toolUseId: string;
      toolName: string;
      command?: string;
      description?: string;
    }>
  | Readonly<{
      type: 'tool.completed';
      sessionId: string;
      toolUseId: string;
      output: string;
      stdout: string;
      stderr: string;
      isError: boolean;
    }>
  | Readonly<{
      type: 'permission.requested';
      sessionId: string;
      requestId: string;
      runtimePromptId: string;
      prompt: string;
    }>
  | Readonly<{
      type: 'question.asked';
      sessionId: string;
      questionId: string;
      runtimePromptId: string;
      text: string;
    }>
  | Readonly<{
      type: 'turn.completed';
      sessionId: string;
      exitCode: number;
    }>;

export type NormalizedClaudeEvent = Readonly<{
  internalEvents: ClaudeAdapterInternalEvent[];
  runtimeEvents: RuntimeEvent[];
}>;

export function normalizeClaudeEvent(
  sessionId: string,
  event: ClaudeSdkRawEvent
): NormalizedClaudeEvent {
  if (isInitEvent(event)) {
    const runtimeSessionId = readString(event.session_id);
    if (!runtimeSessionId) {
      return emptyNormalization();
    }

    return {
      internalEvents: [
        {
          type: 'session.init',
          sessionId,
          runtimeSessionId
        }
      ],
      runtimeEvents: []
    };
  }

  if (event.type === 'stream_event') {
    const delta = readStreamTextDelta(event.event);
    if (!delta) {
      return emptyNormalization();
    }

    return {
      internalEvents: [],
      runtimeEvents: [{ type: 'text.delta', messageId: delta.messageId, delta: delta.text }]
    };
  }

  if (event.type === 'assistant/message' || event.type === 'assistant') {
    const message = readRecord(event.message);
    const messageId = readString(message?.id) ?? 'assistant-message';
    const content = Array.isArray(message?.content) ? message.content : [];
    const internalEvents: ClaudeAdapterInternalEvent[] = [];

    for (const item of content) {
      if (isTextItem(item)) {
        internalEvents.push({
          type: 'text.delta',
          sessionId,
          messageId,
          delta: item.text
        });
        continue;
      }

      if (isToolUseItem(item)) {
        internalEvents.push({
          type: 'tool.started',
          sessionId,
          toolUseId: item.id,
          toolName: item.name,
          command: readString(readRecord(item.input)?.command) ?? undefined,
          description: readString(readRecord(item.input)?.description) ?? undefined
        });
      }
    }

    return {
      internalEvents,
      runtimeEvents: internalEvents
        .filter(
          (item): item is Extract<ClaudeAdapterInternalEvent, { type: 'tool.started' }> =>
            item.type === 'tool.started'
        )
        .map((item) => ({
          type: 'tool.started',
          toolUseId: item.toolUseId,
          toolName: item.toolName,
          command: item.command,
          description: item.description
        }))
    };
  }

  if (event.type === 'user') {
    const message = readRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const toolResult = readRecord(event.tool_use_result);
    const completedEvents = content.flatMap((item) => {
      if (!isToolResultItem(item)) {
        return [];
      }

      const stdout = readString(toolResult?.stdout) ?? '';
      const stderr = readString(toolResult?.stderr) ?? '';
      const contentOutput = readToolResultOutput(item.content);
      const output = [stdout, stderr].filter((part) => part.length > 0).join(stderr ? '\n' : '') || contentOutput;

      return [
        {
          type: 'tool.completed',
          sessionId,
          toolUseId: item.tool_use_id,
          output,
          stdout,
          stderr,
          isError: item.is_error
        } satisfies ClaudeAdapterInternalEvent
      ];
    });

    return {
      internalEvents: completedEvents,
      runtimeEvents: completedEvents.map((item) => ({
        type: 'tool.completed' as const,
        toolUseId: item.toolUseId,
        toolName: '',
        output: item.output,
        stdout: item.stdout,
        stderr: item.stderr,
        isError: item.isError
      }))
    };
  }

  if (event.type === 'result') {
    const exitCode = readNumber(event.exit_code) ?? (event.subtype === 'success' ? 0 : 1);

    return {
      internalEvents: [
        {
          type: 'turn.completed',
          sessionId,
          exitCode
        }
      ],
      runtimeEvents: [{ type: 'turn.completed', exitCode }]
    };
  }

  return emptyNormalization();
}

function isInitEvent(event: ClaudeSdkRawEvent): boolean {
  return event.type === 'system/init' || (event.type === 'system' && event.subtype === 'init');
}

function readStreamTextDelta(value: unknown): { messageId: string; text: string } | null {
  const event = readRecord(value);
  if (!event || event.type !== 'content_block_delta') {
    return null;
  }

  const delta = readRecord(event.delta);
  const text = readString(delta?.text);
  if (!delta || delta.type !== 'text_delta' || !text) {
    return null;
  }

  return {
    messageId: readString(event.message_id) ?? 'stream',
    text
  };
}

export function normalizePermissionRequest(input: {
  sessionId: string;
  requestId: string;
  runtimePromptId?: string;
  toolName: string;
  prompt?: string;
}): NormalizedClaudeEvent {
  const prompt = input.prompt?.trim() || `Allow Claude to use ${input.toolName}?`;
  const runtimePromptId = input.runtimePromptId ?? input.requestId;

  return {
    internalEvents: [
      {
        type: 'permission.requested',
        sessionId: input.sessionId,
        requestId: input.requestId,
        runtimePromptId,
        prompt
      }
    ],
    runtimeEvents: [
      {
        type: 'permission.requested',
        requestId: input.requestId,
        runtimePromptId,
        prompt
      }
    ]
  };
}

export function normalizeQuestionRequest(input: {
  sessionId: string;
  questionId: string;
  runtimePromptId?: string;
  text: string;
}): NormalizedClaudeEvent {
  const runtimePromptId = input.runtimePromptId ?? input.questionId;

  return {
    internalEvents: [
      {
        type: 'question.asked',
        sessionId: input.sessionId,
        questionId: input.questionId,
        runtimePromptId,
        text: input.text
      }
    ],
    runtimeEvents: [
      {
        type: 'question.asked',
        questionId: input.questionId,
        runtimePromptId,
        text: input.text
      }
    ]
  };
}

function isTextItem(item: unknown): item is { type: 'text'; text: string } {
  const content = readRecord(item);
  if (!content || content.type !== 'text') {
    return false;
  }

  return readString(content.text) !== null;
}

function isToolUseItem(item: unknown): item is {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  const content = readRecord(item);
  return (
    !!content &&
    content.type === 'tool_use' &&
    readString(content.id) !== null &&
    readString(content.name) !== null &&
    readRecord(content.input) !== null
  );
}

function isToolResultItem(item: unknown): item is {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
} {
  const content = readRecord(item);
  if (!content || content.type !== 'tool_result') {
    return false;
  }

  const toolUseId = readString(content.tool_use_id);
  return toolUseId !== null && typeof content.is_error === 'boolean';
}

function readToolResultOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => readString(readRecord(item)?.text) ?? '')
      .filter((item) => item.length > 0)
      .join('\n');
  }

  return '';
}

function emptyNormalization(): NormalizedClaudeEvent {
  return { internalEvents: [], runtimeEvents: [] };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
