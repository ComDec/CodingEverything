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

export type RunnerWorkdirView = Readonly<{
  id: string;
  path: string;
  displayName: string | null;
  source: 'scan';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  useCount: number;
}>;

export type RunnerWorkdirScanCandidate = Readonly<{
  path: string;
  displayName: string;
  score: number;
}>;

export type RunnerWorkdirListResponse = readonly RunnerWorkdirView[];

export type RunnerWorkdirScanRequest = Readonly<{
  offset?: number;
  limit?: number;
}>;

export type RunnerWorkdirScanResponse = Readonly<{
  items: readonly RunnerWorkdirScanCandidate[];
  nextOffset: number | null;
}>;

export type RunnerWorkdirSaveRequest = Readonly<{
  path: string;
  displayName?: string;
  createdBy: string;
}>;

export type ApproveRequest = Readonly<{
  sessionId: string;
  requestId: string;
}>; 
