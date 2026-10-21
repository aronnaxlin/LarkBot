import { bodyChars, ENTRY_SEPARATOR, hearsayStats, serializeEntry } from './format';
import { SELF_PATH } from './types';
import type { ForgetRecord, MemoryConfig, MemoryEntry, MemoryPath } from './types';
import type { MemorySpeaker } from './window';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PromptFile {
  path: MemoryPath;
  entries: readonly MemoryEntry[];
}

/**
 * The state half of the consolidator's user message: speakers, every writable
 * file verbatim (evidence ids included, so the model can quote entries for
 * `old_text`), the remaining budget and hearsay usage, and the do-not-readd
 * list. Built in code: the notes are arbitrary text and must not pass through
 * the template engine.
 */
export const renderMemoryState = (params: {
  config: MemoryConfig;
  speakers: readonly MemorySpeaker[];
  files: readonly PromptFile[];
  forgets: readonly ForgetRecord[];
}): string => {
  const lines: string[] = ['<memory-state>', '<speakers>'];
  for (const speaker of params.speakers)
    lines.push(`<speaker uid="${escapeAttr(speaker.uid)}" name="${escapeAttr(speaker.displayName)}" messages="${speaker.messageCount}" path="people/${escapeAttr(speaker.uid)}.md"/>`);
  lines.push('</speakers>');
  for (const file of params.files) {
    const budget = file.path === SELF_PATH ? params.config.selfMaxChars : params.config.cardMaxChars;
    const hearsay = hearsayStats(file.entries);
    const remaining = Math.max(0, budget - bodyChars(file.entries));
    lines.push(`<memory-file path="${escapeAttr(file.path)}" budget-remaining="${remaining}" hearsay="${hearsay.count}/${params.config.hearsayMaxEntries}">`);
    lines.push(file.entries.length === 0 ? '(empty)' : file.entries.map(serializeEntry).join(`\n${ENTRY_SEPARATOR}\n`));
    lines.push('</memory-file>');
  }
  if (params.forgets.length > 0) {
    lines.push('<do-not-readd>');
    for (const forget of params.forgets) lines.push(`- ${forget.uid}: ${forget.text}`);
    lines.push('</do-not-readd>');
  }
  lines.push('</memory-state>');
  return lines.join('\n');
};
