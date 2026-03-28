type FilePillIcon =
  | 'folder'
  | 'svelte'
  | 'typescript'
  | 'javascript'
  | 'rust'
  | 'python'
  | 'json'
  | 'dart'
  | 'android'
  | 'xml'
  | 'yaml'
  | 'markdown'
  | 'css'
  | 'html'
  | 'file';

export interface FilePillPresentationInput {
  toolName: string;
  path?: string;
  isRunning: boolean;
}

export interface FilePillPresentation {
  filename: string;
  icon: FilePillIcon;
  animateIcon: boolean;
  showFilename: boolean;
}

function getFilename(path?: string): string {
  if (!path) return 'file';
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function getFileIcon(toolName: string, filename: string): FilePillIcon {
  if (toolName === 'create_dir') return 'folder';

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'svelte':
      return 'svelte';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'rs':
      return 'rust';
    case 'py':
      return 'python';
    case 'json':
      return 'json';
    case 'dart':
      return 'dart';
    case 'xml':
      if (filename.toLowerCase().includes('androidmanifest')) return 'android';
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    default:
      return 'file';
  }
}

export function getFilePillPresentation(
  input: FilePillPresentationInput,
): FilePillPresentation {
  const filename = getFilename(input.path);
  return {
    filename,
    icon: getFileIcon(input.toolName, filename),
    animateIcon: input.isRunning,
    showFilename: true,
  };
}
