import { countConversationTokens } from '$core/services/token-counter';
import { CONTEXT_LIMITS, getModelContextLimits } from './config';

type LooseAttachment = {
  id: string;
  type: string;
  label: string;
  content?: string;
  data?: string;
  byteSize?: number;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  dimensions?: { width: number; height: number };
  rect?: { width: number; height: number };
};

type LooseMessage = {
  content: string;
  thinking?: string;
  attachments?: LooseAttachment[];
};

export interface AttachmentPreview {
  id: string;
  type: string;
  label: string;
  size?: string;
  dimensions?: string;
  isImage: boolean;
  thumbnailData?: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  usedChars: number;
  percentage: number;
  isNearLimit: boolean;
  isOverLimit: boolean;
}

function isTextAttachment(att: LooseAttachment): att is LooseAttachment & { content: string } {
  return (att.type === 'file' || att.type === 'selection') && typeof att.content === 'string';
}

function isImageAttachment(att: LooseAttachment): att is LooseAttachment & { data: string; byteSize: number } {
  return att.type === 'image' && typeof att.data === 'string' && typeof att.byteSize === 'number';
}

export function getAttachmentPreviews(attachments: LooseAttachment[]): AttachmentPreview[] {
  return attachments.map((attachment) => {
    const base: AttachmentPreview = {
      id: attachment.id,
      type: attachment.type,
      label: attachment.label,
      isImage: attachment.type === 'image',
    };

    if (isImageAttachment(attachment)) {
      return {
        ...base,
        size: `${(attachment.byteSize / 1024).toFixed(1)}KB`,
        dimensions: attachment.dimensions
          ? `${attachment.dimensions.width}x${attachment.dimensions.height}`
          : undefined,
        thumbnailData: attachment.data,
        mimeType: attachment.mimeType,
      };
    }

    if (isTextAttachment(attachment)) {
      return {
        ...base,
        size: `${attachment.content.length} chars`,
      };
    }

    return base;
  });
}

export function getTotalContextSize(attachments: LooseAttachment[]): number {
  return attachments.reduce((total, attachment) => {
    if (isTextAttachment(attachment)) {
      return total + attachment.content.length;
    }
    if (isImageAttachment(attachment)) {
      return total + attachment.byteSize;
    }
    return total;
  }, 0);
}

export function isContextWithinLimits(attachments: LooseAttachment[]): boolean {
  const textSize = attachments.reduce((sum, attachment) => {
    if (isTextAttachment(attachment)) {
      return sum + attachment.content.length;
    }
    return sum;
  }, 0);

  return textSize <= CONTEXT_LIMITS.maxContextSize;
}

export function getConversationTokens(
  messages: LooseMessage[],
  inputValue: string,
  pendingAttachments: LooseAttachment[],
): number {
  const messagesForCount = messages.map((message) => ({
    content: message.content + (message.thinking ? `\n${message.thinking}` : ''),
    attachments: message.attachments?.map((attachment) => {
      if (isTextAttachment(attachment)) {
        return { type: attachment.type, content: attachment.content };
      }
      if (isImageAttachment(attachment)) {
        return { type: attachment.type, data: attachment.data };
      }
      return { type: attachment.type };
    }),
  }));

  const pendingForCount = pendingAttachments.map((attachment) => {
    if (isTextAttachment(attachment)) {
      return { type: attachment.type, content: attachment.content };
    }
    if (isImageAttachment(attachment)) {
      return { type: attachment.type, data: attachment.data };
    }
    return { type: attachment.type };
  });

  return countConversationTokens(messagesForCount, inputValue, pendingForCount);
}

export function getConversationContextChars(
  messages: LooseMessage[],
  pendingAttachments: LooseAttachment[],
  inputValue: string,
): number {
  let total = 0;

  for (const message of messages) {
    total += message.content.length;
    if (message.thinking) {
      total += message.thinking.length;
    }
    if (!message.attachments) {
      continue;
    }
    for (const attachment of message.attachments) {
      if (isTextAttachment(attachment)) {
        total += attachment.content.length;
      } else if (attachment.type === 'image' && typeof attachment.data === 'string') {
        total += attachment.data.length;
      }
    }
  }

  total += getTotalContextSize(pendingAttachments);
  total += inputValue.length;
  return total;
}

export function getContextUsage(
  model: string,
  messages: LooseMessage[],
  pendingAttachments: LooseAttachment[],
  inputValue: string,
): ContextUsage {
  const { inputTokens: maxTokens } = getModelContextLimits(model);
  const usedChars = getConversationContextChars(messages, pendingAttachments, inputValue);
  const usedTokens = getConversationTokens(messages, inputValue, pendingAttachments);
  const percentage = Math.min(100, (usedTokens / maxTokens) * 100);

  return {
    usedTokens,
    maxTokens,
    usedChars,
    percentage,
    isNearLimit: percentage > 80,
    isOverLimit: percentage >= 100,
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}K`;
  }
  return tokens.toLocaleString();
}
