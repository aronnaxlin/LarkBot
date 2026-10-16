# Driver Participation And Turn Budget

> Historical agent handoff snapshot. Coordinator changes supersede the integration TODOs and budget/error guarantees below; see [integration-status.md](integration-status.md) for current behavior and verification.

Date: 2026-10-16. Branch: `feat/driver-participation`.

This records what was implemented for legitimate silence, reaction-only endings, and a bounded primary tool loop, what each limit actually guarantees, and what remains open. See [AGENTS.md](../AGENTS.md) for the invariants and [driver-feature-guide.md](driver-feature-guide.md) for extension rules.

## Behavior

### Participation

- The forced `send_message` fallback is removed (`src/driver/wakeup.ts`). An activated primary that calls `end_turn` without sending anything ends silently; no extra model step runs.
- `react` followed by `end_turn` (in two steps, or in the same step) is a complete reaction-only turn.
- `end_turn` is an explicit close: when it appears in a step, the loop stops even if other results in that step requested follow-up. The other calls in that step still execute and are persisted.
- No silence tool was added. Primary still uses `forceToolChoice: 'any'`, so every step calls a tool; `end_turn` is the silence route. Rejected attempts are retried as before.
- Probe is unchanged: same entry point, same `decide(should_act, reason)` schema and enum values, fail-closed on missing/malformed output, persisted before primary activation. Interrupted continuations still bypass probe. A mention still runs probe and is described to both probe and primary as a strong signal, not an order. Jev is not integrated.

### Turn budget

`TurnBudget` (`src/driver/types.ts`), defaults in `DEFAULT_TURN_BUDGET` (`src/driver/turn-loop.ts`):

| Field | Default | Meaning |
| --- | --- | --- |
| `maxToolRounds` | 2 | Regular model steps (all tools visible) before the wrap-up |
| `maxToolCalls` | 4 | Work-tool calls; `send_message`, `react`, `end_turn` are exempt |
| `deadlineMs` | 15 000 | Per wake-up execution, measured from `executeWakeup` entry, probe included |
| `minModelCallMs` | 2 000 | A model call starts only if at least this much of the deadline remains |

The first three are the starting values from the project discussion; `minModelCallMs` was added so a model call is never started with a few milliseconds of timeout. All four are suggestions to tune against real model latency.

Loop rules (`runTurnLoop`):

1. Before each step, if rounds or work calls are exhausted, the step is a **wrap-up**: only `send_message`, `react`, and `end_turn` are sent to the model. The wrap-up is not a forced send; `end_turn` alone is silence. Any work call the model still emits gets a not-executed error result.
2. In a parallel step, work calls execute in order until `maxToolCalls` is reached; the rest get `{"error": "Tool budget for this turn is exhausted; this call was not executed."}`. Participation calls always execute.
3. Each model call's HTTP timeout is `min(endpoint timeoutSec, remaining deadline)`, recomputed for each forced-choice retry. This is a real abort, which is safe because model calls have no side effects. A model call that times out throws like any other model error.
4. After tools run, the step closes the turn if it called `end_turn`, was the wrap-up, or left less than `minModelCallMs` of deadline. A closing step is persisted with its `requiresFollowUp` flags cleared. The tool payloads are persisted unchanged, so the record still shows every side effect that happened.
5. Order is unchanged: model, then tools, then persist, then the follow-up decision, then `checkInterrupt`. There is no abort between a side effect and its persistence.

### Continuations and new messages

- Rounds and work calls accumulate across an interruption chain. `interruptedChainUsage` (`wakeup.ts`) derives them from persisted TRs: the latest TR plus each earlier TR whose follow-up continued into it. New messages, repeated interrupts, and restarts therefore cannot reset the counts.
- The deadline is per execution. A continuation gets a new deadline but inherits the counts. Each continuation consumes at least one round or is the wrap-up, so a chain spans at most `maxToolRounds + 1` model steps.
- An interrupt is checked before the wrap-up. When the counts are exhausted and new messages arrive, the wrap-up runs in the continuation with fresh context.
- Once a chain closes (end_turn, wrap-up, deadline, or a terminal send), the next input runs probe and gets a fresh budget. A later unrelated topic is not charged to the old budget.
- Background-task completion events arrive as runtime events and start a new probe-gated wake-up with a fresh budget. Reporting the result is optional.

## What the limits guarantee

| Limit | Enforcement |
| --- | --- |
| Tool rounds per chain | Hard: checked before every model step |
| Work-tool calls per chain | Hard: over-budget calls are not executed |
| Model call wait | Hard: HTTP abort at the remaining deadline (or the endpoint `timeoutSec` if lower) |
| Turn deadline | **Not a hard timeout.** Checked between steps and applied to model calls. A running tool is never preempted, so a turn can exceed the deadline by the remaining duration of one tool step |
| Single tool wait | Not changed by this work. Existing per-tool caps apply (below) |

Existing per-tool caps, all outside this branch's file ownership:

| Tool | Cap | Notes |
| --- | --- | --- |
| `bash` (foreground) | 30 s, process killed (`BASH_TIMEOUT_MS`) | `timeout_seconds` above `backgroundThresholdSec` starts a background task and returns immediately |
| `sleep` | up to 300 s | Far beyond the 15 s deadline; the turn then closes silently after it |
| `download_file` | 60 s | `execFile` timeout |
| `web_fetch` (Jina) | 30 s | `AbortSignal.timeout` |
| `web_search` | 15 s | Tavily/Exa/Jina/MS grounding |
| `read_image` | image-to-text model `timeoutSec` | Unset means unbounded |
| `send_message` | none | Waits for the platform's terminal send confirmation by design (see AGENTS.md); not raced |

Tools were deliberately not wrapped in `Promise.race`. A send or shell command that lost the race would keep running without a persisted result, which breaks the side effect, persist, interrupt ordering.

## Defaults and configuration seam

`executeWakeup` accepts an optional `turnBudget`; without it, `DEFAULT_TURN_BUDGET` applies. Chat config does not carry a budget yet, because `src/config/config.ts` and `src/driver/index.ts` belong to the platform work. Suggested patch for whoever merges:

```ts
// src/config/config.ts — primary section schema (valibot), all optional
turnBudget: v.optional(v.object({
  maxToolRounds: v.optional(v.number()),
  maxToolCalls: v.optional(v.number()),
  deadlineMs: v.optional(v.number()),
  minModelCallMs: v.optional(v.number()),
})),
// resolved: primary.turnBudget = { ...DEFAULT_TURN_BUDGET, ...raw.primary?.turnBudget }

// src/driver/index.ts — executeWakeup call
turnBudget: chatConfig.primary.turnBudget,
```

Keep `deadlineMs` greater than `minModelCallMs`. Otherwise an interrupted continuation could not start its first step and would be rescheduled without closing the chain.

## Prompt changes

- `prompts/system.velin.md` (primary) and `prompts/late-binding.velin.md`: removed "MUST send at least one response" and "(Mandatory) send_message". The task list now asks the model to choose between speaking, reacting, both, or silence. Mentions are described as a strong signal, not an order. Tools are for when information or computation is actually needed, and the prompts state that casual chat rarely needs search. A turn-budget paragraph explains the wrap-up and the silent deadline close.
- The probe hint in the late-binding prompt is now framed as "why you might want to act now", and says silence and reaction-only remain allowed. The interrupted-turn note says the budget carries over.
- Probe criteria: the mention branch is annotated as a wake signal, not compliance. Background-task completion "may" be reported instead of being "highly likely" to be reported.
- `decide` description: `send_message` only wakes the chatbot, which may still react only or stay silent. Enum values are unchanged.
- `end_turn` description: explicit close; using it alone is silence.
- Safety text is untouched (prompt-injection rule, secret non-disclosure, style-enforcement silence rules). No new persona was written.

## Tests

New or changed (Vitest, next to source):

- `runner.test.ts` › `runner turn budget`: silence with `end_turn` and no forced send; react then end_turn; parallel react+end_turn closing with cleared follow-ups; round cap followed by a participation-only wrap-up whose stray work call does not run; parallel call cap (4 of 5 executed, the send still executes, the next step is the wrap-up); inherited exhausted chain starting at the wrap-up; model timeout capped by the deadline and a silent close with the executed result persisted; no model call after the deadline; a later model failure keeps earlier persisted steps (persist, then interrupt order); a throwing tool persisted as an error result.
- `driver-characterization.test.ts` › `Turn budget across interruption chains`: `interruptedChainUsage` counts only the open chain; an exhausted interrupted chain resumes without probe directly at the wrap-up, closes, and a new topic then runs probe with full tools.
- `probe-vs-primary.test.ts`: the forced-fallback test is replaced by "activated primary ends silently, no fallback step". The probe-hint assertions were updated to the current wording. They asserted "evaluator's notes"/"advisory only", which are not present at `HEAD` either, so that test was already failing before this branch.
- Existing runner/characterization tests now pass `budget`/`deadlineAtMs` instead of `maxSteps`.

## Verification

Dependencies were installed in this worktree with `pnpm install --frozen-lockfile` (approved). The install aborted at `lottie-frame`'s native build because the system lacks `rlottie.h` (`librlottie-dev`). JS dependencies were present; `pnpm tdlib:types` was then run manually.

| Check | Result |
| --- | --- |
| `vitest run src/driver` | 15 files, 105 tests passed (final state) |
| `pnpm test:run` (full) | 453 passed, 11 failed. All failures are native-module loading in files outside this change: `src/db/*` (better-sqlite3 bindings not built), `src/media/frame-extractor.test.ts` (lottie-frame not built, ffmpeg-static binary EACCES) |
| `pnpm typecheck` | One error, `src/telegram/markdown.ts`: no declaration file for `markdown-it-math-loose`. Not in a changed file and unrelated to this change; no errors in driver files |
| `pnpm lint` | Clean |
| `pnpm build` | Succeeded |
| Real-model behavior | Not run. All driver tests mock `callLlm`. Whether a given model actually chooses `end_turn`/`react` under the new prompts is unverified |

## Not implemented

- Configurable budget through chat config (seam above).
- A hard wall-clock turn timeout. Tools are not preemptible, and `sleep` (300 s), `download_file` (60 s), and `web_fetch` (30 s) can each exceed the 15 s deadline. Suggested follow-ups, outside this branch's ownership: cap `sleep` at the remaining deadline or remove it from primary; give `read_image`'s model a timeout.
- Staleness check before speaking (dropping a drafted reply after the topic moved on), burst merging beyond the existing debounce, and silent background work without a report wake-up.
- Graceful handling of a deadline-aborted model call. It surfaces as an `LLM call failed` error, and the scheduler waits for new input (`failedRc`), as with any model error.
- Moderation announcements are no longer guaranteed. With the fallback gone and `ban_spammer` counting as a work call, the anonymous announcement depends on primary sending it; a deadline close after a ban leaves it unsent. `ban_spammer` remains opt-in and off by default.
- Platform wording (`currentChannel: 'telegram'`, "Telegram group chat" in prompts) and the "You are open-source: Cahciua" disclosure section are unchanged and need maintainer/platform decisions.

## Follow-ups in files outside this branch

- `src/driver/context.ts`: `loopEndedWithoutSendMessage` and its tests in `context.test.ts` are now unused by production code and can be deleted.
- `docs/dcp-design.md` lines describing the mandatory send and fallback (the "An activated wake-up must contain a successful `send_message`" paragraph and "preserving the probe gate and mandatory-send invariant" in the moderation paragraph) are outdated.
- `config.example.yaml`: add a commented `primary.turnBudget` block once the config seam lands.
