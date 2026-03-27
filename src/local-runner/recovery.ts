import type { PendingPrompt, SessionRecord } from '../shared/db/repositories.js';
import type { RuntimeEvent } from '../shared/domain/events.js';

export type RecoverRunnerStateInput = Readonly<{
  sessions: readonly SessionRecord[];
  prompts: readonly PendingPrompt[];
}>;

export type RecoverRunnerStateResult = Readonly<{
  syntheticEvents: RuntimeEvent[];
}>;

export async function recoverRunnerState(
  input: RecoverRunnerStateInput
): Promise<RecoverRunnerStateResult> {
  const recoverableStates = new Set(['awaiting_permission', 'awaiting_user_answer']);
  const sessionsById = new Map(
    input.sessions
      .filter((session) => recoverableStates.has(session.state))
      .map((session) => [session.id, session])
  );
  const syntheticEvents: RuntimeEvent[] = [];

  for (const prompt of input.prompts) {
    if (!sessionsById.has(prompt.sessionId)) {
      continue;
    }

    if (prompt.kind === 'permission') {
      syntheticEvents.push({
        type: 'permission.requested',
        requestId: prompt.payload.requestId ?? prompt.id,
        prompt: prompt.payload.prompt ?? 'Permission pending'
      });
      continue;
    }

    syntheticEvents.push({
      type: 'question.asked',
      questionId: prompt.payload.questionId ?? prompt.id,
      text: prompt.payload.text ?? 'Question pending'
    });
  }

  return { syntheticEvents };
}
