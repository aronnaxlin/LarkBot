import { describe, expect, it } from 'vitest';

import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';

// Platform wording must follow the configured channel, and Feishu output rules
// must not advertise capabilities the Feishu adapter lacks.
const system = (currentChannel: 'telegram' | 'feishu', mode: 'primary' | 'probe', chatId: string) =>
  renderSystemPrompt({ mode, currentChannel, modelName: 'test-model', chatId });

describe('platform-specific prompts', () => {
  it('renders Feishu wording without Telegram-only syntax, deep links, or at-mentions', async () => {
    const primary = await system('feishu', 'primary', 'oc_synthetic_group');
    expect(primary).toContain('Feishu (Lark) group chat');
    expect(primary).toContain('## Feishu Markdown');
    expect(primary).toContain('current-channel: feishu');
    expect(primary).not.toContain('Telegram');
    expect(primary).not.toContain('t.me');
    expect(primary).not.toContain('||spoiler||');
    expect(primary).toContain('do not write `@`-mention syntax or `<at>` tags');

    expect(await system('feishu', 'probe', 'oc_synthetic_group')).toContain('chatlog of a Feishu (Lark) group chat');
    const lateBinding = await renderLateBindingPrompt({ mode: 'probe', currentChannel: 'feishu', timeNow: '2026-10-16T00:00:00+08:00' });
    expect(lateBinding).toContain('Feishu (Lark) group chat');
    expect(lateBinding).not.toContain('Telegram');
  });

  it('keeps the Telegram formatting rules and deep links for Telegram', async () => {
    const primary = await system('telegram', 'primary', '-1001234567890');
    expect(primary).toContain('Telegram group chat');
    expect(primary).toContain('## Telegram-flavored Markdown');
    expect(primary).toContain('https://t.me/c/1234567890/<messageId>');
    expect(primary).not.toContain('Feishu');
    const lateBinding = await renderLateBindingPrompt({ mode: 'probe', currentChannel: 'telegram', timeNow: '2026-10-16T00:00:00+08:00' });
    expect(lateBinding).toContain('Telegram group chat');
  });
});
