import type { PipelineEvent } from './projection/reduce';
import type { RenderedContext } from './rendering/types';

export interface EventSink {
  persist(event: PipelineEvent): void;
  publish(event: PipelineEvent, options?: {
    hydrateAltText?: boolean;
    notifyDriver?: boolean;
  }): RenderedContext | undefined;
  accept(event: PipelineEvent, options?: {
    hydrateAltText?: boolean;
    notifyDriver?: boolean;
  }): RenderedContext | undefined;
}

export const createEventSink = (deps: {
  configuredChatIds: ReadonlySet<string>;
  persistEvent: (event: PipelineEvent) => void;
  hydrateAltText: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext;
  handleDriverEvent: (chatId: string, context: RenderedContext) => void;
}): EventSink => {
  const persisted = new WeakSet<PipelineEvent>();
  const published = new WeakMap<PipelineEvent, RenderedContext>();
  const notified = new WeakSet<PipelineEvent>();

  const persist = (event: PipelineEvent): void => {
    if (persisted.has(event)) return;
    deps.persistEvent(event);
    persisted.add(event);
  };

  const publish: EventSink['publish'] = (event, options = {}) => {
    if (!deps.configuredChatIds.has(event.chatId)) return undefined;
    let context = published.get(event);
    if (!context) {
      if (options.hydrateAltText !== false) deps.hydrateAltText(event);
      context = deps.pushPipelineEvent(event.chatId, event);
      published.set(event, context);
    }
    if (options.notifyDriver !== false && !notified.has(event)) {
      deps.handleDriverEvent(event.chatId, context);
      notified.add(event);
    }
    return context;
  };

  const accept: EventSink['accept'] = (event, options) => {
    persist(event);
    return publish(event, options);
  };

  return { persist, publish, accept };
};
