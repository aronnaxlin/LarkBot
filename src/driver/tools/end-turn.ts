import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

const END_TURN_TOOL_NAME = 'end_turn';

// Driver treats an `end_turn` call as an explicit close: the turn ends even if
// other results in the same step would otherwise request a follow-up step.
// Ending without any message or reaction is legitimate silence.
export const createEndTurnTool = (): CahciuaTool => createTool({
  name: END_TURN_TOOL_NAME,
  description:
    'End this turn. Use it after you have finished speaking or reacting, or on its own when staying silent is the right call. '
    + 'Any other tool calls in the same step still run, but no further step follows. '
    + 'After `end_turn`, you will receive new incoming messages and notifications of completed background tasks (if any) in later turns.',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ content: JSON.stringify({ ok: true }), requiresFollowUp: false }),
});
