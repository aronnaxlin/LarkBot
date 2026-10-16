# Integration status

2026-10-16 — Work on `integration/feishu-participation`; PR: https://github.com/aronnaxlin/LarkBot/pull/1.

A and B's changes have been combined in this worktree. A's follow-up integration was interrupted by the Claude session limit (reported reset: 22:30 Asia/Taipei); do not assume its integration/documentation tasks are complete. No model switch, real credentials, live Feishu connection, commit, or push was performed by the coordinating agent.

## Coordinator corrections

- Expired primary entry now throws into the scheduler's failed-context guard instead of returning with an open continuation (avoids a hot loop). Missing context for an open continuation also throws.
- Probe HTTP timeout now reserves the minimum primary-call time within the wake-up deadline.
- Each not-yet-started side effect checks the deadline; an already-running tool is never abandoned. Remaining calls get persisted skipped results, and `end_turn` stays available.
- New `primary.turnBudget.maxParticipationCalls` (default 3) bounds combined send/reaction attempts across the persisted interruption chain. Work-call budget remains separate. This is not a hard wall-clock limit on an in-flight tool.
- Feishu API errors retain numeric code/status only, not free-form server/network messages that might echo secrets.
- Unpublished durable ingress events are retried before later events for that chat. Failed synthetic-event publication is retained for retry without waking Driver.
- Added a typed local declaration for the inherited `markdown-it-math-loose` dependency, verified against its installed implementation.

## Verification so far

After the user installed system `rlottie 0.2-5` (libpng already present), the coordinator rebuilt `lottie-frame` successfully. Final joint validation: `pnpm typecheck`, `pnpm lint`, `pnpm test:run`, `pnpm build`, and `git diff --check` passed; **48 test files / 499 tests passed**. Existing pnpm configuration and Vue resolveComponent warnings remain, but rendered platform text/format assertions pass. No credentials or live services were used.

## Remaining before acceptance

- Native dependency blocker resolved by the user's system installation and the coordinator's successful rebuild; all offline checks now pass.
- Platform wording/format integration, stale fallback removal, README status, config examples, and AGENTS paths/startup/allowlist/budget/monitor instructions are reconciled. The original A/B implementation notes are explicitly marked as historical handoff snapshots.
- Probe timeout is capped in code; add a dedicated mocked probe timeout regression before claiming that specific path has direct coverage. Budget configuration has a regression test.
- Consider full-history interruption accounting across compaction and a chain-level deadline; current deadline remains per wake-up.
- Branch committed and pushed with user authorization; PR #1 is open, not merged. The integration worktree temporarily symlinks node_modules and generated types to A's worktree; these local links must never be staged or committed.

## Authorized live smoke test

The user authorized real Feishu testing after PR creation. A one-off script used local credentials in process memory only, without printing identifiers, tokens, names, or group message bodies. Verified: bot identity API, configured target chat access, WebSocket handshake, and one `post`/`md` test-message send. The 25-second receive window observed zero target-group events; ingress permissions, ordinary messages, @, replies, and the application persistence/Driver pipeline therefore remain unverified live. The connection was closed after testing. No LLM, Bash tool, automatic replies, production database, or full bot runtime was enabled.
- Document burst ingress ACK limitations: 1-second per-user lookups can queue past Feishu's 3-second deadline; no offline test proves remote delivery guarantees.
- Synthetic-event persistence failure after a successful remote send remains a durability limitation; it is logged rather than causing automatic duplicate sends.
- Original A/B implementation documents and research describe earlier snapshots. This file records coordinator amendments until those documents are reconciled.

Monitor: parent Loop #2, every 5 minutes, max 20 fires. Stop after final review or a user-action blocker. Do not automatically restart quota-blocked Claude agents.
