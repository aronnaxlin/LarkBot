import { execFile } from 'node:child_process';

import type { Logger } from '@guiiai/logg';

import type { DriverPlatform } from './platform';
import {
  createAttachmentDownloader,
  createBanSpammerTool,
  createBashTool,
  createDownloadFileTool,
  createEndTurnTool,
  createKillTaskTool,
  createReactTool,
  createReadImageTool,
  createReadOldMessagesTool,
  createReadTaskOutputTool,
  createSendMessageTool,
  createSleepTool,
  createWebFetchTool,
  createWebSearchTool,
} from './tools';
import type { CahciuaTool } from './tools';
import { createWebFetcher } from './web-fetch';
import { createWebSearcher } from './web-search';
import type { ResolvedChatConfig, RuntimeConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import { renderImageToTextSystemPrompt } from '../media/image-to-text-prompt';
import { callDescriptionLlm } from '../media/llm-description';

type ImageDetail = 'low' | 'high';

export interface PrimaryToolsConfig {
  imageToText: Pick<ResolvedChatConfig['imageToText'], 'enabled' | 'model'>;
  tools: ResolvedChatConfig['tools'];
}

export interface PrimaryToolsDependencies extends Pick<
  DriverPlatform,
  'sendMessage' | 'banSpammer' | 'setMessageReaction' | 'loadMessageAttachments' | 'messageExists' | 'downloadMessageMedia'
> {
  chatId: string;
  chatConfig: PrimaryToolsConfig;
  runtimeConfig: RuntimeConfig;
  readOldMessages: (chatId: string, messageIds: string[]) => Promise<string> | string;
  resolveModel: (name: string) => LlmEndpoint;
  backgroundTask: {
    startTask: (
      typeName: string,
      sessionId: string,
      params: unknown,
      intention: string | undefined,
      timeoutMs: number,
    ) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    readTaskOutput: (
      taskId: number,
      offset?: number,
      limit?: number,
    ) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  log: Logger;
}

const createFileReader = (runtime: RuntimeConfig) => async (path: string): Promise<Buffer> => {
  const readFileCommand = runtime.readFile;
  return await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      readFileCommand[0]!,
      [...readFileCommand.slice(1), path],
      { timeout: 60_000, maxBuffer: runtime.readFileSizeLimit, encoding: null },
      (error, stdout) => {
        if (error) reject(new Error(`Failed to read file: ${error.message}`));
        else resolve(stdout);
      },
    );
    if (!child.stdin) throw new Error('Runtime read command has no stdin stream');
    child.stdin.end();
  });
};

const createImageToTextResolver = (
  deps: PrimaryToolsDependencies,
): ((buffer: Buffer, detail: ImageDetail) => Promise<string>) | undefined => {
  if (!deps.chatConfig.imageToText.enabled) return undefined;
  const modelName = deps.chatConfig.imageToText.model;
  if (!modelName) throw new Error('imageToText.model is required when imageToText.enabled=true');

  return async (buffer, detail) => {
    const system = await renderImageToTextSystemPrompt({ caption: '', detail });
    const result = await callDescriptionLlm({
      model: deps.resolveModel(modelName),
      system,
      userText: 'Describe this image.',
      images: [buffer],
      log: deps.log,
      label: 'read-image',
    });
    return result.text.trim();
  };
};

const createUnsupportedAttachmentDownloader = () => async (): Promise<Buffer> => {
  throw new Error('Chat attachments are not available on this platform. Use `path` for local files.');
};

export const createPrimaryTools = (deps: PrimaryToolsDependencies): CahciuaTool[] => {
  const { loadMessageAttachments, downloadMessageMedia, banSpammer } = deps;
  if ((loadMessageAttachments == null) !== (downloadMessageMedia == null))
    throw new Error('Platform attachment capability requires both loadMessageAttachments and downloadMessageMedia');
  const attachmentsSupported = loadMessageAttachments != null && downloadMessageMedia != null;

  const messageExists = (messageId: string) => deps.messageExists(deps.chatId, messageId);
  const sendMessageTool = createSendMessageTool(async (text, replyTo, attachments) => {
    deps.log.withFields({
      chatId: deps.chatId,
      text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
      replyTo,
      attachments: attachments?.length ?? 0,
    }).log('send_message tool called');
    const sent = await deps.sendMessage(
      deps.chatId,
      text,
      replyTo,
      attachments,
    );
    return { messageId: sent.messageId };
  }, messageExists, { attachments: attachmentsSupported });

  const downloadAttachment = attachmentsSupported
    ? createAttachmentDownloader({
        chatId: deps.chatId,
        loadMessageAttachments,
        downloadMessageMedia,
      })
    : createUnsupportedAttachmentDownloader();

  const tools: CahciuaTool[] = [
    sendMessageTool,
    ...(deps.chatConfig.tools.banSpammer && banSpammer
      ? [createBanSpammerTool(messageId => banSpammer(deps.chatId, messageId))]
      : []),
    createReactTool(
      (messageId, emoji) => deps.setMessageReaction(deps.chatId, messageId, emoji),
      messageExists,
    ),
  ];

  if (deps.chatConfig.tools.bash.enabled) {
    tools.push(createBashTool(deps.runtimeConfig, {
      startTask: deps.backgroundTask.startTask,
      sessionId: deps.chatId,
      backgroundThresholdSec: deps.chatConfig.tools.bash.backgroundThresholdSec,
    }));
  }

  if (deps.chatConfig.tools.webSearch)
    tools.push(createWebSearchTool(createWebSearcher(deps.chatConfig.tools.webSearch)));
  if (deps.chatConfig.tools.webFetch)
    tools.push(createWebFetchTool(createWebFetcher(deps.chatConfig.tools.webFetch)));

  if (attachmentsSupported) {
    tools.push(createDownloadFileTool({
      downloadAttachment,
      runtime: deps.runtimeConfig,
    }));
  }
  tools.push(
    createReadImageTool({
      downloadAttachment,
      readFile: createFileReader(deps.runtimeConfig),
      resolveImageToText: createImageToTextResolver(deps),
    }),
    createKillTaskTool(taskId => deps.backgroundTask.killTask(taskId)),
    createReadTaskOutputTool((taskId, offset, limit) =>
      deps.backgroundTask.readTaskOutput(taskId, offset, limit)),
    createReadOldMessagesTool(messageIds => deps.readOldMessages(deps.chatId, messageIds)),
    createSleepTool(),
    createEndTurnTool(),
  );

  return tools;
};
