export interface ToolStreamingProgress {
  charsWritten: number;
  totalChars: number;
  linesWritten: number;
  totalLines: number;
  percent: number;
}

export interface ToolRuntimeUpdate {
  liveStatus?: string;
  streamingProgress?: ToolStreamingProgress;
  meta?: Record<string, unknown>;
}

export interface ToolRuntimeContext {
  onUpdate?: (update: ToolRuntimeUpdate) => void;
}
