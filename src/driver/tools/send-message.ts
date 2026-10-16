import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

export interface SendMessageAttachment {
  type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
  path: string;
  file_name?: string;
}

export const createSendMessageTool = (
  send: (text: string, replyTo?: string, attachments?: SendMessageAttachment[]) => Promise<{ messageId: string }>,
  messageExists: (messageId: string) => boolean,
  options: { attachments: boolean } = { attachments: true },
): CahciuaTool => {
  const attachmentsProperty = {
    type: 'array',
    description: 'Media attachments to send. Up to 10 attachments can be sent as a media group (album). A media group can only contain either a mix of photos and videos, or a single media type.',
    items: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'video_note'],
          description: 'The type of media to send.',
        },
        path: { type: 'string', description: 'File path in the workspace.' },
        file_name: { type: 'string', description: 'Override filename (for document type only).' },
      },
      required: ['type', 'path'],
    },
  };
  const properties: Record<string, unknown> = {
    text: {
      type: 'string',
      description: options.attachments
        ? 'The message to send. When sending attachments, this becomes the caption.'
        : 'The message to send.',
    },
    reply_to: { type: 'string', description: 'The ID of an earlier message to create a quoted reply. A quoted reply is always preferred whenever your response is related to an earlier message.' },
    still_working: {
      type: 'boolean',
      description: 'Set to `true` while you are still working on an agentic task and need another step after this message. Defaults to `false`.',
    },
    ...options.attachments ? { attachments: attachmentsProperty } : {},
  };

  return createTool({
    name: 'send_message',
    description: options.attachments
      ? 'Send a message to the current conversation, optionally with media attachments.'
      : 'Send a message to the current conversation.',
    parameters: {
      type: 'object',
      properties,
      required: ['text'],
    },
    execute: async input => {
      const { text, reply_to, still_working, attachments } = input as {
        text: string;
        reply_to?: string;
        still_working?: boolean;
        attachments?: SendMessageAttachment[];
      };
      if (!options.attachments && attachments != null && attachments.length > 0)
        return { content: JSON.stringify({ error: 'Attachments are not supported on this platform. Send text only.' }), requiresFollowUp: true };
      const replyTo = reply_to === '' ? undefined : reply_to;
      if (replyTo != null && !messageExists(replyTo))
        return { content: JSON.stringify({ error: `No such reply_to message_id ${replyTo} in this chat — refusing to call the platform API with an unknown id. Send the message without reply_to, or use a valid id.` }), requiresFollowUp: true };
      const result = await send(text, replyTo, attachments);
      return {
        content: JSON.stringify({ ok: true, message_id: result.messageId }),
        requiresFollowUp: still_working ?? false,
      };
    },
  });
};
