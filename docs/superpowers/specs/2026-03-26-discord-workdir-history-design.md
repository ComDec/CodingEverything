# Discord Workdir History Design

## Goal

Replace the current required free-form `cwd` entry in `/session-new` with a Discord-first workdir picker for a single machine. Users should be able to choose a saved workdir from local history, scan the machine for candidate project directories, or manually enter a path, then review session options and create the session from a click-driven flow.

The first version should stay inside Discord, store machine-local workdir history in the existing SQLite database, and keep all path access constrained to `ALLOWED_ROOTS`.

## Confirmed Product Decisions

1. The primary UX lives in Discord rather than a browser page.
2. `/session-new` should start with `history`, `search new`, or manual path entry, rather than requiring a typed `cwd`.
3. New directory discovery should start with filesystem scanning inside configured roots.
4. Saved workdirs should be machine-local and stored in SQLite.
5. A saved workdir has a display name; default it to the folder name, but allow custom naming.

## Recommended Approach

Add a small machine-level workdir catalog to the shared SQLite database, expose it through new runner HTTP endpoints, and extend the Discord bot with a session-creation wizard built from buttons, select menus, and one rename modal.

This keeps the filesystem boundary out of the Discord process, reuses the current runner/control split, and avoids introducing a browser UI before the data model and interaction flow are proven.

## User Experience

### Entry Flow

- `/session-new` remains the entry point.
- The slash command should no longer require `cwd`.
- The command may still accept `model`, `effort`, and `skills` so advanced options can be provided up front.
- The bot replies with a compact wizard message containing at least:
  - `Use history`
  - `Search new`
  - `Manual input`

### Workdir Navigation

- `Use history` and `Search new` both provide a `Back` action so the user can return to the source picker without restarting `/session-new`.
- `Manual input` opens a modal where the user can paste a path directly.
- Once a workdir is chosen, the wizard moves to a second review step rather than creating the session immediately.

### Session Options Flow

- After the workdir step, the bot shows an options review message with:
  - `Model`
  - `Effort`
  - `Skills`
  - `Create session`
- Each option starts from a default value and can be left unchanged.
- `Model`, `Effort`, and `Skills` can be edited one at a time, then the user returns to the same review step.

### History Flow

- `Use history` opens a paginated list of saved workdirs.
- Each option shows the display name first and the path second.
- Selecting an item moves to the session options review step if the path is still valid and allowed.
- If the path no longer exists, the bot should return a short message saying the directory is unavailable and offer the user a way back to the picker.

### Search-New Flow

- `Search new` triggers a server-side scan under `ALLOWED_ROOTS`.
- The scan returns candidate project directories rather than every folder.
- The result list is paginated and click-selectable.
- Selecting a scanned directory opens a naming step.
- The default name is the directory basename.
- The user may accept the default or submit a custom name.
- Saving the entry returns to the session options review step and `Create session` performs the final session creation.

### Visibility and Reuse

- Saved workdirs are machine-level shared history, not per-user private history.
- The saved list should be ordered by `last_used_at DESC`, then `display_name ASC`.
- Each successful session creation from a saved, scanned, or manually entered entry updates `last_used_at` and increments `use_count` when the path is persisted.

## Data Model

Add a `workdirs` table in shared SQLite.

Suggested fields:

- `id TEXT PRIMARY KEY`
- `path TEXT NOT NULL UNIQUE`
- `display_name TEXT NOT NULL`
- `source TEXT NOT NULL` where the first version uses `scan`
- `created_by TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_used_at TEXT NOT NULL`
- `use_count INTEGER NOT NULL DEFAULT 0`

Design notes:

- Uniqueness should be path-based so the same machine directory is not duplicated.
- Re-saving an existing path should upsert instead of creating another row.
- If the existing row already has a custom display name, scanning the same path again must not overwrite that name unless the user submits a new one in the rename step.
- The path stored in the table must always be the normalized path that already passed the allowed-root check.

## Service Boundaries

### Shared DB Layer

- Extend `src/shared/db/schema.ts` with the new `workdirs` table.
- Extend `src/shared/db/repositories.ts` with repository methods for:
  - list recent workdirs
  - upsert a workdir
  - mark a workdir as used
  - get a workdir by id
  - get a workdir by path

### Runner Layer

Add workdir discovery APIs to the runner HTTP service so the Discord bot does not scan the filesystem directly.

Needed capabilities:

- list saved workdirs
- scan candidate workdirs
- save a selected workdir

The scan API should be explicitly paginated so Discord can page through the full candidate set instead of relying on one truncated response. A simple offset/page-size contract is enough for v1.

The runner should own filesystem scanning because it already owns trusted local execution context.

### Discord Layer

Extend the bot with a wizard-style interaction state for session creation.

The Discord control process should:

- launch the picker after `/session-new`
- request saved workdirs from the runner
- request scan results from the runner
- persist a selected scanned path with a display name
- call the existing session-creation handler once a final path is chosen

## Candidate Directory Scanning

The first version should use deterministic heuristics rather than LLM reasoning.

Candidate scoring rules:

- only scan inside `ALLOWED_ROOTS`
- prefer directories containing `.git`
- also allow common project markers such as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`
- skip obvious noise such as `node_modules`, `.git`, `dist`, `build`, `coverage`
- sort candidates by strongest marker and then by path

The scan should return a bounded result set so Discord pagination stays manageable.

The full candidate set should still be reachable through pagination. The service must not silently drop later matches just because the first page filled up.

## Session Creation Contract

Keep the existing session-creation path validation in `src/discord-control/command-handlers.ts`.

Even if a path came from saved history or scan results, the final create-session step must still:

1. validate the path is still inside `ALLOWED_ROOTS`
2. resolve the allowed root
3. create the session using the existing runner contract

Runner-side scan and save flows should validate existence and allowed-root membership before returning or persisting candidates. Discord-side create-session flow should still re-check allowed-root membership before session creation so stale or tampered interaction payloads cannot widen access.

## Discord Interaction Model

Use Discord components instead of turning this into a conversational text parser.

Needed primitives:

- button ids for the picker entry actions
- string select menus for paginated history and scan results
- buttons for pagination/back actions
- modals for custom display-name submission, manual path input, and skills editing

Interaction state should carry:

- initiating user id
- source channel/thread id
- chosen model/effort/skills
- current wizard step
- selected path or workdir id

The state can be encoded in component ids where small enough, with larger step data re-fetched from the runner when needed.

Only the initiating user should be allowed to interact with that wizard's buttons, selects, and modal submissions. Other users should get a short rejection message.

## Error Handling

- If no history exists, say so briefly and keep `Search new` available.
- If scan returns no candidates, say so briefly and let the user return.
- If a saved path is missing, do not create a session.
- If a saved or scanned path falls outside `ALLOWED_ROOTS`, treat it as unavailable.
- If saving a workdir races with another save of the same path, upsert cleanly and continue.
- If a component interaction becomes stale, reply with a concise refresh-safe message.
- If runner event streaming fails transiently, reconnect and continue delivering output and permission prompts.
- If a permission prompt has a long runtime prompt id, keep Discord button ids short and resolve against the stored prompt record.

## Testing Strategy

Add focused tests for:

- repository CRUD and ordering for workdir history
- scan heuristics and excluded directories
- runner HTTP endpoints for list, scan, and save
- Discord `/session-new` wizard entry flow
- history selection creating a session with the stored path
- scan selection plus rename creating a saved entry and then a session
- manual path entry followed by the options review step
- back navigation from history and scan pickers
- default basename naming and custom-name override behavior
- preserving an existing custom name when the same path is scanned again
- wizard interaction ownership by initiating user
- permission prompt delivery after transient event-stream failures
- short-button approval flow resolving the correct stored permission prompt
- stale and missing directory behaviors

## Out of Scope for First Version

- browser-based workdir management UI
- natural-language directory search backed by Claude
- per-user private workdir history
- deleting or editing saved workdirs outside the save/rename path
- background filesystem watchers or automatic refresh
