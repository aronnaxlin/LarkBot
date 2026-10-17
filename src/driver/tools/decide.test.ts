import { describe, expect, it } from 'vitest';

import { createDecideTool, extractDecideResult } from './decide';
import type { ConversationEntry, OutputMessage } from '../../unified-api/types';

const assistantWithDecide = (args: string): OutputMessage => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'toolCall', callId: 'call_1', name: 'decide', args }],
  reasoning: undefined,
});

describe('decide tool', () => {
  it('frames the probe gate as a judgement about whether the bot should act, not a prediction', () => {
    const tool = createDecideTool();
    expect(tool.description).toContain('SHOULD act now');
    expect(tool.description).not.toMatch(/predict/i);
    const shouldAct = (tool.parameters.properties as Record<string, { description: string }>).should_act!;
    expect(shouldAct.description).toContain('no_action');
    expect(shouldAct.description).not.toMatch(/predict/i);
  });

  it('keeps the decide schema and still accepts a decision', () => {
    const tool = createDecideTool();
    expect(tool.validate({ should_act: 'no_action', reason: 'nothing new to add' }).valid).toBe(true);
    expect(tool.validate({ should_act: 'react_only', reason: 'too talkative, a reaction is enough' }).valid).toBe(true);
    expect(tool.validate({ should_act: 'send_message' })).toMatchObject({ valid: false });
    expect(tool.validate({ should_act: 'maybe', reason: 'x' }).valid).toBe(false);
  });

  it('documents react_only as message-free and keeps the enum values old rows used', () => {
    const tool = createDecideTool();
    const shouldAct = (tool.parameters.properties as Record<string, { enum: string[]; description: string }>).should_act!;
    expect(shouldAct.enum).toEqual(['send_message', 'react_only', 'no_action']);
    expect(shouldAct.description).toContain('cannot send a message');
  });

  it('extracts a valid decision from conversation entries', () => {
    const entries: ConversationEntry[] = [
      assistantWithDecide(JSON.stringify({ should_act: 'send_message', reason: 'direct mention' })),
    ];
    expect(extractDecideResult(entries)).toEqual({ should_act: 'send_message', reason: 'direct mention' });
  });

  it('extracts a react_only decision', () => {
    expect(extractDecideResult([
      assistantWithDecide(JSON.stringify({ should_act: 'react_only', reason: 'banter continuation' })),
    ])).toEqual({ should_act: 'react_only', reason: 'banter continuation' });
  });

  it('returns null for missing or malformed decisions', () => {
    expect(extractDecideResult([])).toBeNull();
    expect(extractDecideResult([assistantWithDecide('not json')])).toBeNull();
    expect(extractDecideResult([assistantWithDecide(JSON.stringify({ should_act: 'maybe', reason: 'x' }))])).toBeNull();
    expect(extractDecideResult([assistantWithDecide(JSON.stringify({ should_act: 'no_action' }))])).toBeNull();
  });
});
