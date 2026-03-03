import type { VerificationProfile } from './utils';

export interface AutoVerificationAction {
  toolName: 'run_command' | 'get_diagnostics';
  args: Record<string, unknown>;
  reason: string;
}

export function selectAutoVerificationAction(params: {
  fileEditsSucceeded: boolean;
  explicitVerificationCalled: boolean;
  profiles: VerificationProfile[];
  cwd?: string | null;
}): AutoVerificationAction | null {
  if (!params.fileEditsSucceeded || params.explicitVerificationCalled) {
    return null;
  }

  const profile = params.profiles[0];
  if (!profile) {
    return {
      toolName: 'get_diagnostics',
      args: {},
      reason: 'fallback_no_profile',
    };
  }

  if (profile.id === 'generic' || profile.suggestedCommands.length === 0) {
    return {
      toolName: 'get_diagnostics',
      args: {},
      reason: `fallback_${profile.id}`,
    };
  }

  const command = profile.suggestedCommands[0];
  if (!command) {
    return {
      toolName: 'get_diagnostics',
      args: {},
      reason: `fallback_${profile.id}_empty`,
    };
  }

  const args: Record<string, unknown> = { command };
  if (params.cwd) {
    args.cwd = params.cwd;
  }

  return {
    toolName: 'run_command',
    args,
    reason: `profile_${profile.id}`,
  };
}

