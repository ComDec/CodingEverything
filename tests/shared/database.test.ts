import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/shared/db/database.js';
import { createRepositories } from '../../src/shared/db/repositories.js';
import { SessionState, createSessionContext } from '../../src/shared/domain/session.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempDatabasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'discord-claude-runner-db-'));
  tempDirs.push(dir);
  return join(dir, 'runner.db');
}

describe('database bootstrap', () => {
  it('creates the core tables needed for task 2', async () => {
    const databasePath = await createTempDatabasePath();

    const database = createDatabase({ filename: databasePath });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        'audit_log',
        'bindings',
        'delivery_state',
        'events',
        'prompts',
        'sessions'
      ])
    );

    database.close();
  });

  it('adds the delivery_state delivered_tool_call_ids column when opening an older database', async () => {
    const databasePath = await createTempDatabasePath();
    const initialDatabase = createDatabase({ filename: databasePath });

    initialDatabase.exec('DROP TABLE delivery_state');
    initialDatabase.exec(`
      CREATE TABLE delivery_state (
        session_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        root_message_id TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    initialDatabase
      .prepare(
        `
          INSERT INTO delivery_state (session_id, cursor, root_message_id, updated_at)
          VALUES (?, ?, ?, ?)
        `
      )
      .run('session-legacy', '7', 'discord-root-legacy', '2026-03-25T00:00:00.000Z');
    initialDatabase.close();

    const migratedDatabase = createDatabase({ filename: databasePath });
    const repositories = createRepositories(migratedDatabase);
    const columns = migratedDatabase
      .prepare('PRAGMA table_info(delivery_state)')
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain('delivered_tool_call_ids');
    expect(repositories.deliveryState.getBySessionId('session-legacy')).toEqual({
      sessionId: 'session-legacy',
      cursor: '7',
      rootMessageId: 'discord-root-legacy',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    migratedDatabase.close();
  });
});

describe('repositories', () => {
  it('stores and loads sessions and bindings', async () => {
    const databasePath = await createTempDatabasePath();
    const database = createDatabase({ filename: databasePath });
    const repositories = createRepositories(database);
    const context = createSessionContext({
      cwd: '/srv/app',
      allowedRoot: '/srv',
      model: 'sonnet',
      runtimeOptions: { permissionMode: 'default' },
      createdBy: 'user-1'
    });

    repositories.sessions.insert({
      id: 'session-1',
      state: SessionState.idle,
      runtimeSessionId: 'runtime-session-1',
      context,
      createdAt: '2026-03-25T00:00:00.000Z',
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
    repositories.bindings.upsert({
      threadId: 'thread-1',
      sessionId: 'session-1',
      createdAt: '2026-03-25T00:00:00.000Z',
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    expect(repositories.sessions.getById('session-1')).toEqual({
      id: 'session-1',
      state: SessionState.idle,
      runtimeSessionId: 'runtime-session-1',
      context,
      createdAt: '2026-03-25T00:00:00.000Z',
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
    expect(repositories.bindings.getByThreadId('thread-1')).toEqual({
      threadId: 'thread-1',
      sessionId: 'session-1',
      createdAt: '2026-03-25T00:00:00.000Z',
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    database.close();
  });

  it('stores pending prompts and returns the active prompt for a session', async () => {
    const databasePath = await createTempDatabasePath();
    const database = createDatabase({ filename: databasePath });
    const repositories = createRepositories(database);

    repositories.prompts.insertPendingPermission({
      id: 'prompt-1',
      sessionId: 'session-1',
      requestId: 'permission-1',
      prompt: 'Allow write?',
      expiresAt: '2026-03-25T00:05:00.000Z',
      createdAt: '2026-03-25T00:00:00.000Z'
    });
    repositories.prompts.insertPendingQuestion({
      id: 'prompt-2',
      sessionId: 'session-2',
      questionId: 'question-1',
      text: 'Continue?',
      expiresAt: '2026-03-25T00:06:00.000Z',
      createdAt: '2026-03-25T00:01:00.000Z'
    });

    expect(repositories.prompts.getPendingPrompt('session-1')).toEqual({
      id: 'prompt-1',
      sessionId: 'session-1',
      kind: 'permission',
      status: 'pending',
      payload: {
        requestId: 'permission-1',
        runtimePromptId: 'permission-1',
        prompt: 'Allow write?'
      },
      expiresAt: '2026-03-25T00:05:00.000Z',
      createdAt: '2026-03-25T00:00:00.000Z'
    });
    expect(repositories.prompts.getPendingPrompt('session-2')).toEqual({
      id: 'prompt-2',
      sessionId: 'session-2',
      kind: 'question',
      status: 'pending',
      payload: {
        questionId: 'question-1',
        runtimePromptId: 'question-1',
        text: 'Continue?'
      },
      expiresAt: '2026-03-25T00:06:00.000Z',
      createdAt: '2026-03-25T00:01:00.000Z'
    });

    database.close();
  });

  it('stores delivery state, events, and audit records', async () => {
    const databasePath = await createTempDatabasePath();
    const database = createDatabase({ filename: databasePath });
    const repositories = createRepositories(database);

    repositories.deliveryState.save({
      sessionId: 'session-1',
      cursor: '12',
      rootMessageId: 'discord-root-1',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    const firstEvent = repositories.events.append({
      sessionId: 'session-1',
      event: { type: 'permission.requested', requestId: 'perm-1', prompt: 'Allow write?' },
      createdAt: '2026-03-25T00:00:00.000Z'
    });
    const secondEvent = repositories.events.append({
      sessionId: 'session-1',
      event: { type: 'turn.completed', exitCode: 0 },
      createdAt: '2026-03-25T00:01:00.000Z'
    });
    const auditEntry = repositories.audit.append({
      action: 'session.created',
      actorType: 'user',
      actorId: 'user-1',
      source: 'discord-bot',
      sessionId: 'session-1',
      metadata: { command: 'run' },
      createdAt: '2026-03-25T00:00:00.000Z'
    });

    expect(repositories.deliveryState.getBySessionId('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '12',
      rootMessageId: 'discord-root-1',
      deliveredToolCallIds: [],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });
    expect(firstEvent.id).toBeGreaterThan(0);
    expect(repositories.events.listAfter('session-1', firstEvent.id)).toEqual([
      {
        id: secondEvent.id,
        sessionId: 'session-1',
        event: { type: 'turn.completed', exitCode: 0 },
        createdAt: '2026-03-25T00:01:00.000Z'
      }
    ]);
    expect(auditEntry.id).toBeGreaterThan(0);
    expect(auditEntry).toMatchObject({
      action: 'session.created',
      actorType: 'user',
      actorId: 'user-1',
      source: 'discord-bot',
      sessionId: 'session-1',
      metadata: { command: 'run' }
    });

    const auditRows = database
      .prepare(
        'SELECT action, actor_type, actor_id, source, session_id, metadata_json, created_at FROM audit_log'
      )
      .all() as Array<{
      action: string;
      actor_type: string;
      actor_id: string;
      source: string;
      session_id: string | null;
      metadata_json: string;
      created_at: string;
    }>;

    expect(auditRows).toEqual([
      {
        action: 'session.created',
        actor_type: 'user',
        actor_id: 'user-1',
        source: 'discord-bot',
        session_id: 'session-1',
        metadata_json: '{"command":"run"}',
        created_at: '2026-03-25T00:00:00.000Z'
      }
    ]);

    database.close();
  });

  it('stores delivered tool-call ids alongside the active anchor', async () => {
    const databasePath = await createTempDatabasePath();
    const database = createDatabase({ filename: databasePath });
    const repositories = createRepositories(database);

    repositories.deliveryState.save({
      sessionId: 'session-1',
      cursor: '12',
      rootMessageId: 'discord-root-1',
      deliveredToolCallIds: ['tool-bash-1', 'tool-read-1'],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    expect(repositories.deliveryState.getBySessionId('session-1')).toEqual({
      sessionId: 'session-1',
      cursor: '12',
      rootMessageId: 'discord-root-1',
      deliveredToolCallIds: ['tool-bash-1', 'tool-read-1'],
      updatedAt: '2026-03-25T00:00:00.000Z'
    });

    const rows = database
      .prepare('SELECT delivered_tool_call_ids FROM delivery_state WHERE session_id = ?')
      .all('session-1') as Array<{ delivered_tool_call_ids: string }>;

    expect(rows).toEqual([{ delivered_tool_call_ids: '["tool-bash-1","tool-read-1"]' }]);

    database.close();
  });
});
