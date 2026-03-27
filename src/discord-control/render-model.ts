import type { RuntimeEvent } from '../shared/domain/events.js';

export type RunnerEventEnvelope = Readonly<{
  seq: number;
  event: RuntimeEvent;
}>;

export type RenderAnchorState = Readonly<{
  rootMessageId: string | null;
}>;

export type ActivePromptModel =
  | Readonly<{
      kind: 'permission';
      promptId: string;
      runtimePromptId: string;
      text: string;
    }>
  | Readonly<{
      kind: 'question';
      promptId: string;
      runtimePromptId: string;
      text: string;
    }>;

export type BashDetailModel = Readonly<{
  toolUseId: string;
  toolName: string;
  command?: string;
  description?: string;
  output: string;
  stdout: string;
  stderr: string;
  isError: boolean;
}>;

type ToolCallModel = Readonly<{
  toolUseId: string;
  toolName: string;
  command?: string;
  description?: string;
}>;

export type SessionRenderModel = Readonly<{
  sessionId: string;
  threadId: string | null;
  lastConsumedEventSeq: number;
  text: string;
  activePrompt: ActivePromptModel | null;
  toolCalls: Readonly<Record<string, ToolCallModel>>;
  bashDetails: readonly BashDetailModel[];
  anchor: RenderAnchorState;
}>;

export function createRenderModel(input: {
  sessionId: string;
  threadId?: string | null;
  rootMessageId?: string;
}): SessionRenderModel {
  return {
    sessionId: input.sessionId,
    threadId: input.threadId ?? null,
    lastConsumedEventSeq: 0,
    text: '',
    activePrompt: null,
    toolCalls: {},
    bashDetails: [],
    anchor: {
      rootMessageId: input.rootMessageId ?? null
    }
  };
}

export function startNewTurn(
  model: SessionRenderModel,
  threadId?: string | null
): SessionRenderModel {
  return {
    ...model,
    threadId: threadId ?? model.threadId,
    text: '',
    activePrompt: null,
    toolCalls: {},
    bashDetails: [],
    anchor: { rootMessageId: null }
  };
}

export function applyRunnerEvent(
  model: SessionRenderModel,
  envelope: RunnerEventEnvelope
): SessionRenderModel {
  if (envelope.seq <= model.lastConsumedEventSeq) {
    return model;
  }

  const next: SessionRenderModel = {
    ...model,
    lastConsumedEventSeq: envelope.seq
  };

  switch (envelope.event.type) {
    case 'text.delta':
      return {
        ...next,
        text: `${model.text}${envelope.event.delta}`
      };
    case 'permission.requested':
      return {
        ...next,
        activePrompt: {
          kind: 'permission',
          promptId: envelope.event.requestId,
          runtimePromptId: envelope.event.runtimePromptId ?? envelope.event.requestId,
          text: envelope.event.prompt
        }
      };
    case 'question.asked':
      return {
        ...next,
        activePrompt: {
          kind: 'question',
          promptId: envelope.event.questionId,
          runtimePromptId: envelope.event.runtimePromptId ?? envelope.event.questionId,
          text: envelope.event.text
        }
      };
    case 'tool.started':
      return {
        ...next,
        toolCalls: {
          ...model.toolCalls,
          [envelope.event.toolUseId]: {
            toolUseId: envelope.event.toolUseId,
            toolName: envelope.event.toolName,
            command: envelope.event.command,
            description: envelope.event.description
          }
        }
      };
    case 'tool.completed': {
      const toolCall = model.toolCalls[envelope.event.toolUseId];
      if ((toolCall?.toolName ?? envelope.event.toolName) !== 'Bash') {
        return next;
      }

      return {
        ...next,
        bashDetails: [
          ...model.bashDetails,
          {
            toolUseId: envelope.event.toolUseId,
            toolName: toolCall?.toolName ?? envelope.event.toolName,
            command: toolCall?.command ?? envelope.event.command,
            description: toolCall?.description ?? envelope.event.description,
            output: envelope.event.output,
            stdout: envelope.event.stdout,
            stderr: envelope.event.stderr,
            isError: envelope.event.isError
          }
        ]
      };
    }
    case 'permission.resolved':
    case 'question.answered':
      if (
        model.activePrompt &&
        (model.activePrompt.promptId === envelope.event.promptId ||
          model.activePrompt.runtimePromptId === envelope.event.promptId)
      ) {
        return {
          ...next,
          activePrompt: null
        };
      }

      return next;
    case 'turn.completed':
      return {
        ...next,
        activePrompt: null
      };
    default:
      return next;
  }
}

export function applyPendingPrompt(
  model: SessionRenderModel,
  prompt: ActivePromptModel | null
): SessionRenderModel {
  if (prompt === null) {
    return {
      ...model,
      activePrompt: null
    };
  }

  return {
    ...model,
    activePrompt: prompt
  };
}
