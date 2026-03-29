# Discord Claude Runner

## Validation order

1. Token-free validation first: `npm run smoke:tokenless`
2. Full suite: `npm test`
3. Typecheck: `npm run build`
4. Runner smoke with Claude auth: `CLAUDE_MODEL=sonnet npm run smoke:runner` or `ANTHROPIC_API_KEY=... CLAUDE_MODEL=sonnet npm run smoke:runner`
5. Start the local runner from source: `npm run runner`
6. Start Discord control from source after adding a token: `npm run discord`

## Runner service

- Local runner bootstrap: `npm run runner`
- This starts the HTTP runner without requiring Discord.
- Workdir endpoints:
  - `GET /workdirs` lists saved workdirs from the local SQLite catalog
  - `GET /workdirs/scan?offset=0&limit=25` scans allowed roots for unsaved directories
  - `POST /workdirs` saves a scanned workdir with an optional display name

## Environment

- Copy `.env.example` to `.env` and fill in your own values.
- Do not commit `.env`, tokens, Discord ids, or machine-specific paths.

- `DISCORD_TOKEN`: required only for real Discord startup
- `DISCORD_CLIENT_ID`: Discord application id for real startup
- `DISCORD_GUILD_ID`: optional guild-scoped slash-command registration target for faster manual validation
- `RUNNER_DATABASE_PATH`: SQLite path shared by runner and Discord control
- `RUNNER_ORIGIN`: runner base URL used by Discord control, defaults to `http://127.0.0.1:3000`
- `ALLOWED_ROOTS`: comma-separated allowed workspace roots
- `SESSION_MANAGER_USER_IDS`: comma-separated Discord user IDs allowed to create sessions and resolve prompts; set this or `SESSION_MANAGER_ROLE_IDS` or all Discord command actions stay denied
- `SESSION_MANAGER_ROLE_IDS`: comma-separated Discord role IDs allowed to create sessions and resolve prompts; set this or `SESSION_MANAGER_USER_IDS` or all Discord command actions stay denied
- `CLAUDE_MODEL`: Claude model name, defaults to `sonnet`
- `CLAUDE_CODE_EXECUTABLE`: path to the working Claude CLI executable used by the runner; defaults to `claude`
- `ANTHROPIC_API_KEY`: optional; if unset, smoke runs fall back to the local Claude CLI login/subscription state on the machine

## Docker

- `Dockerfile` installs dependencies and defaults to `npm test`
- `docker compose up runner discord-control` starts both services
- Compose mounts a shared `runner-data` volume so both services see the same SQLite file

## Notes

- `npm run smoke:tokenless` validates the runner/control flow from source without a Discord token, but it does not exercise live Discord transport.
- `npm run smoke:runner` supports either `ANTHROPIC_API_KEY` or an already-authenticated local Claude CLI session (for example a Claude Max login on the machine).
- For local-subscription mode, set `CLAUDE_CODE_EXECUTABLE` if `claude` is not on your default `PATH`.
- `npm run discord` starts a real `discord.js` client, registers the `session-new` slash command, and uses the shared SQLite audit/binding data plus the HTTP runner client.
- `/session-new` supports `name`, `cwd`, `model`, `effort`, and `skills`.
- `name` is optional; when omitted or normalized to empty, the bot generates a short kebab-case fallback such as `pretty-fire` and uses it for the session display name and any newly created thread title.
- `cwd` is optional. If omitted, Discord opens a picker with `Use history` for saved workdirs and `Search new` for fresh directory scans.
- The history picker revalidates the selected path before creating the session.
- The search flow paginates scan results, lets the user rename the saved entry or keep the default name, saves the workdir first, and then creates the session.
- `effort` accepts `low`, `medium`, `high`, or `max` and is passed through to Claude Code query options.
- `skills` accepts a comma-separated list of Claude skills to preload into the session context.
- Discord command actions are deny-by-default for RBAC; if both session-manager allowlists are empty, startup warns and session creation/prompt actions remain blocked.
- Any supplied or selected workdir must still resolve inside `ALLOWED_ROOTS`; the bot resolves the matching allowed root and ignores any user attempt to widen access.
- Runner and Discord control must point at the same `RUNNER_DATABASE_PATH` so restart recovery and thread bindings can be shared across processes.
