import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execGit as execGitCommand, DEFAULT_GIT_MAX_BUFFER_BYTES } from '../utils/gitExec';
import {
  parseDiffLines,
  stripTrailingNewline,
  MAX_DIFF_CONTENT_BYTES,
  MAX_DIFF_OUTPUT_BYTES,
} from '../utils/diffParser';
import type { DiffLine, DiffResult } from '../utils/diffParser';

const MAX_UNTRACKED_LINECOUNT_BYTES = 512 * 1024;

async function execGit(
  taskPath: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  return execGitCommand(args, taskPath, {
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
  });
}

async function countFileNewlinesCapped(filePath: string, maxBytes: number): Promise<number | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > maxBytes) {
    return null;
  }

  return await new Promise<number | null>((resolve) => {
    let count = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x0a) count++;
      }
    });
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(count));
  });
}

async function readFileTextCapped(filePath: string, maxBytes: number): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > maxBytes) {
    return null;
  }

  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export type GitChange = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isStaged: boolean;
  hasUnstaged: boolean;
  stagedAdditions: number;
  stagedDeletions: number;
  unstagedAdditions: number;
  unstagedDeletions: number;
};

type ParsedDiffHunk = {
  header: string;
  body: string[];
  newStart: number;
  newCount: number;
};

function parseUnifiedDiff(diffText: string): { fileHeaders: string[]; hunks: ParsedDiffHunk[] } {
  const lines = diffText
    .replace(/\r/g, '')
    .split('\n')
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ''));

  const fileHeaders: string[] = [];
  const hunks: ParsedDiffHunk[] = [];
  let i = 0;

  while (i < lines.length && !lines[i].startsWith('@@ ')) {
    fileHeaders.push(lines[i]);
    i++;
  }

  while (i < lines.length) {
    const headerLine = lines[i];
    if (!headerLine.startsWith('@@ ')) {
      i++;
      continue;
    }

    const match = headerLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      i++;
      continue;
    }

    const newStart = Number.parseInt(match[1], 10);
    const newCount = match[2] ? Number.parseInt(match[2], 10) : 1;

    i++;
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith('@@ ')) {
      body.push(lines[i]);
      i++;
    }

    hunks.push({
      header: headerLine,
      body,
      newStart,
      newCount,
    });
  }

  return { fileHeaders, hunks };
}

export async function getStatus(taskPath: string): Promise<GitChange[]> {
  try {
    await execGit(taskPath, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return [];
  }

  const { stdout: statusOutput } = await execGit(taskPath, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);

  if (!statusOutput.trim()) return [];

  const statusLines = statusOutput
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);

  // Parse status lines into file entries
  const entries: Array<{
    filePath: string;
    status: string;
    statusCode: string;
    isStaged: boolean;
  }> = [];

  for (const line of statusLines) {
    const statusCode = line.substring(0, 2);
    let filePath = line.substring(3);
    if (statusCode.includes('R') && filePath.includes('->')) {
      const parts = filePath.split('->');
      filePath = parts[parts.length - 1].trim();
    }

    let status = 'modified';
    if (statusCode.includes('A') || statusCode.includes('?')) status = 'added';
    else if (statusCode.includes('D')) status = 'deleted';
    else if (statusCode.includes('R')) status = 'renamed';
    else if (statusCode.includes('M')) status = 'modified';

    const isStaged = statusCode[0] !== ' ' && statusCode[0] !== '?';
    entries.push({ filePath, status, statusCode, isStaged });
  }

  // Batch: run ONE staged numstat and ONE unstaged numstat for ALL files at once
  const resolveRenamePath = (file: string): string => {
    if (!file.includes(' => ')) return file;
    if (file.includes('{')) {
      return file.replace(/\{[^}]+ => ([^}]+)\}/g, '$1').replace(/\/\//g, '/');
    }
    return file.split(' => ').pop()!.trim();
  };

  const parseNumstatMap = (stdout: string): Map<string, { add: number; del: number }> => {
    const map = new Map<string, { add: number; del: number }>();
    if (!stdout || !stdout.trim()) return map;
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const add = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
        const del = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
        const file = resolveRenamePath(parts.slice(2).join('\t'));
        const existing = map.get(file);
        if (existing) {
          existing.add += add;
          existing.del += del;
        } else {
          map.set(file, { add, del });
        }
      }
    }
    return map;
  };

  const [stagedResult, unstagedResult] = await Promise.all([
    execGit(taskPath, ['diff', '--numstat', '--cached']).catch(() => ({
      stdout: '',
      stderr: '',
    })),
    execGit(taskPath, ['diff', '--numstat']).catch(() => ({
      stdout: '',
      stderr: '',
    })),
  ]);

  const stagedMap = parseNumstatMap(stagedResult.stdout);
  const unstagedMap = parseNumstatMap(unstagedResult.stdout);

  // Count lines for untracked files in parallel
  const untrackedEntries = entries.filter(
    (e) => e.statusCode.includes('?') && !stagedMap.has(e.filePath) && !unstagedMap.has(e.filePath)
  );
  const untrackedCounts = await Promise.all(
    untrackedEntries.map((e) =>
      countFileNewlinesCapped(path.join(taskPath, e.filePath), MAX_UNTRACKED_LINECOUNT_BYTES)
    )
  );
  const untrackedMap = new Map<string, number>();
  untrackedEntries.forEach((e, i) => {
    if (typeof untrackedCounts[i] === 'number') {
      untrackedMap.set(e.filePath, untrackedCounts[i]!);
    }
  });

  // Assemble results
  const changes: GitChange[] = entries.map((e) => {
    const staged = stagedMap.get(e.filePath);
    const unstaged = unstagedMap.get(e.filePath);

    const stagedAdditions = staged?.add ?? 0;
    const stagedDeletions = staged?.del ?? 0;
    const unstagedAdditions =
      unstaged?.add ?? (e.statusCode.includes('?') ? (untrackedMap.get(e.filePath) ?? 0) : 0);
    const unstagedDeletions = unstaged?.del ?? 0;

    return {
      path: e.filePath,
      status: e.status,
      additions: stagedAdditions + unstagedAdditions,
      deletions: stagedDeletions + unstagedDeletions,
      isStaged: e.isStaged,
      hasUnstaged: e.statusCode[1] !== ' ',
      stagedAdditions,
      stagedDeletions,
      unstagedAdditions,
      unstagedDeletions,
    };
  });

  return changes;
}

export async function stageFile(taskPath: string, filePath: string): Promise<void> {
  await execGit(taskPath, ['add', '--', filePath]);
}

export async function stageAllFiles(taskPath: string): Promise<void> {
  await execGit(taskPath, ['add', '-A']);
}

type DiffRangeScope = 'staged' | 'unstaged';

type ApplyDiffRangeResult = { applied: boolean; hunks: number };

async function applyDiffRangeToIndex(
  taskPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
  scope: DiffRangeScope,
  reverse: boolean
): Promise<ApplyDiffRangeResult> {
  const normalizedStart = Math.max(1, Math.min(startLine, endLine));
  const normalizedEnd = Math.max(1, Math.max(startLine, endLine));
  const diffArgs =
    scope === 'staged'
      ? ['diff', '--cached', '--no-color', '--no-ext-diff', '--unified=0', '--', filePath]
      : ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--', filePath];

  const { stdout: rawDiff } = await execGit(taskPath, diffArgs);

  if (!rawDiff.trim()) {
    return { applied: false, hunks: 0 };
  }

  const { fileHeaders, hunks } = parseUnifiedDiff(rawDiff);
  if (hunks.length === 0) {
    return { applied: false, hunks: 0 };
  }

  const selectedHunks = hunks.filter((hunk) => {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newCount > 0 ? hunk.newStart + hunk.newCount - 1 : hunk.newStart;
    return normalizedEnd >= hunkStart && normalizedStart <= hunkEnd;
  });

  if (selectedHunks.length === 0) {
    return { applied: false, hunks: 0 };
  }

  const patchLines = [...fileHeaders];
  for (const hunk of selectedHunks) {
    patchLines.push(hunk.header, ...hunk.body);
  }
  const patchContent = `${patchLines.join('\n')}\n`;

  const tempPatchPath = path.join(
    os.tmpdir(),
    `emdash-stage-range-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`
  );

  try {
    await fs.promises.writeFile(tempPatchPath, patchContent, 'utf8');
    const applyArgs = ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'];
    if (reverse) {
      applyArgs.push('--reverse');
    }
    applyArgs.push(tempPatchPath);
    await execGit(taskPath, applyArgs);
  } finally {
    try {
      await fs.promises.unlink(tempPatchPath);
    } catch {
      // best effort cleanup
    }
  }

  return { applied: true, hunks: selectedHunks.length };
}

export async function stageDiffRange(
  taskPath: string,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<{ staged: boolean; stagedHunks: number }> {
  const result = await applyDiffRangeToIndex(
    taskPath,
    filePath,
    startLine,
    endLine,
    'unstaged',
    false
  );
  return { staged: result.applied, stagedHunks: result.hunks };
}

export async function unstageDiffRange(
  taskPath: string,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<{ unstaged: boolean; unstagedHunks: number }> {
  const result = await applyDiffRangeToIndex(
    taskPath,
    filePath,
    startLine,
    endLine,
    'staged',
    true
  );
  return { unstaged: result.applied, unstagedHunks: result.hunks };
}

export async function unstageFile(taskPath: string, filePath: string): Promise<void> {
  try {
    await execGit(taskPath, ['reset', 'HEAD', '--', filePath]);
  } catch {
    // HEAD may not exist (no commits yet) - use rm --cached instead
    await execGit(taskPath, ['rm', '--cached', '--', filePath]);
  }
}

export async function revertFile(
  taskPath: string,
  filePath: string
): Promise<{ action: 'unstaged' | 'reverted' }> {
  // Validate filePath doesn't escape the worktree
  const absPath = path.resolve(taskPath, filePath);
  const resolvedTaskPath = path.resolve(taskPath);
  if (!absPath.startsWith(resolvedTaskPath + path.sep) && absPath !== resolvedTaskPath) {
    throw new Error('File path is outside the worktree');
  }

  // Check if file is staged
  try {
    const { stdout: stagedStatus } = await execGit(taskPath, [
      'diff',
      '--cached',
      '--name-only',
      '--',
      filePath,
    ]);

    if (stagedStatus.trim()) {
      // File is staged, unstage it (but keep working directory changes)
      await unstageFile(taskPath, filePath);
      return { action: 'unstaged' };
    }
  } catch {}

  // Check if file is tracked in git (exists in HEAD)
  let fileExistsInHead = false;
  try {
    await execGit(taskPath, ['cat-file', '-e', `HEAD:${filePath}`]);
    fileExistsInHead = true;
  } catch {
    // File doesn't exist in HEAD (it's a new/untracked file), delete it
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
    return { action: 'reverted' };
  }

  // File exists in HEAD, revert it
  if (fileExistsInHead) {
    try {
      await execGit(taskPath, ['checkout', 'HEAD', '--', filePath]);
    } catch (error) {
      throw new Error(
        `Failed to revert file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { action: 'reverted' };
}

export type GitDiffScope = 'all' | 'staged' | 'unstaged';

export async function getFileDiff(
  taskPath: string,
  filePath: string,
  scope: GitDiffScope = 'all'
): Promise<DiffResult> {
  const absPath = path.resolve(taskPath, filePath);
  const resolvedTaskPath = path.resolve(taskPath);
  if (!absPath.startsWith(resolvedTaskPath + path.sep) && absPath !== resolvedTaskPath) {
    throw new Error('File path is outside the worktree');
  }

  const getContentAt = async (ref: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execGit(taskPath, ['show', `${ref}:${filePath}`], {
        maxBuffer: MAX_DIFF_CONTENT_BYTES,
      });
      return stripTrailingNewline(stdout);
    } catch {
      return undefined;
    }
  };

  const getDiskContent = async (): Promise<string | undefined> => {
    const content = await readFileTextCapped(path.join(taskPath, filePath), MAX_DIFF_CONTENT_BYTES);
    return content !== null ? stripTrailingNewline(content) : undefined;
  };

  const diffArgs: string[] = ['diff', '--no-color', '--unified=2000'];
  let originalRef: string | undefined;
  let modifiedRef: string | undefined;

  if (scope === 'staged') {
    diffArgs.push('--cached', '--', filePath);
    originalRef = 'HEAD';
    modifiedRef = ''; // index
  } else if (scope === 'unstaged') {
    diffArgs.push('--', filePath);
    originalRef = ''; // index
    modifiedRef = 'disk';
  } else {
    diffArgs.push('HEAD', '--', filePath);
    originalRef = 'HEAD';
    modifiedRef = 'disk';
  }

  let diffStdout: string | undefined;
  try {
    const { stdout } = await execGit(taskPath, diffArgs, { maxBuffer: MAX_DIFF_OUTPUT_BYTES });
    diffStdout = stdout;
  } catch {
    // fallback to content-only
  }

  if (diffStdout !== undefined) {
    const { lines, isBinary } = parseDiffLines(diffStdout);
    if (isBinary) return { lines: [], isBinary: true };

    const [originalContent, modifiedContent] = await Promise.all([
      originalRef === ''
        ? getContentAt('')
        : originalRef === 'HEAD'
          ? getContentAt('HEAD')
          : Promise.resolve(undefined),
      modifiedRef === ''
        ? getContentAt('')
        : modifiedRef === 'disk'
          ? getDiskContent()
          : Promise.resolve(undefined),
    ]);

    if (lines.length === 0) {
      if (modifiedContent !== undefined) {
        return {
          lines: modifiedContent.split('\n').map((l) => ({ right: l, type: 'add' as const })),
          modifiedContent,
        };
      }
      if (originalContent !== undefined) {
        return {
          lines: originalContent.split('\n').map((l) => ({ left: l, type: 'del' as const })),
          originalContent,
        };
      }
      return { lines: [] };
    }
    return { lines, originalContent, modifiedContent };
  }

  const [originalContent, modifiedContent] = await Promise.all([
    originalRef === ''
      ? getContentAt('')
      : originalRef === 'HEAD'
        ? getContentAt('HEAD')
        : Promise.resolve(undefined),
    modifiedRef === ''
      ? getContentAt('')
      : modifiedRef === 'disk'
        ? getDiskContent()
        : Promise.resolve(undefined),
  ]);

  if (modifiedContent !== undefined) {
    return {
      lines: modifiedContent.split('\n').map((l) => ({ right: l, type: 'add' as const })),
      originalContent,
      modifiedContent,
    };
  }
  if (originalContent !== undefined) {
    return {
      lines: originalContent.split('\n').map((l) => ({ left: l, type: 'del' as const })),
      originalContent,
    };
  }
  return { lines: [] };
}

/** Commit staged files (no push). Returns the commit hash. */
export async function commit(taskPath: string, message: string): Promise<{ hash: string }> {
  if (!message || !message.trim()) {
    throw new Error('Commit message cannot be empty');
  }
  await execGit(taskPath, ['commit', '-m', message]);
  const { stdout } = await execGit(taskPath, ['rev-parse', 'HEAD']);
  return { hash: stdout.trim() };
}

/** Push current branch to origin. Sets upstream if needed. */
export async function push(taskPath: string): Promise<{ output: string }> {
  try {
    const { stdout } = await execGit(taskPath, ['push']);
    return { output: stdout.trim() };
  } catch (error: any) {
    const stderr = error?.stderr || '';
    if (stderr.includes('has no upstream branch') || stderr.includes('no upstream configured')) {
      const { stdout: branch } = await execGit(taskPath, ['branch', '--show-current']);
      const { stdout } = await execGit(taskPath, [
        'push',
        '--set-upstream',
        'origin',
        branch.trim(),
      ]);
      return { output: stdout.trim() };
    }
    throw error;
  }
}

/** Pull from remote. */
export async function pull(taskPath: string): Promise<{ output: string }> {
  const { stdout } = await execGit(taskPath, ['pull']);
  return { output: stdout.trim() };
}

/** Get commit log for the current branch. */
export async function getLog(
  taskPath: string,
  maxCount: number = 50,
  skip: number = 0,
  knownAheadCount?: number
): Promise<{
  commits: Array<{
    hash: string;
    subject: string;
    body: string;
    author: string;
    authorEmail: string;
    date: string;
    isPushed: boolean;
    tags: string[];
  }>;
  aheadCount: number;
}> {
  let aheadCount = knownAheadCount ?? -1;
  if (aheadCount < 0) {
    aheadCount = 0;
    try {
      const { stdout: countOut } = await execGit(taskPath, [
        'rev-list',
        '--count',
        '@{upstream}..HEAD',
      ]);
      aheadCount = Number.parseInt(countOut.trim(), 10) || 0;
    } catch {
      try {
        const { stdout: branchOut } = await execGit(taskPath, [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ]);
        const currentBranch = branchOut.trim();
        const { stdout: countOut } = await execGit(taskPath, [
          'rev-list',
          '--count',
          `origin/${currentBranch}..HEAD`,
        ]);
        aheadCount = Number.parseInt(countOut.trim(), 10) || 0;
      } catch {
        try {
          const { stdout: defaultBranchOut } = await execGit(taskPath, [
            'symbolic-ref',
            '--short',
            'refs/remotes/origin/HEAD',
          ]);
          const defaultBranch = defaultBranchOut.trim();
          const { stdout: countOut } = await execGit(taskPath, [
            'rev-list',
            '--count',
            `${defaultBranch}..HEAD`,
          ]);
          aheadCount = Number.parseInt(countOut.trim(), 10) || 0;
        } catch {
          aheadCount = 0;
        }
      }
    }
  }

  const FIELD_SEP = '---FIELD_SEP---';
  const RECORD_SEP = '---RECORD_SEP---';
  const format = `${RECORD_SEP}%H${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%D${FIELD_SEP}%ae${FIELD_SEP}%b`;
  const { stdout } = await execGit(taskPath, [
    'log',
    `--max-count=${maxCount}`,
    `--skip=${skip}`,
    `--pretty=format:${format}`,
    '--',
  ]);

  if (!stdout.trim()) return { commits: [], aheadCount };

  const commits = stdout
    .split(RECORD_SEP)
    .filter((entry) => entry.trim())
    .map((entry, index) => {
      const parts = entry.trim().split(FIELD_SEP);
      const refs = parts[4] || '';
      const tags = refs
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.startsWith('tag: '))
        .map((r) => r.slice(5));
      return {
        hash: parts[0] || '',
        subject: parts[1] || '',
        body: (parts[6] || '').trim(),
        author: parts[2] || '',
        authorEmail: parts[5] || '',
        date: parts[3] || '',
        isPushed: skip + index >= aheadCount,
        tags,
      };
    });

  return { commits, aheadCount };
}

/** Get the latest commit info (subject + body). */
export async function getLatestCommit(
  taskPath: string
): Promise<{ hash: string; subject: string; body: string; isPushed: boolean } | null> {
  const { commits } = await getLog(taskPath, 1);
  return commits[0] || null;
}

/** Get files changed in a specific commit. */
export async function getCommitFiles(
  taskPath: string,
  commitHash: string
): Promise<Array<{ path: string; status: string; additions: number; deletions: number }>> {
  const { stdout } = await execGit(taskPath, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '-m',
    '--first-parent',
    '--numstat',
    commitHash,
  ]);

  const { stdout: nameStatus } = await execGit(taskPath, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '-m',
    '--first-parent',
    '--name-status',
    commitHash,
  ]);

  const statLines = stdout.trim().split('\n').filter(Boolean);
  const statusLines = nameStatus.trim().split('\n').filter(Boolean);

  const statusMap = new Map<string, string>();
  for (const line of statusLines) {
    const [code, ...pathParts] = line.split('\t');
    const filePath = pathParts[pathParts.length - 1] || '';
    const status =
      code === 'A'
        ? 'added'
        : code === 'D'
          ? 'deleted'
          : code?.startsWith('R')
            ? 'renamed'
            : 'modified';
    statusMap.set(filePath, status);
  }

  return statLines.map((line) => {
    const [addStr, delStr, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    return {
      path: filePath,
      status: statusMap.get(filePath) || 'modified',
      additions: addStr === '-' ? 0 : Number.parseInt(addStr || '0', 10) || 0,
      deletions: delStr === '-' ? 0 : Number.parseInt(delStr || '0', 10) || 0,
    };
  });
}

/** Get diff for a specific file in a specific commit. */
export async function getCommitFileDiff(
  taskPath: string,
  commitHash: string,
  filePath: string
): Promise<DiffResult> {
  const absPath = path.resolve(taskPath, filePath);
  const resolvedTaskPath = path.resolve(taskPath);
  if (!absPath.startsWith(resolvedTaskPath + path.sep) && absPath !== resolvedTaskPath) {
    throw new Error('File path is outside the worktree');
  }

  const getContentAt = async (ref: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execGit(taskPath, ['show', `${ref}:${filePath}`], {
        maxBuffer: MAX_DIFF_CONTENT_BYTES,
      });
      return stripTrailingNewline(stdout);
    } catch {
      return undefined;
    }
  };

  let hasParent = true;
  try {
    await execGit(taskPath, ['rev-parse', '--verify', `${commitHash}~1`]);
  } catch {
    hasParent = false;
  }

  if (!hasParent) {
    const modifiedContent = await getContentAt(commitHash);
    if (modifiedContent === undefined) {
      return { lines: [] };
    }
    if (modifiedContent === '') {
      return { lines: [], modifiedContent };
    }
    return {
      lines: modifiedContent.split('\n').map((l) => ({ right: l, type: 'add' as const })),
      modifiedContent,
    };
  }

  let diffStdout: string | undefined;
  try {
    const { stdout } = await execGit(
      taskPath,
      ['diff', '--no-color', '--unified=2000', `${commitHash}~1`, commitHash, '--', filePath],
      { maxBuffer: MAX_DIFF_OUTPUT_BYTES }
    );
    diffStdout = stdout;
  } catch {
    // too large
  }

  let diffLines: DiffLine[] = [];
  if (diffStdout !== undefined) {
    const { lines, isBinary } = parseDiffLines(diffStdout);
    if (isBinary) {
      return { lines: [], isBinary: true };
    }
    diffLines = lines;
  }

  const [originalContent, modifiedContent] = await Promise.all([
    getContentAt(`${commitHash}~1`),
    getContentAt(commitHash),
  ]);

  if (diffLines.length > 0) return { lines: diffLines, originalContent, modifiedContent };

  if (modifiedContent !== undefined && modifiedContent !== '') {
    return {
      lines: modifiedContent.split('\n').map((l) => ({ right: l, type: 'add' as const })),
      originalContent,
      modifiedContent,
    };
  }
  if (originalContent !== undefined) {
    return {
      lines: originalContent.split('\n').map((l) => ({ left: l, type: 'del' as const })),
      originalContent,
      modifiedContent,
    };
  }
  return { lines: [], originalContent, modifiedContent };
}

/** Soft-reset the latest commit. Returns the commit message that was reset. */
export async function softResetLastCommit(
  taskPath: string
): Promise<{ subject: string; body: string }> {
  try {
    await execGit(taskPath, ['rev-parse', '--verify', 'HEAD~1']);
  } catch {
    throw new Error('Cannot undo the initial commit');
  }

  const { commits: log } = await getLog(taskPath, 1);
  if (log[0]?.isPushed) {
    throw new Error('Cannot undo a commit that has already been pushed');
  }

  const { stdout: subject } = await execGit(taskPath, ['log', '-1', '--pretty=format:%s']);
  const { stdout: body } = await execGit(taskPath, ['log', '-1', '--pretty=format:%b']);

  await execGit(taskPath, ['reset', '--soft', 'HEAD~1']);

  return { subject: subject.trim(), body: body.trim() };
}
