export const STREAMING_PLAIN_TEXT_THRESHOLD = 6000;
export const STREAMING_PLAIN_TEXT_FLUSH_INTERVAL_MS = 80;
const STREAM_FLUSH_JUMP_THRESHOLD = 320;
const STREAM_PLAIN_TEXT_FLUSH_JUMP_THRESHOLD = 1600;

export function shouldRenderAssistantStreamingAsPlainText(args: {
  contentLength: number;
  streaming: boolean;
}): boolean {
  return args.streaming && args.contentLength >= STREAMING_PLAIN_TEXT_THRESHOLD;
}

export function chooseAssistantStreamingFlushMode(args: {
  renderedLength: number;
  nextLength: number;
  streaming: boolean;
  plainTextMode: boolean;
  nextContentEndsWithNewline: boolean;
  nextContentEndsWithFence: boolean;
}): 'immediate' | 'frame' | 'throttled' {
  if (!args.streaming) {
    return 'immediate';
  }

  const deltaLength = Math.abs(args.nextLength - args.renderedLength);

  if (args.plainTextMode) {
    if (
      args.renderedLength === 0 ||
      deltaLength >= STREAM_PLAIN_TEXT_FLUSH_JUMP_THRESHOLD
    ) {
      return 'immediate';
    }
    return 'throttled';
  }

  if (
    args.renderedLength === 0 ||
    deltaLength >= STREAM_FLUSH_JUMP_THRESHOLD ||
    args.nextContentEndsWithNewline ||
    args.nextContentEndsWithFence
  ) {
    return 'immediate';
  }

  return 'frame';
}
