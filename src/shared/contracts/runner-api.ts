import type { SessionContext, SessionState } from '../domain/session.js';

export type CreateSessionRequest = Readonly<{
  channelId: string;
  context: SessionContext;
}>;

export type SessionSummary = Readonly<{
  sessionId: string;
  state: SessionState;
  context: SessionContext;
}>;

export type ApproveRequest = Readonly<{
  sessionId: string;
  requestId: string;
}>;
