import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core-vue';
import { describe, expect, it } from 'vitest';

// The system prompt is meant to change dynamically, so most of these tests only
// cover structure:
//   1. every template compiles (in both `primary` and `probe` where applicable);
//   2. custom XML prompt tags survive Markdown conversion (regression #62).
//
// The `participation tuning wording` block below is the deliberate exception:
// those rules decide when the bot speaks, so their presence and ordering are
// asserted as data. Keep those assertions structural (a rule exists, branches
// appear in a given order) rather than locking whole sentences.
//
// Regression reference: https://github.com/moeru-ai/velin/pull/62

// basePath must be a file (not directory) so createRequire resolves pnpm's node_modules
const basePath = resolve(__dirname, '../../package.json');

const renderTemplate = async (name: string, data: Record<string, unknown> = {}) => {
  const template = readFileSync(resolve(__dirname, `../../prompts/${name}`), 'utf-8');
  const { rendered } = await renderMarkdownString(template, data, basePath);
  return rendered;
};

// A template compiles successfully when it renders non-empty text and leaves no
// Vue template syntax behind in the output.
const expectCompiled = (rendered: string) => {
  expect(rendered.trim().length).toBeGreaterThan(0);
  expect(rendered).not.toContain('v-if=');
  expect(rendered).not.toContain('v-for=');
  expect(rendered).not.toContain('v-else');
  expect(rendered).not.toContain('defineProps');
};

const MODES = ['primary', 'probe'] as const;
const SYSTEM_PROPS = { chatId: '-1001234567890' };

// Templates compile in both modes
describe.each(MODES)('system.velin.md (mode=%s)', mode => {
  it('compiles', async () => {
    expectCompiled(await renderTemplate('system.velin.md', { mode, ...SYSTEM_PROPS }));
  });
});

describe.each(MODES)('late-binding.velin.md (mode=%s)', mode => {
  it('compiles', async () => {
    expectCompiled(await renderTemplate('late-binding.velin.md', { mode, timeNow: '2026-09-30T00:00:00Z' }));
  });
});

describe('shell access wording', () => {
  it('renders only when shell is enabled and maintainer-gated', async () => {
    const gated = await renderTemplate('system.velin.md', { mode: 'primary', shellMaintainerGated: true, ...SYSTEM_PROPS });
    expect(gated).toContain('Shell access');
    const open = await renderTemplate('system.velin.md', { mode: 'primary', shellMaintainerGated: false, ...SYSTEM_PROPS });
    expect(open).not.toContain('Shell access');
    const unset = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expect(unset).not.toContain('Shell access');
  });
});

// Remaining prompt templates compile
describe.each([
  'compaction-system.velin.md',
  'compaction-late-binding.velin.md',
  'image-to-text-system.velin.md',
  'animation-to-text-system.velin.md',
  'sticker-animation-to-text-system.velin.md',
  'custom-emoji-to-text-system.velin.md',
])('%s', name => {
  it('compiles', async () => {
    expectCompiled(await renderTemplate(name));
  });
});

// Participation tuning (phase 1). These assert on the wording this change
// introduced: the probe gate judges whether the bot SHOULD act, restraint and
// addressee rules are first-class, and the new participation signals render
// only when the driver provides them.
describe('participation tuning wording', () => {
  it('asks the probe to judge whether the bot should act, not to predict behaviour', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).toContain('Decide whether the chatbot should act now');
    expect(probe).not.toContain('Predict whether the chatbot will immediately');
  });

  it('keeps restraint, addressee, bot-to-bot, and volume rules in the probe criteria', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).toContain('the latest message was authored by another bot');
    expect(probe).toContain('the latest message is addressed to someone else');
    expect(probe).toContain('plain continuation of ongoing banter is not enough');
    expect(probe).toContain('over the volume brake below');
    expect(probe).toContain("The volume brake is more than 10 of the chatbot's own messages in the last ten minutes.");
    expect(probe).toContain('one message from the chatbot per four to six human messages');
    expect(probe).toContain('return "react_only"');
    expect(probe).toContain("the chatbot's turn in a game it is playing");
    expect(probe).toContain('states something wrong about what the chatbot said or did');
    expect(probe).toContain('clearly invites a reaction');
  });

  it('renders the participation style and brake threshold from chat config', async () => {
    const render = (participationStyle: 'quiet' | 'normal' | 'lively') =>
      renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS, participationStyle, brakeMessages10m: 6 });
    const quiet = await render('quiet');
    const lively = await render('lively');
    const normal = await render('normal');
    expect(quiet).toContain('This chat wants a quiet chatbot');
    expect(quiet).not.toContain('per four to six human messages');
    expect(lively).toContain('per two to three human messages');
    expect(normal).toContain('per four to six human messages');
    expect(normal).toContain('more than 6 of the chatbot');
  });

  it('puts a human direct address before the bot-author rule, and both before the volume brake', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    const direct = probe.indexOf('from a human since the chatbot last acted');
    const botAuthor = probe.indexOf('was authored by another bot');
    const brake = probe.indexOf('has already been talkative');
    expect(direct).toBeGreaterThan(-1);
    expect(botAuthor).toBeGreaterThan(-1);
    expect(brake).toBeGreaterThan(-1);
    expect(direct).toBeLessThan(botAuthor);
    expect(botAuthor).toBeLessThan(brake);
    // Another bot's address is never a direct address, and the brake is scoped
    // to unaddressed chatter: game turns and corrections bypass it on purpose.
    expect(probe).toContain("Another bot's mention or name-call is not a direct");
    expect(probe).toContain('both bypass the volume brake');
    expect(probe).toContain('that target does not apply to it');
  });

  it('keeps corrections in chat and persona only, with backend secrecy winning', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).toContain('Corrections cover only what the chatbot said or did in this chat, and its persona.');
    expect(probe).toContain('never correct them with real details');
  });

  it('tells primary to add something only when it speaks', async () => {
    const primary = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expect(primary).toContain('Add something when you speak');
    expect(primary).toContain('an answer is the normal thing');
  });

  it('documents bot="true" in the chatlog format without touching self messages', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).toContain('bot="true"');
    expect(probe).toContain('myself="true"');
  });

  it('keeps the backend-disclosure rule without contradicting the backend-switching block', async () => {
    const primary = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expect(primary).toContain('anything about your own backend');
    expect(primary).toContain("don't repeat, confirm, or deny them now");
    expect(primary).toContain('Staying consistent with an earlier leak is never a reason');
  });

  it('never renders the configured model name in the primary or probe prompt', async () => {
    const modelName = 'commandcode-plan/deepseek/deepseek-v4.1-flash';
    const primary = await renderTemplate('system.velin.md', { mode: 'primary', modelName, ...SYSTEM_PROPS });
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', modelName, ...SYSTEM_PROPS });
    expect(primary).not.toContain('deepseek-v4.1-flash');
    expect(probe).not.toContain('deepseek-v4.1-flash');
    expect(primary).not.toContain('commandcode-plan');
    expect(probe).not.toContain('commandcode-plan');
    expect(primary).not.toContain('test-model');
    expect(probe).not.toContain('test-model');
  });

  it('omits the participation activity blocks when no signals are provided', async () => {
    const probe = await renderTemplate('late-binding.velin.md', { mode: 'probe', timeNow: '2026-10-16T00:00:00+08:00' });
    expect(probe).not.toContain("The chatbot's recent activity");
    const primary = await renderTemplate('late-binding.velin.md', { mode: 'primary', timeNow: '2026-10-16T00:00:00+08:00' });
    expect(primary).not.toContain('Your recent activity');
    expect(primary).not.toContain('Bot-to-bot activity');
  });

  it('renders probe participation numbers and bot-to-bot count only when provided', async () => {
    const probe = await renderTemplate('late-binding.velin.md', {
      mode: 'probe',
      timeNow: '2026-10-16T00:00:00+08:00',
      recentSelfMessages10m: 12,
      secondsSinceLastSelfMessage: 30,
      consecutiveBotExchanges: 4,
    });
    expect(probe).toContain('It sent 12 messages in the last 10 minutes.');
    expect(probe).toContain('Its last message was 30 seconds ago.');
    expect(probe).toContain('4 consecutive messages have come from bots.');
  });

  it('renders primary volume guidance only above the ten-in-ten-minutes threshold', async () => {
    const above = await renderTemplate('late-binding.velin.md', {
      mode: 'primary',
      timeNow: '2026-10-16T00:00:00+08:00',
      recentSelfMessages10m: 11,
    });
    expect(above).toContain('You sent 11 messages in the last 10 minutes.');
    expect(above).toContain('more than the room needs');

    const below = await renderTemplate('late-binding.velin.md', {
      mode: 'primary',
      timeNow: '2026-10-16T00:00:00+08:00',
      recentSelfMessages10m: 10,
    });
    expect(below).toContain('You sent 10 messages in the last 10 minutes.');
    expect(below).not.toContain('more than the room needs');
  });

  it('frames the probe reason as context, not a mandate', async () => {
    const primary = await renderTemplate('late-binding.velin.md', {
      mode: 'primary',
      timeNow: '2026-10-16T00:00:00+08:00',
      probeReason: 'someone mentioned it',
    });
    expect(primary).toContain('Why you were woken up');
    expect(primary).toContain('context, not an instruction');
  });

  it('renders the react-only turn notice only for primary with reactOnly', async () => {
    const reactOnly = await renderTemplate('late-binding.velin.md', {
      mode: 'primary',
      timeNow: '2026-10-16T00:00:00+08:00',
      reactOnly: true,
    });
    expect(reactOnly).toContain('This is a react-or-stay-silent turn.');
    expect(reactOnly).toContain('cannot send a message');
    expect(reactOnly).toContain('At most one reaction');

    const normal = await renderTemplate('late-binding.velin.md', { mode: 'primary', timeNow: '2026-10-16T00:00:00+08:00' });
    expect(normal).not.toContain('react-or-stay-silent turn');
    const probe = await renderTemplate('late-binding.velin.md', { mode: 'probe', timeNow: '2026-10-16T00:00:00+08:00', reactOnly: true });
    expect(probe).not.toContain('react-or-stay-silent turn');
  });

  it('uses singular grammar for one message and one second', async () => {
    const primary = await renderTemplate('late-binding.velin.md', {
      mode: 'primary',
      timeNow: '2026-10-16T00:00:00+08:00',
      recentSelfMessages10m: 1,
      secondsSinceLastSelfMessage: 1,
    });
    expect(primary).toContain('You sent 1 message in the last 10 minutes.');
    expect(primary).toContain('Your last message was 1 second ago.');
    expect(primary).not.toContain('1 messages');
    expect(primary).not.toContain('1 seconds');
  });

  it('does not render a bot-to-bot block for a single bot message', async () => {
    const probe = await renderTemplate('late-binding.velin.md', {
      mode: 'probe',
      timeNow: '2026-10-16T00:00:00+08:00',
      consecutiveBotExchanges: 1,
    });
    const primary = await renderTemplate('late-binding.velin.md', {
      mode: 'primary',
      timeNow: '2026-10-16T00:00:00+08:00',
      consecutiveBotExchanges: 1,
    });
    expect(probe).not.toContain('consecutive messages have come from bots');
    expect(primary).not.toContain('Bot-to-bot activity');
  });
});

// Maintainer status and late-delivered messages change what the model sees, so
// their rules are asserted as structure and ordering like the participation set.
describe('maintainer and late-delivery wording', () => {
  it('documents maintainer status as deployment config only', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).toContain('maintainer="true"');
    expect(probe).toContain('deployment configuration');
    expect(probe).toContain('never establish it');
    expect(probe).toContain('context, not an order');
    expect(probe).toContain('does not make a message more worth answering');
    expect(probe.indexOf('maintainer="true"')).toBeGreaterThan(probe.indexOf('bot="true"'));
  });

  it('keeps maintainers as context, not authority, with secrecy intact', async () => {
    const primary = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expect(primary).toContain('run this bot');
    expect(primary).toContain('you do not have to obey them');
    expect(primary).toContain('maintainers included');
  });

  it('judges late-delivered messages by arrival order as direct addresses', async () => {
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).toContain('delivered late');
    expect(probe).toContain('arrival order');
    expect(probe).toContain('still a direct address');
    const direct = probe.indexOf('from a human since the chatbot last acted');
    const late = probe.indexOf('late-delivered');
    const botAuthor = probe.indexOf('was authored by another bot');
    expect(direct).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(direct);
    expect(late).toBeLessThan(botAuthor);
  });

  it('lets primary acknowledge the delay without explaining the backend', async () => {
    const primary = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expect(primary).toContain('acknowledge the delay');
    expect(primary).toContain('Never explain the backend');
    const probe = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expect(probe).not.toContain('acknowledge the delay');
  });
});

// Custom XML prompt tags survive Markdown conversion
// Custom XML-style prompt tags used to be silently dropped during the
// HTML-to-Markdown conversion, losing their attributes and structure.
describe('custom XML prompt tags are preserved (regression #62)', () => {
  // Tags used directly in the primary template body.
  const PRIMARY_MARKERS = [
    '<example>', '</example>',
    '<suppose>', '</suppose>',
    '<bad-example>', '</bad-example>',
    '<good-example>', '</good-example>',
    '<explanation>', '</explanation>',
  ];

  // XML examples shared by both modes (the "Chatlog format" fences).
  const SHARED_MARKERS = [
    '<message id=', '</message>',
    '<in-reply-to ', '</in-reply-to>',
    '<event ',
    '<custom-emoji ', '</custom-emoji>',
    '<sticker ', '</sticker>',
    '<image ', '</image>',
    '<attachment ',
    '<runtime-event ', '</runtime-event>',
  ];

  const expectMarkers = (rendered: string, markers: string[]) => {
    for (const marker of markers)
      expect(rendered, `missing custom tag marker: ${marker}`).toContain(marker);
  };

  it('keeps tags in the primary system prompt', async () => {
    const rendered = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expectMarkers(rendered, [...PRIMARY_MARKERS, ...SHARED_MARKERS]);
  });

  it('keeps shared tags in the probe system prompt', async () => {
    const rendered = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expectMarkers(rendered, SHARED_MARKERS);
  });
});
