import type { RuntimeEvent } from '../../src/shared/domain/events.js';

export type FakeRuntime = Readonly<{
  nextEvent: () => Promise<RuntimeEvent | null>;
}>;

export function createFakeRuntime(script: readonly RuntimeEvent[]): FakeRuntime {
  const queue = [...script];

  return {
    async nextEvent() {
      return queue.shift() ?? null;
    }
  };
}
