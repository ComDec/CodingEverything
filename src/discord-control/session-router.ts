import type { BindingRecord } from '../shared/db/repositories.js';

export type SessionRouter = Readonly<{
  bindThread(input: { threadId: string; sessionId: string }): BindingRecord;
  getSessionIdByThread(threadId: string): string | null;
  getThreadIdBySession(sessionId: string): string | null;
  listBindings(): BindingRecord[];
}>;

export function createSessionRouter(input: {
  bindings: readonly BindingRecord[];
  now: () => string;
}): SessionRouter {
  const threadToBinding = new Map<string, BindingRecord>();
  const sessionToThread = new Map<string, string>();

  for (const binding of input.bindings) {
    threadToBinding.set(binding.threadId, binding);
    sessionToThread.set(binding.sessionId, binding.threadId);
  }

  return {
    bindThread({ threadId, sessionId }) {
      const existingBinding = threadToBinding.get(threadId);
      if (existingBinding) {
        sessionToThread.delete(existingBinding.sessionId);
      }

      const existingThread = sessionToThread.get(sessionId);
      if (existingThread) {
        threadToBinding.delete(existingThread);
      }

      const now = input.now();
      const binding: BindingRecord = {
        threadId,
        sessionId,
        createdAt: existingBinding?.createdAt ?? now,
        updatedAt: now
      };

      threadToBinding.set(threadId, binding);
      sessionToThread.set(sessionId, threadId);

      return binding;
    },
    getSessionIdByThread(threadId) {
      return threadToBinding.get(threadId)?.sessionId ?? null;
    },
    getThreadIdBySession(sessionId) {
      return sessionToThread.get(sessionId) ?? null;
    },
    listBindings() {
      return Array.from(threadToBinding.values()).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      );
    }
  };
}
