export type AuditEntry = Readonly<{
  action: string;
  actorType: 'user' | 'system' | 'service';
  actorId: string;
  source: string;
  sessionId: string | null;
  metadata: Readonly<Record<string, string>>;
  createdAt: string;
}>;

export function buildAuditEntry(input: {
  action: string;
  actorType: 'user' | 'system' | 'service';
  actorId: string;
  source: string;
  sessionId?: string | null;
  metadata: Record<string, string>;
  createdAt: string;
}): AuditEntry {
  return Object.freeze({
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    source: input.source,
    sessionId: input.sessionId ?? null,
    metadata: Object.freeze({ ...input.metadata }),
    createdAt: input.createdAt
  });
}
