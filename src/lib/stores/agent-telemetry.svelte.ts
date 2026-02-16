export type AgentTelemetryEvent =
  | {
      type: 'agent.loop.state_transition';
      timestamp: number;
      from: string | null;
      to: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: 'agent.tool.call';
      timestamp: number;
      toolName: string;
      success: boolean;
      durationMs: number;
      code?: string;
      retryable?: boolean;
      signature?: string;
    }
  | {
      type: 'agent.tool.failure_signature';
      timestamp: number;
      toolName: string;
      signature: string;
    }
  | {
      type: 'agent.completion.outcome';
      timestamp: number;
      outcome: 'completed' | 'failed' | 'cancelled';
      reason?: string;
      meta?: Record<string, unknown>;
    };

const MAX_EVENTS = 2000;

class AgentTelemetryStore {
  events = $state<AgentTelemetryEvent[]>([]);

  record(event: AgentTelemetryEvent): void {
    const next = [...this.events, event];
    this.events = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
  }
}

export const agentTelemetryStore = new AgentTelemetryStore();

