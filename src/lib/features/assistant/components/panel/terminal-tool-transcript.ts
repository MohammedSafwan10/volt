export interface TerminalTranscriptSlice {
  text: string;
  nextOffset: number;
  truncatedBeforeOffset: boolean;
}

export interface TerminalTranscriptReader {
  readCleanOutputSince(offset: number, maxChars: number): TerminalTranscriptSlice;
}

export function readTerminalTranscriptSlice(
  session: TerminalTranscriptReader,
  startOffset: number,
  maxChars: number,
): TerminalTranscriptSlice {
  return session.readCleanOutputSince(startOffset, maxChars);
}

export function buildTerminalToolExcerpt(transcript: string, maxLines: number): string {
  if (maxLines <= 0 || transcript.length === 0) {
    return "";
  }
  return transcript.split("\n").slice(-maxLines).join("\n");
}
