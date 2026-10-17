import type { ConversationEntry, InputPart } from '../unified-api/types';

const countImages = (entries: ConversationEntry[]): number => {
  let count = 0;
  for (const entry of entries) {
    if (entry.kind === 'toolResult' && typeof entry.payload !== 'string')
      count += entry.payload.filter(part => part.kind === 'image').length;
    else if (entry.kind === 'message')
      count += entry.parts.filter(part => part.kind === 'image').length;
  }
  return count;
};

const omissionMarker = (maxImages: number): string =>
  maxImages === 0
    ? '[image omitted: this model endpoint is configured to accept no images]'
    : `[image omitted: only the ${maxImages} most recent images are kept in context; call read_image again with the same file-id to view it]`;

export const trimImages = (entries: ConversationEntry[], maxImages: number): ConversationEntry[] => {
  let toDrop = countImages(entries) - maxImages;
  if (toDrop <= 0) return entries;
  const marker = omissionMarker(maxImages);

  return entries.map(entry => {
    if (toDrop <= 0) return entry;

    if (entry.kind === 'message' && entry.role !== 'assistant') {
      let dropped = false;
      const parts: InputPart[] = [];
      for (const part of entry.parts) {
        if (part.kind === 'image' && toDrop > 0) {
          toDrop--;
          dropped = true;
          parts.push({ kind: 'text', text: marker });
        } else {
          parts.push(part);
        }
      }
      if (!dropped) return entry;
      return { ...entry, parts };
    }

    if (entry.kind === 'toolResult' && typeof entry.payload !== 'string') {
      let dropped = false;
      const parts: InputPart[] = [];
      for (const part of entry.payload) {
        if (part.kind === 'image' && toDrop > 0) {
          toDrop--;
          dropped = true;
          parts.push({ kind: 'text', text: marker });
        } else {
          parts.push(part);
        }
      }
      if (!dropped) return entry;
      return { ...entry, payload: parts };
    }

    return entry;
  });
};
