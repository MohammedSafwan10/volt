import { getModelConfig } from './models';
import { estimateTokensFromChars } from '$lib/stores/assistant/utils';

export type ContextLane =
  | 'active'
  | 'selection'
  | 'touched'
  | 'query'
  | 'imports'
  | 'diagnostics'
  | 'runtime';

export interface ContextBudgetOptions {
  reserveSystemTokens?: number;
  reserveOutputTokens?: number;
  safetyTokens?: number;
}

export interface ContextBudget {
  modelId: string;
  modelContextWindow: number;
  reserveSystemTokens: number;
  reserveOutputTokens: number;
  safetyTokens: number;
  availableContextTokens: number;
  laneBudgets: Record<ContextLane, number>;
}

const DEFAULT_MODEL_WINDOW = 128_000;
const MAX_CONTEXT_BUDGET = 48_000;
const MIN_CONTEXT_BUDGET = 6_000;

const DEFAULT_LANE_WEIGHTS: Record<ContextLane, number> = {
  active: 0.32,
  selection: 0.10,
  touched: 0.20,
  query: 0.20,
  imports: 0.06,
  diagnostics: 0.08,
  runtime: 0.04,
};

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return estimateTokensFromChars(text.length, 'mixed');
}

export function createContextBudget(
  modelId: string,
  options: ContextBudgetOptions = {},
): ContextBudget {
  const config = getModelConfig(modelId);
  const modelContextWindow = config?.contextWindow ?? DEFAULT_MODEL_WINDOW;
  const modelMaxOutput = config?.maxOutput ?? 8192;

  const reserveOutputTokens = clampInt(
    options.reserveOutputTokens ?? Math.max(4096, Math.min(16_384, Math.floor(modelMaxOutput * 0.5))),
    2048,
    24_000,
  );
  const reserveSystemTokens = clampInt(options.reserveSystemTokens ?? 6000, 2000, 24_000);
  const safetyTokens = clampInt(options.safetyTokens ?? 1500, 500, 6000);

  const rawAvailable = modelContextWindow - reserveOutputTokens - reserveSystemTokens - safetyTokens;
  const availableContextTokens = clampInt(rawAvailable, MIN_CONTEXT_BUDGET, MAX_CONTEXT_BUDGET);

  const laneBudgets = Object.entries(DEFAULT_LANE_WEIGHTS).reduce(
    (acc, [lane, weight]) => {
      acc[lane as ContextLane] = Math.max(240, Math.floor(availableContextTokens * weight));
      return acc;
    },
    {} as Record<ContextLane, number>,
  );

  return {
    modelId,
    modelContextWindow,
    reserveSystemTokens,
    reserveOutputTokens,
    safetyTokens,
    availableContextTokens,
    laneBudgets,
  };
}
