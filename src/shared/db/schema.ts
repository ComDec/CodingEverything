export const CORE_SCHEMA = [
  `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      runtime_session_id TEXT,
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS bindings (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS delivery_state (
      session_id TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      root_message_id TEXT,
      delivered_tool_call_ids TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS workdirs (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      display_name TEXT,
      source TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      use_count INTEGER NOT NULL
    )
  `
] as const;
