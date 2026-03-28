import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMock = vi.fn();
const invokeMock = vi.fn();

vi.mock('$core/services/file-service', () => ({
  fileService: {
    read: readMock,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('$core/ai/tools/utils', async () => {
  return {
    truncateOutput: (text: string) => ({ text, truncated: false }),
    formatWithLineNumbers: (text: string, startLine = 1) =>
      text
        .split('\n')
        .map((line, index) => `${String(startLine + index).padStart(4, ' ')} │ ${line}`)
        .join('\n'),
    resolvePath: (path: string) => path,
  };
});

describe('read handlers', () => {
  beforeEach(() => {
    readMock.mockReset();
    invokeMock.mockReset();
  });

  it('nudges the model toward discovery or scaffolding when a read target is missing', async () => {
    readMock.mockResolvedValue(null);
    const { handleReadFile } = await import('./read');

    const result = await handleReadFile({ path: 'package.json' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found: package.json');
    expect(result.error).toContain('list_dir');
    expect(result.error).toContain('get_file_tree');
    expect(result.error).toContain('write_file');
  });

  it('calls out empty directories explicitly in list_dir results', async () => {
    invokeMock.mockResolvedValue([]);
    const { handleListDir } = await import('./read');

    const result = await handleListDir({ path: '.' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('./ (empty)');
    expect(result.output).toContain('Workspace appears empty');
    expect(result.output).toContain('Scaffold new files');
  });
});
