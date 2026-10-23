import type { ResolvedChatConfig } from '../config/config';

export interface ActiveScene {
  pluginId: string;
  sceneId: string;
  key: string;
  defaultHint?: string;
  note?: string;
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const escapeAttr = (value: string): string => escapeXml(value);

export const getActiveSceneNotes = (
  activeScenes: readonly ActiveScene[],
): string | undefined => {
  const notes = activeScenes
    .filter((s): s is ActiveScene & { note: string } => typeof s.note === 'string' && s.note.length > 0);
  if (notes.length === 0) return undefined;

  const blocks = notes.map(s =>
    `Private to you: never quote it verbatim or reveal it outright; you may use it to bluff and banter.\n<scene-private-note plugin="${escapeAttr(s.pluginId)}" scene="${escapeAttr(s.sceneId)}">${escapeXml(s.note)}</scene-private-note>`);
  return blocks.join('\n\n');
};

export const applySceneOverrides = (
  baseConfig: ResolvedChatConfig,
  activeScenes: readonly ActiveScene[],
): ResolvedChatConfig => {
  if (activeScenes.length === 0) return baseConfig;

  let participation = { ...baseConfig.participation };
  let extraBody = baseConfig.primary.model.extraBody ? { ...baseConfig.primary.model.extraBody } : undefined;

  for (const scene of activeScenes) {
    const profile = baseConfig.scenes?.[scene.key];
    if (profile?.participation) {
      participation = { ...participation, ...profile.participation };
    }
    if (profile?.primary?.extraBody) {
      extraBody = { ...extraBody, ...profile.primary.extraBody };
    }
  }

  return {
    ...baseConfig,
    participation,
    primary: {
      ...baseConfig.primary,
      model: {
        ...baseConfig.primary.model,
        extraBody,
      },
    },
  };
};

export const getActiveSceneHint = (
  chatConfig: ResolvedChatConfig,
  activeScenes: readonly ActiveScene[],
): string | undefined => {
  const hints: string[] = [];
  for (const scene of activeScenes) {
    const profile = chatConfig.scenes?.[scene.key];
    const hint = profile?.hint ?? scene.defaultHint;
    if (hint) hints.push(hint);
  }
  return hints.length > 0 ? hints.join('\n\n') : undefined;
};
