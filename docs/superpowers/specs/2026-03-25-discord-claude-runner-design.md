# Discord-Controlled Claude Runner Design

## Goal

Build a Discord-hosted control surface that lets a user chat with a bot to operate a persistent Claude Code session running on a single machine, receive near-real-time output, and approve or deny runtime permission requests inside Discord.

This V1 design intentionally optimizes for one machine and one runtime family first. The architecture keeps a clean boundary between the Discord control plane and the local runner so the system can later grow into a multi-machine broker and support additional runtimes such as OpenCode.

## Product Boundaries

### In Scope for V1

- Single-machine deployment
- Claude Code as the only supported runtime
- Persistent long-lived sessions
- Discord thread-based chat UX
- Streaming text and status output back into Discord
- In-chat permission approval and denial
- In-chat handling for AskUserQuestion-style follow-up prompts
- Session recovery after bot or runner restart
- Basic RBAC, audit logging, and working-directory restrictions

### Explicitly Out of Scope for V1

- Multi-machine scheduling or brokered routing
- Slurm integration
- Codex support
- OpenCode implementation
- Browser terminal UI
- Pixel-perfect terminal mirroring
- Full generic PTY abstraction for arbitrary CLIs

## Primary Requirements

1. Starting a Discord session must create or resume a persistent Claude Code session.
2. A session must survive transient disconnects and ordinary process restarts where feasible.
3. Output must stream back into Discord quickly enough to feel interactive.
4. Permission requests must block execution until the user approves or denies in Discord.
5. The system must keep Discord interaction concerns separate from Claude runtime concerns.
6. The design must preserve a clean path to future multi-machine routing.

## Design Principles

- Claude-first, not terminal-first
- Structured events over screen scraping
- Thread-per-session UX
- Single-writer session locking
- Safe defaults over convenience
- Persist enough state to recover, replay, and audit
- Define runtime interfaces now, implement only Claude in V1

## Research Summary and Design Implications

The most relevant upstream projects are:

- `zebbern/claude-code-discord`: strongest end-user reference for Discord UX, thread-per-session, permission buttons, and Claude-native interaction patterns
- `op7418/Claude-to-IM`: strongest bridge architecture reference for adapters, delivery throttling, permission brokering, and host/runtime separation
- `lyc11776611/tmuxcord`: useful reference for thread-to-session mapping and future PTY-based adapters
- `disclaude/app`: useful reference for tmux-backed persistence and restart reconnection patterns
- `anthropics/claude-agent-sdk-demos`: strongest reference for Claude session APIs, structured event streaming, and AskUserQuestion behavior

The core conclusion from research is that Claude should not be integrated through a pure `tmux` or PTY layer in V1. Claude Code exposes richer, more reliable structure through its SDK and session APIs than a terminal parser can provide. PTY techniques remain relevant for a future OpenCode adapter.

## Recommended Architecture

Adopt a hybrid architecture:

- System-level design uses a runtime adapter boundary that can support multiple runtimes later.
- V1 implementation provides only a `ClaudeSdkAdapter`.
- Discord control and local runner are separate modules, but both run on the same machine in V1.

This preserves a clean future path without paying the cost of a fully generic runtime platform too early.

## High-Level Topology

```text
Discord User
   |
   v
Discord API / Gateway
   |
   v
discord-control service
   |  command RPC
   |  event subscription
   v
local-runner service
   |
   v
Claude Code SDK / Session API
```

Shared persistence sits beside both modules and stores session bindings, runtime metadata, event checkpoints, permission requests, and audit records.

## Major Components

### 1. `discord-control`

Responsibilities:

- Register and handle slash commands
- Create and manage Discord threads
- Route thread messages to the correct internal session
- Render streaming output into Discord messages
- Present permission approval controls
- Present follow-up questions and choices
- Enforce Discord-side RBAC
- Record user-facing audit events

This service should not own Claude session logic. It should act as a control plane and presentation layer.

### 2. `local-runner`

Responsibilities:

- Create, resume, interrupt, and close Claude sessions
- Own the session state machine
- Serialize session turns with locking
- Subscribe to Claude SDK events and normalize them
- Pause for permission requests and resume after decisions
- Expose a local control API and event stream
- Persist enough state for restart recovery

This service should be usable without Discord. In V2 it becomes the direct ancestor of a remote runner agent.

### Ownership Rules

To avoid cross-process ambiguity in V1:

- `local-runner` is the source of truth for runtime state, session state transitions, pending permissions, pending questions, and event records
- `discord-control` is the source of truth for Discord message ids, thread metadata, rendered delivery checkpoints, and Discord interaction acknowledgements
- both services may write audit records, but each record must declare its actor and source module

This keeps SQLite workable even in a two-service V1. If contention becomes painful, the persistence boundary can later move behind a dedicated store layer without changing the product model.

### 3. Shared Store

V1 should use SQLite for simplicity.

Responsibilities:

- Session records
- Discord thread bindings
- Claude session identifiers and runtime metadata
- Pending approvals and answers
- Event log and delivery checkpoints
- Audit log
- Configuration snapshots where needed

### 4. `RuntimeAdapter` Interface

V1 defines the interface but implements only Claude.

Required capabilities:

- `createSession`
- `resumeSession`
- `sendTurn`
- `interrupt`
- `closeSession`
- `subscribeEvents`

Optional capabilities advertised by each runtime:

- `supportsStructuredPermissions`
- `supportsStructuredQuestions`
- `supportsResume`
- `supportsInterrupt`
- `supportsToolEvents`
- `supportsStreamingText`

Interactive control methods should be modeled generically:

- `resolvePrompt` for permission-like or question-like prompts
- prompt metadata carries a `prompt_kind` such as `permission`, `choice`, `free_text`, or `confirmation`

This allows a future `OpenCodePtyAdapter` without rewriting the Discord layer.

## Session Model

Each Discord thread maps to one internal session. Each internal session maps to one Claude runtime session.

### Session States

- `created`
- `idle`
- `running`
- `awaiting_permission`
- `awaiting_user_answer`
- `interrupting`
- `completed`
- `failed`
- `recovering`
- `closed`

### Concurrency Rule

Only one active turn may run per session at a time.

If a user sends another message while a turn is running, the system should either:

- reject with a polite status message, or
- queue one follow-up message if the implementation remains simple and deterministic

V1 should prefer the simpler rule: reject concurrent turns and ask the user to wait or interrupt.

## Discord UX

### Session Shape

- One slash command creates a session thread
- One thread equals one Claude session
- All ordinary messages inside the thread are interpreted as user turns

### Core Commands

Suggested V1 commands:

- `/session new <name> [cwd]`
- `/session status`
- `/session interrupt`
- `/session close`
- `/session output [lines]`
- `/session help`

The exact command names can be adjusted later, but the object model should remain thread-per-session.

### Output Rendering

Discord has message length and rate constraints, so output should use a layered strategy:

- One root status message per session that gets edited in place
- Separate chunk messages for long outputs that exceed safe edit size
- Debounced updates during active streaming
- Final summary when a turn completes

The root status message should display:

- session state
- current task or latest status
- latest text window
- pending approval state when applicable

### Permission Controls

When Claude requests permission, Discord should present buttons for:

- `Allow once`
- `Deny once`
- `Allow for session`

Buttons should be disabled after a decision and the message should show actor and timestamp.

`Allow for session` must have a narrow and explicit matching rule in V1. It should apply only when all of the following match:

- same session id
- same runtime tool name
- same prompt kind `permission`
- same normalized target scope if the tool request includes one, such as a file path or command target

V1 should not implement broad semantic approval like "all future shell commands". If a request cannot be normalized to a safe comparable scope, `Allow for session` should downgrade to `Allow once`.

### AskUserQuestion Handling

If Claude asks a question or offers structured options:

- show option buttons when the choice set is small and stable
- fall back to plain text reply when the answer is free-form

The Discord UX should preserve clarity rather than trying to emulate the terminal exactly.

## Runner Control API

V1 should use a local-only transport. Two practical options are a localhost HTTP server plus SSE/WebSocket stream, or a Unix domain socket transport. Either is acceptable; the design goal is a clear control boundary.

Recommended V1 split:

- request/response control over local HTTP
- server-to-client event streaming over SSE or WebSocket

### Control Operations

- `POST /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/turns`
- `POST /sessions/:id/interrupt`
- `POST /sessions/:id/close`
- `POST /permissions/:id/resolve`
- `POST /questions/:id/answer`
- `GET /sessions/:id/events`

These are internal endpoints, not public internet APIs.

## Immutable Session Context

Every created session must persist a context snapshot that is treated as immutable for recovery and audit purposes:

- normalized cwd
- allowed root that validated the cwd
- model and runtime options
- selected sandbox or approval mode
- environment allowlist or named environment profile
- creation-time runtime version when available
- creator identity

Recovery should never silently attach a persisted session id to a different cwd, model profile, or environment profile.

## Internal Event Model

The local runner should normalize Claude SDK output into an internal event stream. Suggested event types:

- `session.created`
- `session.resumed`
- `turn.started`
- `text.delta`
- `status.changed`
- `tool.started`
- `tool.finished`
- `permission.requested`
- `permission.resolved`
- `question.asked`
- `question.answered`
- `turn.completed`
- `turn.failed`
- `session.interrupted`
- `session.closed`

Each event should include:

- `event_id`
- `session_id`
- `runtime`
- `timestamp`
- `sequence`
- payload specific to the event type

This model is the key seam for future runtime expansion.

## Delivery State Model

Discord delivery must be replayable and deterministic, not just best-effort message editing.

For each session, `discord-control` should maintain a delivery state record containing at least:

- last consumed runner event sequence
- root status message id
- last rendered text buffer hash or checkpoint
- currently open output chunk message ids
- whether a permission or question card is currently active
- last successful Discord write timestamp

Rendering rules:

- process runner events in sequence order only
- treat rendering as a projection from event log plus delivery state
- make message edits idempotent where possible
- on restart, replay from `last_consumed_sequence + 1`
- if replay cannot reconstruct an exact incremental buffer, render a fresh state snapshot and mark earlier live output as historical

This prevents duplicate, reordered, or silently dropped output after rate limits, process restarts, or transient Discord failures.

## Claude Integration Strategy

Use the Claude SDK and session APIs directly, not a terminal parser.

Why:

- permission requests are structured
- AskUserQuestion is structured
- output streaming is structured
- session identifiers are recoverable
- runtime state is easier to persist and replay

The Claude adapter should be the only module that knows Claude-specific event details.

## Persistence Model

Suggested core tables:

### `sessions`

- `id`
- `runtime_type`
- `runtime_session_id`
- `state`
- `recovery_status`
- `cwd`
- `model`
- `created_at`
- `updated_at`
- `last_event_seq`
- `last_activity_at`

### `discord_bindings`

- `session_id`
- `guild_id`
- `channel_id`
- `thread_id`
- `root_message_id`
- `created_by_user_id`

### `delivery_state`

- `session_id`
- `last_consumed_event_seq`
- `root_status_message_id`
- `active_chunk_message_ids_json`
- `active_prompt_message_id`
- `render_checkpoint_json`
- `delivery_status`
- `last_successful_delivery_at`
- `last_delivery_error_at`

### `recovery_markers`

- `session_id`
- `turn_id`
- `marker_type`
- `details_json`
- `created_at`

### `pending_permissions`

- `id`
- `session_id`
- `request_payload`
- `status`
- `requested_at`
- `resolved_at`
- `resolved_by_user_id`
- `resolution`

### `pending_questions`

- `id`
- `session_id`
- `question_payload`
- `status`
- `asked_at`
- `answered_at`
- `answered_by_user_id`

### `events`

- `id`
- `session_id`
- `seq`
- `event_type`
- `payload_json`
- `created_at`

### `audit_log`

- `id`
- `actor_type`
- `actor_id`
- `session_id`
- `action`
- `payload_json`
- `created_at`

## Recovery and Restart Behavior

### Bot Restart

On restart, `discord-control` should:

- reload active session bindings from the store
- reconnect to runner event streams for active sessions
- restore message anchors when possible
- re-render pending approval state if necessary

### Runner Restart

On restart, `local-runner` should:

- reload active sessions from the store
- attempt to resume Claude sessions using persisted runtime session ids
- mark sessions `recovering` until reattached
- re-emit synthetic state events so the Discord layer can refresh UI

If a running turn cannot be cleanly re-subscribed after restart, the system must degrade explicitly instead of pretending streaming continuity:

- for `running`, mark the turn `recovery_uncertain`, notify Discord that live output continuity was lost, and allow the user to inspect the latest recoverable state or send a follow-up turn
- for `awaiting_permission`, prefer reconstructing the pending permission from persisted request state; if impossible, fail the blocked turn safely and notify the user that a restart invalidated the approval request
- for `awaiting_user_answer`, re-render the pending prompt from persisted prompt state; if impossible, fail the prompt and ask the user to restate the answer in-thread

The design goal is honest degraded recovery, not invisible magic.

### Pending Decisions

Pending permissions and questions must survive restart. The system should not lose a blocked approval just because one service restarted.

### Startup Ordering

V1 should tolerate either process starting first:

- if `discord-control` starts before `local-runner`, it should surface sessions as temporarily unavailable and retry subscriptions
- if `local-runner` starts before `discord-control`, it should continue persisting state and exposing recovery-ready events

Neither process should require a strict boot order for ordinary recovery.

## Error Handling

### Categories

- transient Discord API failures
- Claude SDK transport or session failures
- invalid user actions
- stale approval actions
- persistence write failures
- recovery failures

### Strategy

- Retry outbound Discord delivery with backoff
- Treat approval buttons as idempotent where possible
- Reject stale approvals after the underlying request is resolved or expired
- Surface failures in-thread with concise operational guidance
- Preserve an audit record even when user-visible delivery fails

If Discord is unavailable while Claude is blocked on a permission request, `local-runner` must keep the request persisted and unresolved. The blocked runtime should not auto-approve. The eventual outcomes are:

- Discord delivery recovers and the user resolves the request
- the request expires and is auto-denied according to policy
- an operator resolves it through a local administrative fallback in a later phase

## Security Model

V1 security should be practical but strict enough for real use.

### Access Control

- allowlist specific users and/or Discord roles
- restrict admin-level commands separately from ordinary chat turns
- require explicit authorization for session creation and interruption

### Working Directory Policy

- only allow session creation inside configured safe roots
- normalize and validate paths before session creation
- reject path traversal and symlink escapes where applicable

### Permission Policy

- never auto-approve by default
- default decision scope is `once`
- session-scoped approval must be explicit
- approvals expire if the request becomes stale

For `allow for session`, the persisted approval record must include its exact match predicate so the runner can evaluate later requests deterministically and audibly.

Authority model:

- `local-runner` persists the pending prompt before emitting `permission.requested`
- `discord-control` only presents the request after it has a durable prompt id
- resolution requests are idempotent and keyed by prompt id
- the runner is the only component allowed to transition a pending prompt to resolved

### Transport Security

- runner control API binds only to localhost or a Unix socket in V1
- no unauthenticated remote control interface in V1

### Audit Requirements

Must record:

- who created a session
- who sent a turn
- who approved or denied a permission
- what session and tool the decision affected
- when a session was interrupted or closed

## Observability

Minimum operational visibility:

- structured logs for both services
- per-session timeline of major state changes
- health check endpoint for both services
- counters for active sessions, pending approvals, failed deliveries, and recovery attempts

V1 can start with logs and counters without introducing a full telemetry stack.

## Deployment Shape

V1 deployment is one machine with two services.

Possible packaging options:

- one repository with two processes
- Docker Compose for easy local deployment
- systemd units for stable long-running production use on a personal machine or server

Recommended initial deployment target:

- one repository
- one `.env` or equivalent config source
- Docker Compose for convenience
- optional systemd docs for users who prefer native process management

## Multi-Machine Future Path

V2 can introduce a broker without invalidating the V1 design.

Future topology:

```text
Discord control plane
   |
   v
broker / scheduler
   |            |            |
   v            v            v
runner A     runner B     runner C
```

The V1 `local-runner` API should be designed so it can later become a remote runner protocol with minimal semantic changes.

Future broker capabilities:

- runner registration and heartbeats
- runner capability discovery
- scheduling by labels, environment, or queue depth
- per-runner credentials and health state
- optional Slurm submission adapter

## OpenCode Future Path

OpenCode should be the next runtime after Claude.

Implication for V1:

- keep the runtime adapter interface generic
- keep Discord rendering independent from Claude event names
- allow a future PTY-backed adapter for runtimes that do not expose Claude-style structured permission callbacks

V1 should not distort the Claude implementation to accommodate PTY behavior prematurely.

## Testing Strategy

### Unit Tests

- session state machine
- permission broker logic
- question handling logic
- event normalization
- Discord message chunking and throttling
- path validation and RBAC helpers

### Integration Tests

- fake Discord adapter + fake Claude adapter end-to-end flows
- session create -> turn -> permission request -> approve -> completion
- session create -> question -> answer -> completion
- stale button action handling

### Recovery Tests

- bot restart during active streaming
- runner restart during idle session
- runner restart while awaiting permission

### Manual E2E Tests

- real Discord guild
- real Claude session
- long output streaming
- permission approval from mobile
- interruption and recovery

## Implementation Phases

### Phase 1: Project Skeleton

- create repository structure for `discord-control`, `local-runner`, and shared types
- define internal API contracts and event schema
- create SQLite schema and persistence layer skeleton

### Phase 2: Discord Control Plane

- add slash commands
- add session thread creation
- add thread-to-session routing
- add root status message rendering

### Phase 3: Claude Runtime Adapter

- implement session creation and resume
- implement turn submission
- normalize Claude SDK stream events

### Phase 4: Permission and Question Loops

- implement pending permission blocking and decision callbacks
- implement AskUserQuestion presentation and response flow
- add stale request protection and timeouts

### Phase 5: Recovery and Delivery Hardening

- persist event checkpoints
- restore active sessions on restart
- rebind Discord threads and refresh UI state

### Phase 6: Security and Operations

- add RBAC
- add path restrictions
- add structured audit log
- add health checks and deployment scripts

### Phase 7: Runtime Abstraction Hardening

- clean up Claude-specific assumptions at the interface edge
- document what a future `OpenCodeAdapter` must implement

## Key Trade-Off Decisions

### Chosen: Structured Claude integration

Rejected alternative: pure `tmux`/PTY integration for Claude.

Reason: structured permissions and structured questions are too important to degrade into regex matching in V1.

### Chosen: Two local modules on one machine

Rejected alternative: one monolithic process.

Reason: a clean module boundary matters more than saving a little initial complexity.

### Chosen: Thread-per-session

Rejected alternative: one shared channel for many sessions.

Reason: session isolation and audit clarity are more important than minimizing channel count.

### Chosen: SQLite in V1

Rejected alternative: distributed store now.

Reason: V1 is single-machine and should minimize operational complexity.

## Success Criteria

The V1 system is successful if:

- a user can create a Discord session and talk to Claude naturally inside a thread
- Claude output appears quickly and reliably in Discord
- permission requests appear as explicit Discord actions and block until resolved
- sessions survive ordinary restarts with acceptable recovery behavior
- the internal design can later support remote runners and OpenCode without replacing the Discord layer

## Risks and Mitigations

### Risk: Discord rate limits make streaming feel bad

Mitigation: debounced message edits, chunking, and anchor-message design.

### Risk: Claude session recovery semantics differ from expectations

Mitigation: treat recovery as a first-class test area early in implementation.

### Risk: Session concurrency causes confusing behavior in shared threads

Mitigation: strict session locking and simple user-visible state messaging.

### Risk: Security mistakes expose local machine capabilities too broadly

Mitigation: default-deny authorization, safe working-directory roots, no remote runner API in V1, and mandatory audit records.

## Final Recommendation

Implement V1 as a single-machine, Discord-controlled Claude platform with two local modules:

- a Discord control plane for interaction and approvals
- a local Claude runner for session execution and recovery

Use structured Claude SDK integration rather than a terminal parser, keep a runtime adapter seam for future OpenCode support, and defer brokered multi-machine orchestration until the single-machine Claude path is reliable.
