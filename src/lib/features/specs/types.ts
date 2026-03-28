export type SpecPhase = 'requirements' | 'design' | 'tasks';
export type PhaseState = 'pending' | 'ready' | 'stale';
export type SpecStatus = 'draft' | 'active' | 'completed';
export type SpecTaskStatus = 'todo' | 'running' | 'blocked' | 'failed' | 'done';
export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type SpecVerificationVerdict = 'pass' | 'needs-fix' | 'incomplete';
export type SpecVerificationStatus =
  | 'running'
  | 'passed'
  | 'needs-fix'
  | 'incomplete'
  | 'failed'
  | 'cancelled';
export type SpecOperation = 'create' | 'design' | 'tasks' | 'sync-design' | 'sync-tasks';

export interface SpecTaskRunEvent {
  at: number;
  type:
    | 'created'
    | 'queued'
    | 'running'
    | 'waiting_tool'
    | 'waiting_approval'
    | 'completing'
    | 'completed'
    | 'failed'
    | 'cancelled';
  message: string;
  assistantExcerpt?: string;
}

export interface VoltSpecTaskRun {
  runId: string;
  taskId: string;
  conversationId: string;
  status: TaskRunStatus;
  startedAt: number;
  endedAt?: number;
  verification?: string;
  error?: string;
  lastStatusMessage?: string;
  lastAssistantExcerpt?: string;
}

export interface VoltSpecTaskVerification {
  verificationId: string;
  conversationId: string;
  status: SpecVerificationStatus;
  verdict?: SpecVerificationVerdict;
  createdAt: number;
  completedAt?: number;
  summary?: string;
  completenessScore?: number;
  qualityScore?: number;
  specAdherenceScore?: number;
  findings: string[];
  recommendations: string[];
  error?: string;
  lastAssistantExcerpt?: string;
  isStale?: boolean;
}

export interface VoltSpecTask {
  id: string;
  title: string;
  summary: string;
  requirementIds: string[];
  dependencyIds: string[];
  scopeHints: string[];
  verification: string;
  status: SpecTaskStatus;
  latestRunId?: string;
  runs: VoltSpecTaskRun[];
  latestVerificationId?: string;
  verifications: VoltSpecTaskVerification[];
}

export interface VoltSpecManifest {
  version: 1;
  id: string;
  slug: string;
  title: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  status: SpecStatus;
  phaseStates: Record<SpecPhase, PhaseState>;
  staleFlags: {
    design: boolean;
    tasks: boolean;
  };
  requirementsMarkdown: string;
  designMarkdown: string;
  tasks: VoltSpecTask[];
}

export interface PendingSpecDraft {
  conversationId: string;
  title: string;
  slug: string;
  prompt: string;
  createdAt: number;
  requirementsMarkdown: string;
  contextMentions: import('$features/assistant/stores/assistant.svelte').AttachedContext[];
}

export interface VoltSpecContext {
  rootPath: string;
  specDir: string;
  manifestPath: string;
  requirementsPath: string;
  designPath: string;
  tasksPath: string;
}

export interface SpecResponsePayload {
  action?: 'answer' | 'ask_clarification' | 'draft_requirements' | 'design' | 'tasks';
  assistantMessage?: string;
  title?: string;
  slug?: string;
  requirementsMarkdown?: string;
  designMarkdown?: string;
  tasks?: Array<Record<string, unknown>>;
  missingInfo?: string[];
}

export interface TaskRunSyncInput {
  conversationId: string;
  isStreaming: boolean;
  agentLoopState: import('$features/assistant/stores/assistant/loop-state').AgentLoopState;
  updatedAt: number;
  lastError?: string | null;
  assistantExcerpt?: string;
}

export interface SpecVerificationPayload {
  verdict?: SpecVerificationVerdict;
  completenessScore?: number;
  qualityScore?: number;
  specAdherenceScore?: number;
  summary?: string;
  findings?: string[];
  recommendations?: string[];
}

export interface RunAllQueue {
  specId: string;
  pendingTaskIds: string[];
}
