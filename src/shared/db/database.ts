import BetterSqlite3 from 'better-sqlite3';
import { CORE_SCHEMA } from './schema.js';

export type Database = BetterSqlite3.Database;

export function createDatabase(options: { filename: string }): Database {
  const database = new BetterSqlite3(options.filename);

  for (const statement of CORE_SCHEMA) {
    database.exec(statement);
  }

  ensureSessionsRuntimeSessionIdColumn(database);
  ensureDeliveryStateRootMessageIdColumn(database);
  ensureDeliveryStateDeliveredToolCallIdsColumn(database);

  return database;
}

function ensureSessionsRuntimeSessionIdColumn(database: Database): void {
  const columns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === 'runtime_session_id')) {
    return;
  }

  database.exec('ALTER TABLE sessions ADD COLUMN runtime_session_id TEXT');
}

function ensureDeliveryStateRootMessageIdColumn(database: Database): void {
  const columns = database.prepare('PRAGMA table_info(delivery_state)').all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === 'root_message_id')) {
    return;
  }

  database.exec('ALTER TABLE delivery_state ADD COLUMN root_message_id TEXT');
}

function ensureDeliveryStateDeliveredToolCallIdsColumn(database: Database): void {
  const columns = database.prepare('PRAGMA table_info(delivery_state)').all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === 'delivered_tool_call_ids')) {
    return;
  }

  database.exec("ALTER TABLE delivery_state ADD COLUMN delivered_tool_call_ids TEXT NOT NULL DEFAULT '[]'");
}
