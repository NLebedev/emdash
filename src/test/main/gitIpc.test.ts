import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcHandleHandlers = new Map<string, (...args: any[]) => any>();
const stageDiffRangeMock = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn((channel: string, cb: (...args: any[]) => any) => {
      ipcHandleHandlers.set(channel, cb);
    }),
  },
}));

vi.mock('../../main/services/GitService', () => ({
  getStatus: vi.fn(),
  getFileDiff: vi.fn(),
  stageFile: vi.fn(),
  stageAllFiles: vi.fn(),
  stageDiffRange: stageDiffRangeMock,
  unstageFile: vi.fn(),
  revertFile: vi.fn(),
}));

vi.mock('../../main/services/PrGenerationService', () => ({
  prGenerationService: {
    generatePrContent: vi.fn(),
  },
}));

vi.mock('../../main/services/DatabaseService', () => ({
  databaseService: {
    getTaskByPath: vi.fn(),
  },
}));

vi.mock('../../main/lib/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('gitIpc stage-diff-range handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    ipcHandleHandlers.clear();
  });

  it('calls GitService.stageDiffRange and returns success payload', async () => {
    stageDiffRangeMock.mockResolvedValue({ staged: true, stagedHunks: 1 });
    const { registerGitIpc } = await import('../../main/ipc/gitIpc');
    registerGitIpc();

    const handler = ipcHandleHandlers.get('git:stage-diff-range');
    expect(handler).toBeTypeOf('function');

    const result = await handler!(
      {},
      { taskPath: '/tmp/repo', filePath: 'src/file.ts', startLine: 12, endLine: 12 }
    );

    expect(stageDiffRangeMock).toHaveBeenCalledWith('/tmp/repo', 'src/file.ts', 12, 12);
    expect(result).toEqual({ success: true, staged: true, stagedHunks: 1 });
  });

  it('returns error payload when GitService.stageDiffRange throws', async () => {
    stageDiffRangeMock.mockRejectedValue(new Error('stage range failed'));
    const { registerGitIpc } = await import('../../main/ipc/gitIpc');
    registerGitIpc();

    const handler = ipcHandleHandlers.get('git:stage-diff-range');
    expect(handler).toBeTypeOf('function');

    const result = await handler!(
      {},
      { taskPath: '/tmp/repo', filePath: 'src/file.ts', startLine: 3, endLine: 5 }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('stage range failed');
  });
});
