export type AgentLoopState =
  | 'running'
  | 'waiting_approval'
  | 'waiting_tool'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const ALLOWED_LOOP_TRANSITIONS: Record<AgentLoopState, AgentLoopState[]> = {
  running: ['waiting_approval', 'waiting_tool', 'completing', 'completed', 'failed', 'cancelled', 'running'],
  waiting_approval: ['running', 'waiting_tool', 'failed', 'cancelled'],
  waiting_tool: ['running', 'waiting_approval', 'completing', 'completed', 'failed', 'cancelled'],
  completing: ['completed', 'failed', 'cancelled'],
  completed: ['running'],
  failed: ['running'],
  cancelled: ['running'],
};

export function isValidLoopTransition(from: AgentLoopState, to: AgentLoopState): boolean {
  const allowed = ALLOWED_LOOP_TRANSITIONS[from] || [];
  return allowed.includes(to);
}
