import type { VerificationProfile } from './utils';

export type PlanningPhase = 'discover' | 'read' | 'edit' | 'verify' | 'other';

export function classifyPlanningPhase(toolName: string): PlanningPhase {
  if (
    toolName === 'workspace_search' ||
    toolName === 'find_files' ||
    toolName === 'search_symbols'
  ) {
    return 'discover';
  }
  if (
    toolName === 'read_file' ||
    toolName === 'read_files' ||
    toolName === 'read_code' ||
    toolName === 'file_outline' ||
    toolName === 'get_file_tree' ||
    toolName === 'list_dir' ||
    toolName === 'get_file_info' ||
    toolName === 'get_active_file' ||
    toolName === 'get_selection' ||
    toolName === 'get_open_files'
  ) {
    return 'read';
  }
  if (
    toolName === 'get_diagnostics' ||
    toolName.startsWith('lsp_')
  ) {
    return 'verify';
  }
  return 'other';
}

function getWorkspaceRootFileNames(nodes: Array<{ name?: string }> = []): Set<string> {
  return new Set(
    nodes
      .map((node) => node.name?.toLowerCase?.() ?? '')
      .filter(Boolean),
  );
}

export function shouldRunAfterFileEdits(toolName: string): boolean {
  // Only verification-style tools should wait for file edits.
  // Read/search/context tools must run before edits so read-before-edit evidence
  // can be established in the same iteration.
  return toolName === 'get_diagnostics' || toolName.startsWith('lsp_');
}

export function getVerificationProfiles(nodes: Array<{ name?: string }> = []): VerificationProfile[] {
  const rootNames = getWorkspaceRootFileNames(nodes);
  const has = (name: string) => rootNames.has(name.toLowerCase());

  const profiles: VerificationProfile[] = [];

  if (has('pubspec.yaml')) {
    profiles.push({
      id: 'dart_flutter',
      label: 'Dart/Flutter',
      commandPattern: /\b(flutter\s+(analyze|test|build)|dart\s+(analyze|test))\b/i,
      suggestedCommands: ['flutter analyze', 'flutter test', 'dart analyze'],
      requiresTerminalVerification: true,
    });
  }

  if (has('package.json') || has('pnpm-lock.yaml') || has('yarn.lock') || has('package-lock.json')) {
    profiles.push({
      id: 'node_js_ts',
      label: 'Node/JS/TS',
      commandPattern:
        /\b((npm|pnpm|yarn|bun)\s+(run\s+)?(lint|test|build|typecheck|check)|vitest|jest|eslint|tsc(\s|$))\b/i,
      suggestedCommands: ['npm run lint', 'npm run test', 'npm run build'],
      requiresTerminalVerification: true,
    });
  }

  if (has('cargo.toml')) {
    profiles.push({
      id: 'rust',
      label: 'Rust',
      commandPattern: /\bcargo\s+(check|test|clippy|build)\b/i,
      suggestedCommands: ['cargo check', 'cargo test'],
      requiresTerminalVerification: true,
    });
  }

  if (has('pyproject.toml') || has('requirements.txt') || has('poetry.lock')) {
    profiles.push({
      id: 'python',
      label: 'Python',
      commandPattern:
        /\b(pytest|python\s+-m\s+pytest|ruff\s+check|mypy|python\s+-m\s+unittest)\b/i,
      suggestedCommands: ['pytest', 'ruff check'],
      requiresTerminalVerification: true,
    });
  }

  if (has('go.mod')) {
    profiles.push({
      id: 'go',
      label: 'Go',
      commandPattern: /\bgo\s+(test|vet|build)\b/i,
      suggestedCommands: ['go test ./...', 'go vet ./...'],
      requiresTerminalVerification: true,
    });
  }

  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    profiles.push({
      id: 'java_jvm',
      label: 'Java/JVM',
      commandPattern: /\b(mvn\s+(test|verify|package)|gradle\s+(test|build)|\.?\/gradlew\s+(test|build))\b/i,
      suggestedCommands: ['mvn test', 'gradle test'],
      requiresTerminalVerification: true,
    });
  }

  if (profiles.length === 0) {
    profiles.push({
      id: 'generic',
      label: 'Generic',
      commandPattern:
        /\b(test|lint|build|check|typecheck|tsc|vitest|jest|pytest|cargo\s+check|cargo\s+test|eslint)\b/i,
      suggestedCommands: ['run project checks/tests'],
      requiresTerminalVerification: false,
    });
  }

  return profiles;
}
