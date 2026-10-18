import { lastActedAtMs } from './context';
import type { TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';

// Tools that exist only to run host shell commands or manage the background
// tasks such commands start. `tools.bash.requireMaintainer` hides all three
// together: with the gate closed the model cannot run a command or reach a task
// started by a previous maintainer-gated turn. Background-task completion still
// reaches the model as a runtime event, and it can report from that summary.
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'kill_task', 'read_task_output']);

export interface BashGateDecision {
  open: boolean;
  /** Canonical id of the maintainer whose message opened the gate. */
  maintainerId?: string;
  // `maintainer`: opened by a trusted sender; `persisted`: continuation reusing
  // the chain's stored decision; `maintainer-required-off`: the deployment
  // opted out; `closed`: no maintainer message in the window.
  reason: 'maintainer' | 'persisted' | 'maintainer-required-off' | 'closed';
}

// Sender identity is canonical (`senderId` + the trusted set), never rendered
// names or message text. Any maintainer message in the window opens the gate:
// name-calls cannot be detected deterministically, so requiring a direct
// address would leave some genuine maintainer asks without shell access. A
// direct address is preferred only for choosing the logged id. A deleted
// message is skipped: the render keeps the sender id for the tombstone, but the
// message it was is retracted and must not act as a live request.
const findMaintainerInWindow = (params: {
  rc: RenderedContext;
  afterMs: number;
  untilMs: number;
  isMaintainer: (userId: string) => boolean;
}): string | undefined => {
  let fallback: string | undefined;
  for (const seg of params.rc) {
    if (seg.isMyself || seg.isDeleted || seg.senderId === undefined) continue;
    if (seg.receivedAtMs <= params.afterMs || seg.receivedAtMs > params.untilMs) continue;
    if (!params.isMaintainer(seg.senderId)) continue;
    if (seg.mentionsMe === true || seg.repliesToMe === true) return seg.senderId;
    fallback ??= seg.senderId;
  }
  return fallback;
};

/**
 * Decide whether a primary turn may use shell tools.
 *
 * A fresh turn opens the gate when a maintainer message arrived after the bot's
 * last action and no earlier than `maintainerWindowMs` before the wake-up
 * starts. The window bounds the case where a silent turn or a `no_action` probe
 * does not advance "last acted": an old maintainer message cannot keep the gate
 * open indefinitely.
 *
 * An interrupted continuation never recomputes. Every step of a turn persists
 * `shellToolsExposed`, so the continuation reads the chain's original decision
 * from its last persisted turn response. That is immune to a maintainer message
 * arriving during the probe (which runs after the context was captured) and to
 * compaction trimming the chain's earliest steps. Pre-migration rows default to
 * false, so an old chain stays closed.
 */
export const resolveBashGate = (params: {
  rc: RenderedContext;
  turnResponses: TurnResponseV2[];
  interrupted: boolean;
  isMaintainer: (userId: string) => boolean;
  requireMaintainer: boolean;
  nowMs: number;
  maintainerWindowMs: number;
}): BashGateDecision => {
  if (!params.requireMaintainer) return { open: true, reason: 'maintainer-required-off' };

  if (params.interrupted) {
    return params.turnResponses.at(-1)?.shellToolsExposed === true
      ? { open: true, reason: 'persisted' }
      : { open: false, reason: 'closed' };
  }

  const maintainerId = findMaintainerInWindow({
    rc: params.rc,
    afterMs: Math.max(
      lastActedAtMs(params.rc, params.turnResponses),
      params.nowMs - params.maintainerWindowMs,
    ),
    untilMs: params.nowMs,
    isMaintainer: params.isMaintainer,
  });
  return maintainerId === undefined
    ? { open: false, reason: 'closed' }
    : { open: true, maintainerId, reason: 'maintainer' };
};
