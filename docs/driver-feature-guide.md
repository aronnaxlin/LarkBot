# Driver Development Guide

> This guide describes the inherited Cahciua driver. Follow [AGENTS.md](../AGENTS.md) for LarkBot's direction. Mandatory speech, probe routing, and scheduling policies below describe current behavior, not permanent requirements; change them with regression coverage when implementing the agreed LarkBot behavior.

## Boundaries

Driver is deliberately explicit rather than plugin-driven. New behavior must fit one existing owner before a new abstraction is introduced.

```text
index.ts                   per-chat scope composition
scheduler.ts               reply eligibility and debounce timers
wakeup.ts                  probe -> primary -> forced-send fallback
primary-tools.ts           ordered primary tool construction
runner.ts                  model-call retry and tool execution operations
turn-loop.ts               persistence/follow-up/cooperative-interrupt loop
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

Tool results return `requiresFollowUp`. `send_message` maps its `still_working` argument to that flag. A terminal tool must return `false`; tools whose result requires another model step return `true`.

The current driver requires a message after activation and has no silence tool. LarkBot must allow legitimate silence and reaction-only completion; when implementing this, choose the smallest explicit termination mechanism and update runtime prompts, forced-send fallback, and tests together.

`ban_spammer` is opt-in through `tools.banSpammer` (default false), enforced at tool exposure and backend authorization. Group decision policy lives in chat `systemFiles` and reaches both probe and primary. The callback is bound to the current chat; its inputs are an evidence message ID and a private reason. The Telegram service owns membership, permission, sender, and count checks. After a confirmed ban, the tool result supplies an exact announcement with a `tg://user?id=...` link labeled "spam 账号". Primary calls `send_message` with exactly one argument, `text`, containing that announcement. Names, usernames, profile text, spam content, media, and audit reasoning stay in the private assessment. Partial cleanup receives its own factual announcement.

Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context. The group file directs probe to activate primary for eligible cleanup and a short notice. Every tool result requires follow-up; the model reports the returned status accurately, preserving the existing probe and mandatory-send rules.

## Adding Wake-Up Behavior

Probe and primary logic lives in `executeWakeup()`. Current behavior to cover when modifying this flow:

- invalid probe output fails closed;
- probe persistence precedes primary activation;
- only interrupted-loop continuation bypasses probe;
- completed primary steps persist before interruption checks;
- fallback searches the current interruption chain for an earlier send;
- typing begins only after activation and stops in `finally`.

Preserve persistence ordering and cleanup guarantees. Probe bypass and forced-send rules may change for LarkBot; update affected expectations and add regression tests in `driver-characterization.test.ts` or the relevant focused test file.

## Runner Changes

`callModelStep()` may retry ignored forced tool choices. Rejected attempts contribute token usage but must never execute tools. `executeToolStep()` handles only the chosen model entries.

`runTurnLoop()` owns ordering:

```text
model -> tools -> persist -> terminal/follow-up decision -> interrupt -> append
```

Do not add abort checks between model output, side effects, and persistence. That creates externally visible actions without a durable TR and causes duplicate actions on retry.

## Scheduler Changes

The scheduler is the only owner of debounce timers. It receives signals from the chat scope and calls a wake-up executor with an RC snapshot.

Current scheduling uses trigger-sender semantics and a debounce hard cap. These policies may change with tests; new messages must not indefinitely reset active execution budgets. Use fake timers for scheduling tests. Scheduler cleanup currently cancels pending timers but does not preempt an already-running LLM/tool operation.

## Compaction Changes

Compaction observes RC independently from the reply scheduler. Trigger estimates exclude the existing summary. A successful compaction persists metadata before updating the signal/cursor.

Do not store summaries as TRs or delete historical rows.

## Testing Checklist

- Probe: valid send/no-action, missing/malformed decide, persistence order.
- Primary: still_working, terminal tools, interrupted continuation, fallback, anonymous moderation announcements.
- Moderation: per-chat opt-in, omitted schemas and shared prompt introductions, group policy injection into both probe/primary, sender/chat binding, 9/10-message boundary, protected members, permissions, deletion age, partial outcomes, repeated calls against current Telegram state, and tool-history audit identity.
- Runner: retry limits, usage aggregation, selected-output execution.
- Scheduler: sender-aware delay, typing extension, hard cap, cleanup.
- Compaction: threshold boundaries, cursor window, persistence/update order.
- Context: RC/TR ordering, reasoning compatibility, image and tool-result trimming.
