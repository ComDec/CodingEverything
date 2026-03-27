import type { BindingRecord, SessionRecord } from '../shared/db/repositories.js';
import type { RunnerClient } from './runner-client.js';
import { createRenderModel, type SessionRenderModel } from './render-model.js';
import { createSessionRouter, type SessionRouter } from './session-router.js';

export type RecoveredSessionState = Readonly<{
  sessionId: string;
  threadId: string | null;
  runnerStatus: 'ready' | 'runner_unavailable' | 'closed';
  model: SessionRenderModel;
}>;

export type StartupRecoveryResult = Readonly<{
  router: SessionRouter;
  recoveredSessions: RecoveredSessionState[];
}>;

export async function recoverStartupState(input: {
  bindings: readonly BindingRecord[];
  sessions: readonly SessionRecord[];
  rootAnchors: Readonly<Record<string, string>>;
  runnerClient: RunnerClient;
}): Promise<StartupRecoveryResult> {
  const router = createSessionRouter({
    bindings: input.bindings,
    now: () => new Date(0).toISOString()
  });

  const runnerAvailable = await isRunnerAvailable(input.runnerClient);
  const recoveredSessions = input.sessions.flatMap((session) => {
    const threadId = router.getThreadIdBySession(session.id);
    if (!threadId) {
      return [];
    }

    return [
      {
        sessionId: session.id,
        threadId,
        runnerStatus: getRunnerStatus(session.state, runnerAvailable),
        model: createRenderModel({
          sessionId: session.id,
          threadId,
          rootMessageId: input.rootAnchors[session.id]
        })
      }
    ];
  });

  return {
    router,
    recoveredSessions
  };
}

async function isRunnerAvailable(runnerClient: RunnerClient): Promise<boolean> {
  try {
    const response = await runnerClient.health();
    return response.ok;
  } catch {
    return false;
  }
}

function getRunnerStatus(
  sessionState: SessionRecord['state'],
  runnerAvailable: boolean
): RecoveredSessionState['runnerStatus'] {
  if (sessionState === 'closed') {
    return 'closed';
  }

  return runnerAvailable ? 'ready' : 'runner_unavailable';
}
