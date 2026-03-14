export interface LspHealthProbe {
  method: string;
  params: unknown;
}

const RESPONSIVE_ERROR_PATTERNS = [
  /method not found/i,
  /unsupported/i,
  /invalid params/i,
  /request failed/i,
  /server not initialized/i,
  /content modified/i,
];

export function getHealthProbe(): LspHealthProbe {
  return {
    method: 'workspace/symbol',
    params: { query: '__volt_healthcheck__' },
  };
}

export function isResponsiveProtocolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return RESPONSIVE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
