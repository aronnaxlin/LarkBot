export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  /**
   * Whether the provider accepts a forced `tool_choice`. Reasoning/thinking
   * models often reject it (`Thinking mode does not support this tool_choice`),
   * in which case the request omits `tool_choice` and the model picks freely.
   */
  forceToolChoice?: boolean;
  extraBody?: Record<string, unknown>;
}
