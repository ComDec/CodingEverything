# Regression Tests And CI Design

## Goal

Harden the repository against the failures discovered during the session-display-name rollout by turning those failures into automated regression tests and by adding a minimal CI workflow that runs the repository's existing quality gates on every push and pull request.

## Confirmed Product Decisions

1. Prioritize tests that directly reproduce the failures seen today.
2. Add the smallest useful CI workflow instead of a large CI/CD pipeline.
3. CI should run `npm test`, `npm run build`, and `npm run smoke:tokenless`.
4. Do not include `npm run smoke:runner` in CI because it depends on local Claude auth and is not stable for hosted automation.
5. Treat this as a separate hardening change from the session-naming feature itself.

## Problems To Prevent

### Broken Session Continuity After `/session-new`

During the session-naming rollout, the bot created a session successfully but failed to persist the `threadId -> sessionId` binding immediately afterward. The visible symptom was a healthy session summary embed followed by thread messages being silently ignored.

This must stay covered by an explicit regression test so later refactors to `session-new` cannot break message routing again.

### False Confidence From Unit Tests Alone

The repository's normal test suite passed while a real Discord flow still failed in practice. The missing coverage was not basic TypeScript correctness; it was the interaction between session creation, thread binding persistence, and the first user turn.

The hardening work should therefore focus on regression tests that protect those orchestration boundaries, then ensure CI always runs them.

### Orphan Thread Risk

One intermediate version could create a new thread before rejecting an invalid or unauthorized session request. That produces stray Discord threads and hides the real failure mode behind extra cleanup work.

The regression suite should preserve the invariant that invalid or unauthorized session creation does not create a thread.

### Waiting Placeholder Without Useful Progress

In another failure mode, the user saw only a waiting placeholder while the backing runner/runtime path did not produce useful events. Not every runtime outage can be fully reproduced inside unit tests, but the bot-side rendering and routing flow should still be covered so future regressions in event application do not reintroduce the same visible symptom for bot-local reasons.

## Recommended Approach

Add focused regression tests in the existing Discord bot test suite and integration smoke coverage, then add a single GitHub Actions workflow that runs the existing repository validation commands.

This approach is the best fit because it strengthens the exact layers that failed without introducing heavy infrastructure. It also follows current repository conventions: Vitest for behavior coverage, `npm run build` as the static gate, and `npm run smoke:tokenless` as the highest-value integration check that remains self-contained.

## Test Design

### Regression 1: Session Creation Must Persist Binding

Keep a bot-level regression test that proves a newly created session is immediately routable from later thread messages.

Expected structure:

1. simulate `/session-new`
2. verify the bot stores a binding for the created thread
3. emit a thread message from the same channel
4. assert that `runnerClient.sendTurn(...)` receives the prompt for the newly created session

This test is the closest automated reproduction of today's most important product break.

### Regression 2: New `name` Support Must Not Break Continuity

Add or strengthen a test that combines the new `name` field with the old continuity requirement.

Expected structure:

1. create a session through `/session-new name:...`
2. verify the resolved display name is used for the summary and thread title
3. emit the first user thread message
4. assert that the prompt is still routed to the created session

This prevents future regressions where metadata additions accidentally break core routing behavior.

### Regression 3: Invalid Or Unauthorized Requests Must Not Create Threads

Preserve explicit tests proving that rejected `/session-new` requests do not create new threads.

At minimum, the regression suite should cover:

- invalid `cwd`
- unauthorized user or role

The assertion should be structural, not implied: the fake thread manager should show zero created threads.

### Regression 4: Waiting Placeholder Gets Replaced By Real Turn Output

Add a test that simulates a successful streamed turn end-to-end inside the Discord bot test harness.

Expected structure:

1. create or reuse a session/thread
2. emit a user message that starts a turn
3. verify a waiting placeholder is rendered
4. emit `text.delta` and `turn.completed` events from the fake runner stream
5. verify the rendered assistant text replaces or supersedes the placeholder

This does not attempt to prove the external Claude runtime is always healthy. It proves the bot correctly consumes a healthy event stream and does not locally strand the UI on the placeholder.

### Integration Guardrail: Keep Tokenless Smoke In CI

Retain `npm run smoke:tokenless` as the integration-level CI step because it exercises a meaningful slice of the create-session and prompt-resolution workflow without depending on Discord transport or Claude authentication.

If the new regression tests overlap with the tokenless harness, prefer overlap over clever deduplication. The goal is confidence, not minimal test count.

## CI Design

### Workflow Scope

Add a single workflow at `.github/workflows/ci.yml`.

Triggers:

- `push`
- `pull_request`

No release automation, deploy automation, secrets, or environment promotion logic should be introduced in this change.

### Workflow Steps

The workflow should:

1. check out the repository
2. set up a supported Node version
3. install dependencies with the repository's normal package manager flow
4. run `npm test`
5. run `npm run build`
6. run `npm run smoke:tokenless`

The workflow should fail fast on command failure. A matrix build is not required yet.

## File-Level Changes

### `tests/discord-control/bot.test.ts`

- strengthen session creation continuity regression coverage
- strengthen invalid-request/no-thread regression coverage
- add a successful streamed-turn rendering regression around the waiting placeholder if current tests do not already fully cover it

### `tests/integration/tokenless-flow.test.ts`

- update only if needed to reflect the stronger regression focus or new expectations around session continuity

### `.github/workflows/ci.yml`

- add a minimal CI workflow that runs the repository's validation commands on pushes and pull requests

### Optional docs touchpoints

If needed, add a short note in `README.md` or `AGENTS.md` that the repository now expects CI to stay green on the three canonical commands. Keep documentation changes brief.

## Error Handling And Risk Control

- Do not add flaky CI steps that require Discord credentials or Claude auth.
- Do not add long-running jobs that duplicate existing coverage without new value.
- Prefer deterministic fake-runner test inputs over sleeps or timing-sensitive assertions.
- Keep regression tests narrow so failures clearly explain which invariant broke.

## Out Of Scope

- deployment automation
- release automation
- preview environments
- multi-OS or multi-Node build matrices
- secrets management in CI
- hosted end-to-end Discord tests with real tokens

## Verification Strategy

Before considering the hardening work complete, verify with:

1. targeted Vitest commands for new regression tests
2. `npm test`
3. `npm run build`
4. `npm run smoke:tokenless`

The CI workflow should run the same commands so local and hosted verification stay aligned.
