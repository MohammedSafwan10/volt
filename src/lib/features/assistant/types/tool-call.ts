export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolCallReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface StreamingProgress {
  charsWritten: number;
  totalChars: number;
  linesWritten: number;
  totalLines: number;
  percent: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  output?: string;
  error?: string;
  meta?: Record<string, unknown>;
  data?: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
  requiresApproval?: boolean;
  thoughtSignature?: string;
  streamingProgress?: StreamingProgress;
  reviewStatus?: ToolCallReviewStatus;
}
