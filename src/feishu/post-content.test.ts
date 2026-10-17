import { describe, expect, it } from 'vitest';

import { buildPostContent } from './post-content';

const mdText = (text: string): string => JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } });

describe('buildPostContent', () => {
  it('sends plain Markdown as a single md element', () => {
    const { content, nodes } = buildPostContent('hi **there**');
    expect(content).toBe(mdText('hi **there**'));
    expect(nodes).toEqual([{ type: 'text', text: 'hi **there**' }]);
  });

  it('rewrites a mention to the Feishu md syntax and emits a canonical node', () => {
    const { content, nodes } = buildPostContent('hey <at user_id="ou_alice">Alice</at>, ping me');
    expect(content).toBe(mdText('hey <at user_id="ou_alice">Alice</at>, ping me'));
    expect(nodes).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'mention', userId: 'ou_alice', children: [{ type: 'text', text: '@Alice' }] },
      { type: 'text', text: ', ping me' },
    ]);
  });

  it('strips a leading @ and collapses whitespace in the label', () => {
    const { content, nodes } = buildPostContent('<at user_id="ou_bot">  @Some\n  Bot \t</at> 你好');
    expect(content).toBe(mdText('<at user_id="ou_bot">Some Bot</at> 你好'));
    expect(nodes).toEqual([
      { type: 'mention', userId: 'ou_bot', children: [{ type: 'text', text: '@Some Bot' }] },
      { type: 'text', text: ' 你好' },
    ]);
  });

  it('keeps label characters Feishu accepts, including &', () => {
    const { content } = buildPostContent('<at user_id="ou_a">A & B</at>');
    expect(content).toBe(mdText('<at user_id="ou_a">A & B</at>'));
  });

  it('supports several mentions and merges adjacent text', () => {
    const { content, nodes } = buildPostContent('<at user_id="ou_a">A</at><at user_id="ou_b">B</at> and text');
    expect(content).toBe(mdText('<at user_id="ou_a">A</at><at user_id="ou_b">B</at> and text'));
    expect(nodes).toEqual([
      { type: 'mention', userId: 'ou_a', children: [{ type: 'text', text: '@A' }] },
      { type: 'mention', userId: 'ou_b', children: [{ type: 'text', text: '@B' }] },
      { type: 'text', text: ' and text' },
    ]);
  });

  it('sends mentions inside inline code verbatim without a mention node', () => {
    const text = 'use `<at user_id="ou_a">Alice</at>` for a mention';
    const { content, nodes } = buildPostContent(text);
    expect(content).toBe(mdText(text));
    expect(nodes).toEqual([{ type: 'text', text }]);
  });

  it('sends mentions inside fenced code blocks verbatim', () => {
    const text = 'before\n```\n<at user_id="ou_a">Alice</at>\n```\nafter';
    const { content, nodes } = buildPostContent(text);
    expect(content).toBe(mdText(text));
    expect(nodes).toEqual([{ type: 'text', text }]);
  });

  it('scans mentions next to code spans and never rejects tags inside the code', () => {
    const text = '`x` <at user_id="ou_a">Alice</at> `y <at user_id="bad">z</at>`';
    const { content, nodes } = buildPostContent(text);
    expect(content).toBe(mdText(text));
    expect(nodes).toEqual([
      { type: 'text', text: '`x` ' },
      { type: 'mention', userId: 'ou_a', children: [{ type: 'text', text: '@Alice' }] },
      { type: 'text', text: ' `y <at user_id="bad">z</at>`' },
    ]);
  });

  it('rejects empty text', () => {
    expect(() => buildPostContent('  \n ')).toThrow('empty');
  });

  it('rejects mentioning everyone', () => {
    expect(() => buildPostContent('<at user_id="all"></at>')).toThrow('everyone');
  });

  it('rejects ids that are not open_ids', () => {
    expect(() => buildPostContent('<at user_id="u_123">Alice</at>')).toThrow('open_id');
    expect(() => buildPostContent('<at user_id="Alice">Alice</at>')).toThrow('open_id');
  });

  it('rejects a mention without a name', () => {
    expect(() => buildPostContent('<at user_id="ou_a"></at>')).toThrow('name');
  });

  it('rejects a label containing angle brackets with a clear error', () => {
    expect(() => buildPostContent('<at user_id="ou_a"><b>Alice</b></at>')).toThrow('cannot contain');
  });

  it('rejects the card-style id attribute', () => {
    expect(() => buildPostContent('<at id="ou_a">A</at>')).toThrow('Unsupported mention syntax');
  });

  it('rejects unsupported mention spellings instead of leaking raw markup', () => {
    expect(() => buildPostContent('<mention uid="ou_a">@A</mention>')).toThrow('Unsupported mention syntax');
    expect(() => buildPostContent('<at user_id="ou_a"/>')).toThrow('Unsupported mention syntax');
  });

  it('errors on unknown participants when a predicate is provided', () => {
    expect(() => buildPostContent('<at user_id="ou_ghost">Ghost</at>', () => false))
      .toThrow('Unknown participant ou_ghost — copy the uid from the chatlog');
    const { nodes } = buildPostContent('<at user_id="ou_a">A</at>', () => true);
    expect(nodes).toEqual([{ type: 'mention', userId: 'ou_a', children: [{ type: 'text', text: '@A' }] }]);
  });

  it('rejects oversized messages after mention expansion', () => {
    expect(() => buildPostContent('字'.repeat(20_000))).toThrow('too long');
  });
});
