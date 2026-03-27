import type { RuntimeEvent } from '../../shared/domain/events.js';
import type { SessionContext, SessionState } from '../../shared/domain/session.js';

export type RuntimeSessionHandle = Readonly<{
  sessionId: string;
  runtimeSessionId: string;
}>;

export type RuntimeTurnPromptResolution =
  | 'allow_once'
  | 'deny_once'
  | `answer:${string}`;

export type CreateRuntimeSessionInput = Readonly<{
  sessionId: string;
  context: SessionContext;
}>;

export type ResumeRuntimeSessionInput = Readonly<{
  sessionId: string;
  state: SessionState;
  context: SessionContext;
  runtimeSessionId: string;
}>;

export type RuntimeTurnInput = Readonly<{
  sessionId: string;
  prompt: string;
  onRuntimeSessionId?: (runtimeSessionId: string) => void;
}>;

export type ResolveRuntimePromptInput = Readonly<{
  sessionId: string;
  promptId: string;
  resolution: RuntimeTurnPromptResolution;
}>;

export type InterruptRuntimeTurnInput = Readonly<{
  sessionId: string;
}>;

export type CloseRuntimeSessionInput = Readonly<{
  sessionId: string;
}>;

export interface RuntimeAdapter {
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionHandle>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSessionHandle>;
  sendTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  resolvePrompt(input: ResolveRuntimePromptInput): Promise<void>;
  interrupt(input: InterruptRuntimeTurnInput): Promise<void>;
  closeSession(input: CloseRuntimeSessionInput): Promise<void>;
  subscribeEvents?(sessionId: string): AsyncIterable<RuntimeEvent>;
}
