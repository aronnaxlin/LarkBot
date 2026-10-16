# Driver Development Guide

> This guide describes the driver inherited from Cahciua plus LarkBot's participation and turn-budget changes. Follow [AGENTS.md](../AGENTS.md) for LarkBot's direction. Probe routing and scheduling policies below describe current behavior, not permanent requirements. See [integration-status.md](integration-status.md) for coordinator corrections and current validation; [driver-participation-implementation.md](driver-participation-implementation.md) records the original B implementation.

## Boundaries

Driver is deliberately explicit rather than plugin-driven. New behavior must fit one existing owner before a new abstraction is introduced.

```text
index.ts                   per-chat scope composition
scheduler.ts               reply eligibility and debounce timers
wakeup.ts                  probe -> budgeted primary loop
primary-tools.ts           ordered primary tool construction
runner.ts                  model-call retry and tool execution operations
turn-loop.ts               budget/persistence/follow-up/cooperative-interrupt loop
compaction-controller.ts   independent compaction effect
compaction.ts              summary LLM call
context.ts                 pure context composition and history optimization
tools/                     one module per tool or execution concern
```

Probe is not a generic tool-loop feature. Compaction is not a turn feature. Keep both as explicit phases/controllers.

## Adding A Tool

1. Implement the tool in `src/driver/tools/<name>.ts` with `createTool()`.
2. Export it from `src/driver/tools/index.ts`.
3. Add it to `createPrimaryTools()` in the required model-visible order.
4. Put capability-specific group policy in chat `systemFiles`; do not advertise a disabled tool in shared prompts.
5. Test schema, validation, result payload, and follow-up behavior.

Tool results return `requiresFollowUp`. `send_message` maps its `still_working` argument to that flag. A terminal tool must return `false`; tools whose result requires another model step return `true`. An `end_turn` call in a step closes the turn regardless of other results.

A new work tool counts against `TurnBudget.maxToolCalls` and disappears in the wrap-up step. Only `send_message`, `react`, and `end_turn` are participation tools (`PARTICIPATION_TOOL_NAMES` in `turn-loop.ts`); do not add to that set casually. Sends/reactions share `maxParticipationCalls` (default 3) and are skipped after the deadline; only `end_turn` is exempt. Long-running tools cannot be preempted by the deadline, so they need their own timeout or a background-task path.

There is no mandatory send and no silence tool: `end_turn` alone is silence, `react` then `end_turn` is a reaction-only turn.

`ban_spammer` is opt-in through `tools.banSpammer` (default false), enforced at tool exposure and backend authorization. Group decision policy lives in chat `systemFiles` and reaches both probe and primary. The callback is bound to the current chat; its inputs are an evidence message ID and a private reason. The Telegram service owns membership, permission, sender, and count checks. After a confirmed ban, the tool result supplies an exact announcement with a `tg://user?id=...` link labeled "spam 账号". Primary calls `send_message` with exactly one argument, `text`, containing that announcement. Names, usernames, profile text, spam content, media, and audit reasoning stay in the private assessment. Partial cleanup receives its own factual announcement.

Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context. The group file directs probe to activate primary for eligible cleanup and a short notice. Every tool result requires follow-up; the model reports the returned status accurately. Without the forced-send fallback, the announcement relies on primary sending it within the turn budget.

## Adding Wake-Up Behavior

Probe and primary logic lives in `executeWakeup()`. Current behavior to cover when modifying this flow:

- invalid probe output fails closed;
- probe persistence precedes primary activation;
- only interrupted-loop continuation bypasses probe;
- an interrupted continuation inherits the chain's round/call usage (`interruptedChainUsage`);
- completed primary steps persist before interruption checks;
- an activated primary may end silently; no fallback step runs;
- typing begins only after activation and stops in `finally`.

Preserve persistence ordering and cleanup guarantees. Add regression tests in `driver-characterization.test.ts`, `runner.test.ts`, or the relevant focused test file.

## Runner Changes

`callModelStep()` may retry ignored forced tool choices. Rejected attempts contribute token usage but must never execute tools. `executeToolStep()` handles only the chosen model entries.

`runTurnLoop()` owns ordering:

```text
budget check -> model (timeout <= remaining deadline) -> tools (over-budget work calls skipped)
  -> close decision -> persist -> terminal/follow-up decision -> interrupt -> append
```

The close decision (end_turn, wrap-up, or no time left) only clears persisted follow-up flags; it never discards an executed result. Do not add abort checks between model output, side effects, and persistence. That creates externally visible actions without a durable TR and causes duplicate actions on retry. For the same reason, do not bound tools with `Promise.race`: the losing side effect keeps running outside the record.

## Scheduler Changes

The scheduler is the only owner of debounce timers. It receives signals from the chat scope and calls a wake-up executor with an RC snapshot.

Current scheduling uses trigger-sender semantics and a debounce hard cap. These policies may change with tests. New messages do not reset active execution budgets: a continuation inherits the chain's counts and only a closed chain starts fresh. Use fake timers for scheduling tests. Scheduler cleanup currently cancels pending timers but does not preempt an already-running LLM/tool operation.

## Compaction Changes

Compaction observes RC independently from the reply scheduler. Trigger estimates exclude the existing summary. A successful compaction persists metadata before updating the signal/cursor.

Do not store summaries as TRs or delete historical rows.

## Testing Checklist

- Probe: valid send/no-action, missing/malformed decide, persistence order.
- Primary: still_working, terminal tools, end_turn close, silence and reaction-only endings, interrupted continuation, anonymous moderation announcements.
- Budget: round cap and wrap-up tool set, parallel call cap, deadline close, inherited chain usage, fresh budget after a closed chain.
- Moderation: per-chat opt-in, omitted schemas and shared prompt introductions, group policy injection into both probe/primary, sender/chat binding, 9/10-message boundary, protected members, permissions, deletion age, partial outcomes, repeated calls against current Telegram state, and tool-history audit identity.
- Runner: retry limits, usage aggregation, selected-output execution.
- Scheduler: sender-aware delay, typing extension, hard cap, cleanup.
- Compaction: threshold boundaries, cursor window, persistence/update order.
- Context: RC/TR ordering, reasoning compatibility, image and tool-result trimming.
