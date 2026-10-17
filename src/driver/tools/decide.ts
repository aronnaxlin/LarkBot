import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { ConversationEntry } from '../../unified-api/types';

const DECIDE_TOOL_NAME = 'decide';

type DecideAction = 'send_message' | 'react_only' | 'no_action';

interface DecideArgs {
  should_act: DecideAction;
  reason: string;
}

export const createDecideTool = (): CahciuaTool => createTool({
  name: DECIDE_TOOL_NAME,
  description:
    'Decide whether the chatbot SHOULD act now, based on the conversation, its personality, and how much it has already said — not whether it would feel like talking.',
  parameters: {
    type: 'object',
    properties: {
      should_act: {
        type: 'string',
        enum: ['send_message', 'react_only', 'no_action'],
        description:
          '`send_message`: Acting now is warranted; wake the chatbot and let it choose between replying, reacting only, or ending silently. '
          + 'Use it when the chatbot can add something: a real answer, a fresh joke, a needed correction, or when it is directly addressed (@-mentioned, quote-replied, or called by name).\n'
          + '`react_only`: The chatbot should acknowledge the room with a reaction and nothing more. Primary runs with only `react` and `end_turn`; it cannot send a message this turn.\n'
          + '`no_action`: The chatbot should stay out of it this round: nothing new to add, the message was meant for someone else, or it has already been talking more than the room needs.',
      },
      reason: {
        type: 'string',
        description: 'Explain your judgement in one sentence.',
      },
    },
    required: ['should_act', 'reason'],
  },
  execute: () => ({ content: JSON.stringify({ ok: true }), requiresFollowUp: false }),
});

const isDecideAction = (value: unknown): value is DecideAction =>
  value === 'send_message' || value === 'react_only' || value === 'no_action';

export const extractDecideResult = (entries: ConversationEntry[]): DecideArgs | null => {
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of entry.parts) {
      if (part.kind === 'toolCall' && part.name === DECIDE_TOOL_NAME) {
        try {
          const parsed = JSON.parse(part.args) as Partial<DecideArgs>;
          if (isDecideAction(parsed.should_act) && typeof parsed.reason === 'string')
            return { should_act: parsed.should_act, reason: parsed.reason };
        } catch {
          continue;
        }
      }
    }
  }
  return null;
};
