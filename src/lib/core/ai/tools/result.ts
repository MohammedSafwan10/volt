export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  truncated?: boolean;
  meta?: Record<string, any>;
  data?: any;
  warnings?: string[];
  tool?: string;
  code?: string;
  retryable?: boolean;
  timestamp?: number;
}

export interface CanonicalToolResult {
  success: boolean;
  output: string;
  error: string;
  data: any;
  meta: Record<string, any>;
  warnings: string[];
  tool: string;
  code: string;
  retryable: boolean;
  timestamp: number;
  truncated?: boolean;
}
