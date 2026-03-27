export const EVENT_TYPES = [
  'text.delta',
  'tool.started',
  'tool.completed',
  'permission.requested',
  'question.asked',
  'turn.completed'
] as const;

export type TextDeltaEvent = Readonly<{
  type: 'text.delta';
  messageId: string;
  delta: string;
}>;

export type PermissionRequestedEvent = Readonly<{
  type: 'permission.requested';
  requestId: string;
  runtimePromptId?: string;
  prompt: string;
}>; 

export type ToolStartedEvent = Readonly<{
  type: 'tool.started';
  toolUseId: string;
  toolName: string;
  command?: string;
  description?: string;
}>;

export type ToolCompletedEvent = Readonly<{
  type: 'tool.completed';
  toolUseId: string;
  toolName: string;
  command?: string;
  description?: string;
  output: string;
  stdout: string;
  stderr: string;
  isError: boolean;
}>;

export type QuestionAskedEvent = Readonly<{
  type: 'question.asked';
  questionId: string;
  runtimePromptId?: string;
  text: string;
}>;

export type RunCompletedEvent = Readonly<{
  type: 'turn.completed';
  exitCode: number;
}>;

export type PermissionResolvedEvent = Readonly<{
  type: 'permission.resolved';
  promptId: string;
  resolution: string;
}>;

export type QuestionAnsweredEvent = Readonly<{
  type: 'question.answered';
  promptId: string;
  answer: string;
}>;

export type SessionCreatedEvent = Readonly<{
  type: 'session.created';
}>;

export type SessionInterruptedEvent = Readonly<{
  type: 'session.interrupted';
}>;

export type SessionClosedEvent = Readonly<{
  type: 'session.closed';
}>;

export type RecoveryUnattachedEvent = Readonly<{
  type: 'recovery.unattached';
  sessionId: string;
  reason: 'running_stream_unavailable';
}>;

export type RuntimeEvent =
  | TextDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | PermissionRequestedEvent
  | QuestionAskedEvent
  | RunCompletedEvent
  | PermissionResolvedEvent
  | QuestionAnsweredEvent
  | SessionCreatedEvent
  | SessionInterruptedEvent
  | SessionClosedEvent
  | RecoveryUnattachedEvent;
