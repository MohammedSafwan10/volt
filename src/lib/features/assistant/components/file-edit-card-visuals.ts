import type { UIIconName } from '$shared/components/ui';

interface FileEditStatusVisualInput {
  toolName: string;
  isFailed: boolean;
}

interface FileEditStatusVisual {
  statusIcon: UIIconName;
  showStatusIndicator: boolean;
}

export function getFileEditStatusVisual(
  input: FileEditStatusVisualInput,
): FileEditStatusVisual {
  if (input.isFailed) {
    return { statusIcon: 'error', showStatusIndicator: true };
  }

  if (input.toolName === 'delete_file' || input.toolName === 'delete_path') {
    return { statusIcon: 'trash', showStatusIndicator: true };
  }

  if (input.toolName === 'create_dir') {
    // The file pill already shows a folder icon for the target path, so
    // repeating the same icon in the leading status slot is redundant.
    return { statusIcon: 'folder', showStatusIndicator: false };
  }

  return { statusIcon: 'pencil', showStatusIndicator: true };
}
