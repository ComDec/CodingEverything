export type HealthCounters = Readonly<{
  activeSessions: number;
  pendingPrompts: number;
  queuedEvents: number;
}>;

export type HealthComponents = Readonly<Record<string, 'ok' | 'degraded'>>;

export type HealthStatus = Readonly<{
  ok: true;
  service: string;
  checkedAt: string;
  counters: HealthCounters;
  components: HealthComponents;
}>;

export function buildHealthSnapshot(input: {
  service: string;
  checkedAt: string;
  counters: HealthCounters;
  components: HealthComponents;
}): HealthStatus {
  return Object.freeze({
    ok: true,
    service: input.service,
    checkedAt: input.checkedAt,
    counters: Object.freeze({ ...input.counters }),
    components: Object.freeze({ ...input.components })
  });
}
