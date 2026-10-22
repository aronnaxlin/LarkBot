import type { ResolvedChatConfig } from '../config/config';

export interface ActiveScene {
  pluginId: string;
  sceneId: string;
  key: string;
  defaultHint?: string;
}

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
