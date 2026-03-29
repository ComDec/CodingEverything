import type { RuntimeEvent } from '../domain/events.js';
import { buildAuditEntry, type AuditEntry } from '../audit.js';
import type { SessionContext, SessionState } from '../domain/session.js';
import type { Database } from './database.js';

export type SessionRecord = Readonly<{
  id: string;
  state: SessionState;
  runtimeSessionId: string | null;
  context: SessionContext;
  createdAt: string;
  updatedAt: string;
}>;

export type BindingRecord = Readonly<{
  threadId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type PendingPrompt = Readonly<{
  id: string;
  sessionId: string;
  kind: 'permission' | 'question';
  status: 'pending';
  payload: Record<string, string>;
  expiresAt: string;
  createdAt: string;
}>;

export type DeliveryStateRecord = Readonly<{
  sessionId: string;
  cursor: string;
  rootMessageId: string | null;
  deliveredToolCallIds: readonly string[];
  updatedAt: string;
}>;

export type EventRecord = Readonly<{
  id: number;
  sessionId: string;
  event: RuntimeEvent;
  createdAt: string;
}>;

export type AuditRecord = Readonly<{
  id: number;
  action: string;
  actorType: 'user' | 'system' | 'service';
  actorId: string;
  source: string;
  sessionId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
}>;

export type WorkdirSource = 'scan';

export type WorkdirRecord = Readonly<{
  id: string;
  path: string;
  displayName: string | null;
  source: WorkdirSource;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  useCount: number;
}>;

export function createRepositories(database: Database) {
  return {
    sessions: {
      insert(record: SessionRecord): void {
        database
          .prepare(
            `
              INSERT INTO sessions (id, state, runtime_session_id, context_json, created_at, updated_at)
              VALUES (@id, @state, @runtimeSessionId, @contextJson, @createdAt, @updatedAt)
            `
          )
          .run({
            id: record.id,
            state: record.state,
            runtimeSessionId: record.runtimeSessionId,
            contextJson: JSON.stringify(record.context),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
          });
      },
      getById(id: string): SessionRecord | null {
        const row = database
          .prepare(
            `
              SELECT id, state, runtime_session_id, context_json, created_at, updated_at
              FROM sessions
              WHERE id = ?
            `
          )
          .get(id) as
          | {
              id: string;
              state: SessionState;
              runtime_session_id: string | null;
              context_json: string;
              created_at: string;
              updated_at: string;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          id: row.id,
          state: row.state,
          runtimeSessionId: row.runtime_session_id,
          context: parseJson<SessionContext>(row.context_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      },
      updateState(input: {
        id: string;
        state: SessionState;
        updatedAt: string;
      }): void {
        database
          .prepare(
            `
              UPDATE sessions
              SET state = @state, updated_at = @updatedAt
              WHERE id = @id
            `
          )
          .run(input);
      },
      updateRuntimeSessionId(input: {
        id: string;
        runtimeSessionId: string | null;
        updatedAt: string;
      }): void {
        database
          .prepare(
            `
              UPDATE sessions
              SET runtime_session_id = @runtimeSessionId, updated_at = @updatedAt
              WHERE id = @id
            `
          )
          .run(input);
      },
      listActive(): SessionRecord[] {
        const rows = database
          .prepare(
            `
              SELECT id, state, runtime_session_id, context_json, created_at, updated_at
              FROM sessions
              WHERE state != 'closed'
              ORDER BY created_at ASC
            `
          )
          .all() as Array<{
          id: string;
          state: SessionState;
          runtime_session_id: string | null;
          context_json: string;
          created_at: string;
          updated_at: string;
        }>;

        return rows.map((row) => ({
          id: row.id,
          state: row.state,
          runtimeSessionId: row.runtime_session_id,
          context: parseJson<SessionContext>(row.context_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      }
    },
    bindings: {
      upsert(record: BindingRecord): void {
        database
          .prepare(
            `
              INSERT INTO bindings (thread_id, session_id, created_at, updated_at)
              VALUES (@threadId, @sessionId, @createdAt, @updatedAt)
              ON CONFLICT(thread_id) DO UPDATE SET
                session_id = excluded.session_id,
                updated_at = excluded.updated_at
            `
          )
          .run(record);
      },
      getByThreadId(threadId: string): BindingRecord | null {
        const row = database
          .prepare(
            `
              SELECT thread_id, session_id, created_at, updated_at
              FROM bindings
              WHERE thread_id = ?
            `
          )
          .get(threadId) as
          | {
              thread_id: string;
              session_id: string;
              created_at: string;
              updated_at: string;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          threadId: row.thread_id,
          sessionId: row.session_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      },
      listAll(): BindingRecord[] {
        const rows = database
          .prepare(
            `
              SELECT thread_id, session_id, created_at, updated_at
              FROM bindings
              ORDER BY created_at ASC
            `
          )
          .all() as Array<{
          thread_id: string;
          session_id: string;
          created_at: string;
          updated_at: string;
        }>;

        return rows.map((row) => ({
          threadId: row.thread_id,
          sessionId: row.session_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      },
      deleteByThreadId(threadId: string): void {
        database
          .prepare(
            `
              DELETE FROM bindings
              WHERE thread_id = ?
            `
          )
          .run(threadId);
      }
    },
    prompts: {
      insertPendingPermission(input: {
        id: string;
        sessionId: string;
        requestId: string;
        runtimePromptId?: string;
        prompt: string;
        expiresAt: string;
        createdAt: string;
      }): void {
        insertPrompt(database, {
          id: input.id,
          sessionId: input.sessionId,
          kind: 'permission',
          payload: {
            requestId: input.requestId,
            runtimePromptId: input.runtimePromptId ?? input.requestId,
            prompt: input.prompt
          },
          expiresAt: input.expiresAt,
          createdAt: input.createdAt
        });
      },
      insertPendingQuestion(input: {
        id: string;
        sessionId: string;
        questionId: string;
        runtimePromptId?: string;
        text: string;
        expiresAt: string;
        createdAt: string;
      }): void {
        insertPrompt(database, {
          id: input.id,
          sessionId: input.sessionId,
          kind: 'question',
          payload: {
            questionId: input.questionId,
            runtimePromptId: input.runtimePromptId ?? input.questionId,
            text: input.text
          },
          expiresAt: input.expiresAt,
          createdAt: input.createdAt
        });
      },
      getPendingPrompt(sessionId: string): PendingPrompt | null {
        const row = database
          .prepare(
            `
              SELECT id, session_id, kind, payload_json, status, expires_at, created_at
              FROM prompts
              WHERE session_id = ? AND status = 'pending'
              ORDER BY created_at DESC
              LIMIT 1
            `
          )
          .get(sessionId) as
          | {
              id: string;
              session_id: string;
              kind: 'permission' | 'question';
              payload_json: string;
              status: 'pending';
              expires_at: string;
              created_at: string;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          id: row.id,
          sessionId: row.session_id,
          kind: row.kind,
          status: row.status,
          payload: parseJson<Record<string, string>>(row.payload_json),
          expiresAt: row.expires_at,
          createdAt: row.created_at
        };
      },
      getById(id: string): PendingPrompt | null {
        const row = database
          .prepare(
            `
              SELECT id, session_id, kind, payload_json, status, expires_at, created_at
              FROM prompts
              WHERE id = ? AND status = 'pending'
            `
          )
          .get(id) as
          | {
              id: string;
              session_id: string;
              kind: 'permission' | 'question';
              payload_json: string;
              status: 'pending';
              expires_at: string;
              created_at: string;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          id: row.id,
          sessionId: row.session_id,
          kind: row.kind,
          status: row.status,
          payload: parseJson<Record<string, string>>(row.payload_json),
          expiresAt: row.expires_at,
          createdAt: row.created_at
        };
      },
      resolve(input: { id: string; updatedAt: string }): void {
        database
          .prepare(
            `
              UPDATE prompts
              SET status = 'resolved', expires_at = expires_at
              WHERE id = @id AND status = 'pending'
            `
          )
          .run(input);
      },
      listPending(): PendingPrompt[] {
        const rows = database
          .prepare(
            `
              SELECT id, session_id, kind, payload_json, status, expires_at, created_at
              FROM prompts
              WHERE status = 'pending'
              ORDER BY created_at ASC
            `
          )
          .all() as Array<{
          id: string;
          session_id: string;
          kind: 'permission' | 'question';
          payload_json: string;
          status: 'pending';
          expires_at: string;
          created_at: string;
        }>;

        return rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          kind: row.kind,
          status: row.status,
          payload: parseJson<Record<string, string>>(row.payload_json),
          expiresAt: row.expires_at,
          createdAt: row.created_at
        }));
      }
    },
    deliveryState: {
      save(record: DeliveryStateRecord): void {
        database
          .prepare(
            `
              INSERT INTO delivery_state (
                session_id,
                cursor,
                root_message_id,
                delivered_tool_call_ids,
                updated_at
              )
              VALUES (@sessionId, @cursor, @rootMessageId, @deliveredToolCallIdsJson, @updatedAt)
              ON CONFLICT(session_id) DO UPDATE SET
                cursor = excluded.cursor,
                root_message_id = excluded.root_message_id,
                delivered_tool_call_ids = excluded.delivered_tool_call_ids,
                updated_at = excluded.updated_at
            `
          )
          .run({
            ...record,
            deliveredToolCallIdsJson: JSON.stringify(record.deliveredToolCallIds)
          });
      },
      getBySessionId(sessionId: string): DeliveryStateRecord | null {
        const row = database
          .prepare(
            `
              SELECT session_id, cursor, root_message_id, delivered_tool_call_ids, updated_at
              FROM delivery_state
              WHERE session_id = ?
            `
          )
          .get(sessionId) as
          | {
              session_id: string;
              cursor: string;
              root_message_id: string | null;
              delivered_tool_call_ids: string | null;
              updated_at: string;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          sessionId: row.session_id,
          cursor: row.cursor,
          rootMessageId: row.root_message_id,
          deliveredToolCallIds: parseJson<string[]>(row.delivered_tool_call_ids ?? '[]'),
          updatedAt: row.updated_at
        };
      },
      deleteBySessionId(sessionId: string): void {
        database
          .prepare(
            `
              DELETE FROM delivery_state
              WHERE session_id = ?
            `
          )
          .run(sessionId);
      },
      listSessionIds(): string[] {
        const rows = database
          .prepare(
            `
              SELECT session_id
              FROM delivery_state
              ORDER BY updated_at ASC
            `
          )
          .all() as Array<{ session_id: string }>;

        return rows.map((row) => row.session_id);
      }
    },
    events: {
      append(input: {
        sessionId: string;
        event: RuntimeEvent;
        createdAt: string;
      }): EventRecord {
        const result = database
          .prepare(
            `
              INSERT INTO events (session_id, event_json, created_at)
              VALUES (@sessionId, @eventJson, @createdAt)
            `
          )
          .run({
            sessionId: input.sessionId,
            eventJson: JSON.stringify(input.event),
            createdAt: input.createdAt
          });

        return {
          id: Number(result.lastInsertRowid),
          sessionId: input.sessionId,
          event: input.event,
          createdAt: input.createdAt
        };
      },
      listAfter(sessionId: string, afterId: number): EventRecord[] {
        const rows = database
          .prepare(
            `
              SELECT id, session_id, event_json, created_at
              FROM events
              WHERE session_id = ? AND id > ?
              ORDER BY id ASC
            `
          )
          .all(sessionId, afterId) as Array<{
          id: number;
          session_id: string;
          event_json: string;
          created_at: string;
        }>;

        return rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          event: parseJson<RuntimeEvent>(row.event_json),
          createdAt: row.created_at
        }));
      }
    },
    audit: {
      append(input: {
        action: string;
        actorType: 'user' | 'system' | 'service';
        actorId: string;
        source: string;
        sessionId: string | null;
        metadata: Record<string, string>;
        createdAt: string;
      }): AuditRecord {
        const auditEntry = buildAuditEntry(input);
        const result = database
          .prepare(
            `
              INSERT INTO audit_log (
                action,
                actor_type,
                actor_id,
                source,
                session_id,
                metadata_json,
                created_at
              )
              VALUES (
                @action,
                @actorType,
                @actorId,
                @source,
                @sessionId,
                @metadataJson,
                @createdAt
              )
            `
          )
          .run({
            action: auditEntry.action,
            actorType: auditEntry.actorType,
            actorId: auditEntry.actorId,
            source: auditEntry.source,
            sessionId: auditEntry.sessionId,
            metadataJson: JSON.stringify(auditEntry.metadata),
            createdAt: auditEntry.createdAt
          });

        return {
          id: Number(result.lastInsertRowid),
          ...auditEntry
        };
      }
    },
    workdirs: {
      upsert(record: WorkdirRecord): void {
        database
          .prepare(
            `
              INSERT INTO workdirs (
                id,
                path,
                display_name,
                source,
                created_by,
                created_at,
                updated_at,
                last_used_at,
                use_count
              )
              VALUES (
                @id,
                @path,
                @displayName,
                @source,
                @createdBy,
                @createdAt,
                @updatedAt,
                @lastUsedAt,
                @useCount
              )
              ON CONFLICT(path) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, workdirs.display_name),
                source = excluded.source,
                updated_at = excluded.updated_at,
                last_used_at = excluded.last_used_at,
                use_count = excluded.use_count
            `
          )
          .run(record);
      },
      markUsed(input: { id: string; lastUsedAt: string; updatedAt: string }): void {
        database
          .prepare(
            `
              UPDATE workdirs
              SET last_used_at = @lastUsedAt,
                  updated_at = @updatedAt,
                  use_count = use_count + 1
              WHERE id = @id
            `
          )
          .run(input);
      },
      getById(id: string): WorkdirRecord | null {
        const row = getWorkdirRowById(database, id);

        if (!row) {
          return null;
        }

        return mapWorkdirRow(row);
      },
      getByPath(path: string): WorkdirRecord | null {
        const row = getWorkdirRowByPath(database, path);

        if (!row) {
          return null;
        }

        return mapWorkdirRow(row);
      },
      listRecent(): WorkdirRecord[] {
        const rows = database
          .prepare(
            `
              SELECT
                id,
                path,
                display_name,
                source,
                created_by,
                created_at,
                updated_at,
                last_used_at,
                use_count
              FROM workdirs
              ORDER BY last_used_at DESC, display_name ASC
            `
          )
          .all() as WorkdirRow[];

        return rows.map(mapWorkdirRow);
      }
    }
  };
}

type WorkdirRow = {
  id: string;
  path: string;
  display_name: string | null;
  source: WorkdirSource;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  use_count: number;
};

function insertPrompt(
  database: Database,
  input: {
    id: string;
    sessionId: string;
    kind: 'permission' | 'question';
    payload: Record<string, string>;
    expiresAt: string;
    createdAt: string;
  }
): void {
  database
    .prepare(
      `
        INSERT INTO prompts (id, session_id, kind, payload_json, status, expires_at, created_at)
        VALUES (@id, @sessionId, @kind, @payloadJson, 'pending', @expiresAt, @createdAt)
      `
    )
    .run({
      id: input.id,
      sessionId: input.sessionId,
      kind: input.kind,
      payloadJson: JSON.stringify(input.payload),
      expiresAt: input.expiresAt,
      createdAt: input.createdAt
    });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function getWorkdirRowById(database: Database, id: string): WorkdirRow | undefined {
  return database
    .prepare(
      `
        SELECT id, path, display_name, source, created_by, created_at, updated_at, last_used_at, use_count
        FROM workdirs
        WHERE id = ?
      `
    )
    .get(id) as WorkdirRow | undefined;
}

function getWorkdirRowByPath(database: Database, path: string): WorkdirRow | undefined {
  return database
    .prepare(
      `
        SELECT id, path, display_name, source, created_by, created_at, updated_at, last_used_at, use_count
        FROM workdirs
        WHERE path = ?
      `
    )
    .get(path) as WorkdirRow | undefined;
}

function mapWorkdirRow(row: WorkdirRow): WorkdirRecord {
  return {
    id: row.id,
    path: row.path,
    displayName: row.display_name,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count
  };
}
