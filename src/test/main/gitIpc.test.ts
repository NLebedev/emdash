import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcHandleHandlers = new Map<string, (...args: any[]) => any>();
const stageDiffRangeMock = vi.fn();
const unstageDiffRangeMock = vi.fn();
const getFileDiffMock = vi.fn();
const generateCommitMessageMock = vi.fn();

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
  getFileDiff: getFileDiffMock,
  stageFile: vi.fn(),
  stageAllFiles: vi.fn(),
  stageDiffRange: stageDiffRangeMock,
  unstageDiffRange: unstageDiffRangeMock,
  unstageFile: vi.fn(),
  revertFile: vi.fn(),
}));

vi.mock('../../main/services/PrGenerationService', () => ({
  prGenerationService: {
    generatePrContent: vi.fn(),
    generateCommitMessage: generateCommitMessageMock,
  },
}));

vi.mock('../../main/services/DatabaseService', () => ({
  databaseService: {
    getTaskByPath: vi.fn(),
  },
}));

vi.mock('../../main/utils/remoteProjectResolver', () => ({
  resolveRemoteProjectForWorktreePath: vi.fn(async () => null),
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

describe('gitIpc get-file-diff handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    ipcHandleHandlers.clear();
  });

  it('forwards scope to GitService.getFileDiff', async () => {
    getFileDiffMock.mockResolvedValue({ lines: [{ type: 'add', right: 'x' }] });
    const { registerGitIpc } = await import('../../main/ipc/gitIpc');
    registerGitIpc();

    const handler = ipcHandleHandlers.get('git:get-file-diff');
    expect(handler).toBeTypeOf('function');

    const result = await handler!(
      {},
      { taskPath: '/tmp/repo', filePath: 'src/file.ts', scope: 'staged' }
    );

    expect(getFileDiffMock).toHaveBeenCalledWith('/tmp/repo', 'src/file.ts', 'staged');
    expect(result).toEqual({ success: true, diff: { lines: [{ type: 'add', right: 'x' }] } });
  });
});

describe('gitIpc unstage-diff-range handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    ipcHandleHandlers.clear();
  });

  it('calls GitService.unstageDiffRange and returns success payload', async () => {
    unstageDiffRangeMock.mockResolvedValue({ unstaged: true, unstagedHunks: 1 });
    const { registerGitIpc } = await import('../../main/ipc/gitIpc');
    registerGitIpc();

    const handler = ipcHandleHandlers.get('git:unstage-diff-range');
    expect(handler).toBeTypeOf('function');

    const result = await handler!(
      {},
      { taskPath: '/tmp/repo', filePath: 'src/file.ts', startLine: 8, endLine: 8 }
    );

    expect(unstageDiffRangeMock).toHaveBeenCalledWith('/tmp/repo', 'src/file.ts', 8, 8);
    expect(result).toEqual({ success: true, unstaged: true, unstagedHunks: 1 });
  });
});

describe('gitIpc generate-commit-message handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    ipcHandleHandlers.clear();
  });

  it('uses task provider when generating commit message', async () => {
    const { databaseService } = await import('../../main/services/DatabaseService');
    vi.mocked(databaseService.getTaskByPath).mockResolvedValue({
      agentId: 'codex',
    } as any);
    generateCommitMessageMock.mockResolvedValue({
      message: 'feat: add staged commit controls',
      providerId: 'codex',
      source: 'provider',
    });

    const { registerGitIpc } = await import('../../main/ipc/gitIpc');
    registerGitIpc();

    const handler = ipcHandleHandlers.get('git:generate-commit-message');
    expect(handler).toBeTypeOf('function');

    const result = await handler!({}, { taskPath: '/tmp/repo' });

    expect(databaseService.getTaskByPath).toHaveBeenCalledWith('/tmp/repo');
    expect(generateCommitMessageMock).toHaveBeenCalledWith('/tmp/repo', 'codex');
    expect(result).toEqual({
      success: true,
      message: 'feat: add staged commit controls',
      providerId: 'codex',
      source: 'provider',
    });
  });

  it('falls back without provider when task lookup fails', async () => {
    const { databaseService } = await import('../../main/services/DatabaseService');
    vi.mocked(databaseService.getTaskByPath).mockRejectedValue(new Error('lookup failed'));
    generateCommitMessageMock.mockResolvedValue({
      message: 'chore: update staged files',
      source: 'heuristic',
    });

    const { registerGitIpc } = await import('../../main/ipc/gitIpc');
    registerGitIpc();

    const handler = ipcHandleHandlers.get('git:generate-commit-message');
    expect(handler).toBeTypeOf('function');

    const result = await handler!({}, { taskPath: '/tmp/repo' });

    expect(generateCommitMessageMock).toHaveBeenCalledWith('/tmp/repo', null);
    expect(result).toEqual({
      success: true,
      message: 'chore: update staged files',
      source: 'heuristic',
    });
  });
});
