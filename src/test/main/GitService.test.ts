import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { getStatus, stageDiffRange } from '../../main/services/GitService';

function runGit(repoPath: string, command: string): string {
  return execSync(command, { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' }).trim();
}

const BASE_FILE_CONTENT = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join(
  '\n'
);

const MODIFIED_FILE_CONTENT = [
  'one',
  'two-mod',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight-mod',
  'nine',
  'ten',
].join('\n');

describe('GitService stageDiffRange', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-service-test-'));
    runGit(repoPath, 'git init');
    runGit(repoPath, 'git config user.email "test@example.com"');
    runGit(repoPath, 'git config user.name "Test User"');

    fs.writeFileSync(path.join(repoPath, 'sample.txt'), BASE_FILE_CONTENT);
    runGit(repoPath, 'git add sample.txt');
    runGit(repoPath, 'git commit -m "initial"');
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('stages only the selected hunk for a modified file', async () => {
    fs.writeFileSync(path.join(repoPath, 'sample.txt'), MODIFIED_FILE_CONTENT);

    const result = await stageDiffRange(repoPath, 'sample.txt', 2, 2);

    expect(result).toEqual({ staged: true, stagedHunks: 1 });

    const cachedDiff = runGit(repoPath, 'git diff --cached -- sample.txt');
    const unstagedDiff = runGit(repoPath, 'git diff -- sample.txt');
    const status = await getStatus(repoPath);

    expect(cachedDiff).toContain('+two-mod');
    expect(cachedDiff).not.toContain('+eight-mod');
    expect(unstagedDiff).toContain('+eight-mod');
    expect(unstagedDiff).not.toContain('+two-mod');

    expect(status).toHaveLength(1);
    expect(status[0].path).toBe('sample.txt');
    expect(status[0].isStaged).toBe(true);
    expect(status[0].hasUnstaged).toBe(true);
  });

  it('stages all matching hunks when range overlaps multiple hunks', async () => {
    fs.writeFileSync(path.join(repoPath, 'sample.txt'), MODIFIED_FILE_CONTENT);

    const result = await stageDiffRange(repoPath, 'sample.txt', 1, 10);

    expect(result).toEqual({ staged: true, stagedHunks: 2 });

    const cachedDiff = runGit(repoPath, 'git diff --cached -- sample.txt');
    const unstagedDiff = runGit(repoPath, 'git diff -- sample.txt');
    const status = await getStatus(repoPath);

    expect(cachedDiff).toContain('+two-mod');
    expect(cachedDiff).toContain('+eight-mod');
    expect(unstagedDiff).toBe('');

    expect(status).toHaveLength(1);
    expect(status[0].isStaged).toBe(true);
    expect(status[0].hasUnstaged).toBe(false);
  });

  it('returns not staged when selected range does not overlap any hunk', async () => {
    fs.writeFileSync(path.join(repoPath, 'sample.txt'), MODIFIED_FILE_CONTENT);

    const result = await stageDiffRange(repoPath, 'sample.txt', 4, 4);

    expect(result).toEqual({ staged: false, stagedHunks: 0 });
    expect(runGit(repoPath, 'git diff --cached -- sample.txt')).toBe('');
    expect(runGit(repoPath, 'git diff -- sample.txt')).not.toBe('');
  });

  it('returns not staged when file has no unstaged diff', async () => {
    const result = await stageDiffRange(repoPath, 'sample.txt', 1, 1);
    expect(result).toEqual({ staged: false, stagedHunks: 0 });
  });
});
