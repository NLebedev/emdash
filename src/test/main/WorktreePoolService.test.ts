import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name) => path.join(os.tmpdir(), `emdash-test-${name}`)),
    getAppPath: vi.fn(() => process.cwd()),
  },
}));

import { WorktreePoolService } from '../../main/services/WorktreePoolService';

describe('WorktreePoolService', () => {
  let tempDir: string;
  let projectPath: string;
  let pool: WorktreePoolService;

  const initRepo = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    execSync('git init', { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test User"', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), 'test');
    execSync('git add README.md', { cwd: dir });
    execSync('git commit -m "initial commit"', { cwd: dir });
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-test-'));
    projectPath = path.join(tempDir, 'project');
    initRepo(projectPath);
    process.env.EMDASH_DB_FILE = path.join(tempDir, 'test.db');
    pool = new WorktreePoolService();
    // Disable background replenish for tests to avoid race conditions
    (pool as any).replenishReserve = () => {};
  });

  afterEach(async () => {
    await pool.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.EMDASH_DB_FILE;
  });

  it('creates and claims a reserve worktree', async () => {
    await pool.ensureReserve('project-1', projectPath, 'HEAD');
    expect(pool.hasReserve('project-1')).toBe(true);

    const reserve = pool.getReserve('project-1');
    expect(reserve).toBeDefined();
    expect(fs.existsSync(reserve!.path)).toBe(true);

    const result = await pool.claimReserve('project-1', projectPath, 'Feature Task', 'HEAD');
    expect(result).not.toBeNull();
    expect(result!.worktree.name).toBe('Feature Task');
    expect(fs.existsSync(result!.worktree.path)).toBe(true);
    expect(pool.hasReserve('project-1')).toBe(false);
  });

  it('handles claiming when no reserve exists', async () => {
    const result = await pool.claimReserve('project-1', projectPath, 'Feature Task', 'HEAD');
    expect(result).toBeNull();
  });

  it('cleans up reserves on shutdown', async () => {
    await pool.ensureReserve('project-1', projectPath, 'HEAD');
    const reserve = pool.getReserve('project-1');
    await pool.cleanup();
    expect(fs.existsSync(reserve!.path)).toBe(false);
  });

  it('preserves project files during transformation', async () => {
    // Create a .env file in project
    fs.writeFileSync(path.join(projectPath, '.env'), 'SECRET=123');

    await pool.ensureReserve('project-1', projectPath, 'HEAD');
    const result = await pool.claimReserve('project-1', projectPath, 'Feature Task', 'HEAD');

    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(result!.worktree.path, '.env'))).toBe(true);
    expect(fs.readFileSync(path.join(result!.worktree.path, '.env'), 'utf8')).toBe('SECRET=123');
  });

  it('creates a reserve with custom .emdash.json settings', async () => {
    // Create a file that should be preserved via custom pattern
    const customDir = path.join(projectPath, 'custom-config');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'settings.json'), '{"test":true}');

    const config = {
      preservePatterns: ['custom-config/**'],
    };
    fs.writeFileSync(path.join(projectPath, '.emdash.json'), JSON.stringify(config));

    await pool.ensureReserve('project-1', projectPath, 'HEAD');
    const result = await pool.claimReserve('project-1', projectPath, 'Feature Task', 'HEAD');

    expect(result).not.toBeNull();
    const preservedPath = path.join(result!.worktree.path, 'custom-config/settings.json');
    expect(fs.existsSync(preservedPath)).toBe(true);
    expect(fs.readFileSync(preservedPath, 'utf8')).toBe('{"test":true}');
  });

  it('creates a reserve even when PATH is oversized', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = `${'x'.repeat(1_600_000)}:/usr/bin:/bin`;
    try {
      await pool.ensureReserve('project-oversized-path', projectPath, 'HEAD');
      expect(pool.hasReserve('project-oversized-path')).toBe(true);
    } finally {
      if (typeof originalPath === 'string') {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
    }
  });

  it('removes reserve artifacts from disk even when in-memory state was lost', async () => {
    await pool.ensureReserve('project-1', projectPath, 'HEAD');
    const reserve = pool.getReserve('project-1');
    expect(reserve).toBeDefined();

    const restartedPool = new WorktreePoolService();
    await restartedPool.removeReserve('project-1', projectPath);

    expect(fs.existsSync(reserve!.path)).toBe(false);
    const branchOutput = execSync('git branch --list "_reserve/*"', {
      cwd: projectPath,
      stdio: 'pipe',
    }).toString();
    expect(branchOutput.trim()).toBe('');
  });

  it('does not remove reserve worktrees owned by a different repository', async () => {
    const otherProjectPath = path.join(tempDir, 'other-project');
    initRepo(otherProjectPath);

    const otherPool = new WorktreePoolService();
    (otherPool as any).replenishReserve = () => {};

    await pool.ensureReserve('project-1', projectPath, 'HEAD');
    await otherPool.ensureReserve('project-2', otherProjectPath, 'HEAD');

    const otherReserve = otherPool.getReserve('project-2');
    expect(otherReserve).toBeDefined();

    const restartedPool = new WorktreePoolService();
    await restartedPool.removeReserve('project-1', projectPath);

    expect(fs.existsSync(otherReserve!.path)).toBe(true);
    const otherBranches = execSync('git branch --list "_reserve/*"', {
      cwd: otherProjectPath,
      stdio: 'pipe',
    }).toString();
    expect(otherBranches).toContain(otherReserve!.branch);

    await otherPool.cleanup();
  });

  it('resolves owner repo path correctly when repo path contains a worktrees segment', async () => {
    const nestedProjectPath = path.join(tempDir, 'worktrees', 'nested-project');
    initRepo(nestedProjectPath);

    const nestedPool = new WorktreePoolService();
    (nestedPool as any).replenishReserve = () => {};
    await nestedPool.ensureReserve('project-nested', nestedProjectPath, 'HEAD');

    const reserve = nestedPool.getReserve('project-nested');
    expect(reserve).toBeDefined();

    const ownerPath = (nestedPool as any).getMainRepoPathFromWorktree(reserve!.path);
    expect(ownerPath).toBeDefined();
    expect(fs.realpathSync(ownerPath)).toBe(fs.realpathSync(nestedProjectPath));

    await nestedPool.cleanup();
  });
});
