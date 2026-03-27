import type { RunnerClient } from './runner-client.js';
import {
  applyPendingPrompt,
  applyRunnerEvent,
  type RunnerEventEnvelope,
  type SessionRenderModel
} from './render-model.js';

export type ReplaySessionEventsResult = Readonly<{
  model: SessionRenderModel;
  replayedCount: number;
}>;

export async function replaySessionEvents(input: {
  sessionId: string;
  model: SessionRenderModel;
  runnerClient: RunnerClient;
  reconstructActiveTurn?: boolean;
}): Promise<ReplaySessionEventsResult> {
  const shouldReconstructActiveTurn =
    input.reconstructActiveTurn === true &&
    input.model.anchor.rootMessageId !== null &&
    input.model.lastConsumedEventSeq === 0;
  const events = await input.runnerClient.listEvents({
    sessionId: input.sessionId,
    fromSeq: shouldReconstructActiveTurn ? 1 : input.model.lastConsumedEventSeq + 1
  });
  const replayEvents = shouldReconstructActiveTurn ? selectCurrentTurnEvents(events) : events;

  let model = input.model;

  for (const envelope of replayEvents) {
    model = applyRunnerEvent(model, envelope);
  }

  if (model.activePrompt === null) {
    model = applyPendingPrompt(model, await input.runnerClient.getPendingPrompt({ sessionId: input.sessionId }));
  }

  return {
    model,
    replayedCount: replayEvents.length
  };
}

function selectCurrentTurnEvents(events: readonly RunnerEventEnvelope[]) {
  let lastCompletedIndex = -1;

  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.event.type === 'turn.completed') {
      lastCompletedIndex = index;
    }
  }

  return lastCompletedIndex >= 0 ? events.slice(lastCompletedIndex + 1) : [...events];
}
