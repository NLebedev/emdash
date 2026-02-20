import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_LINECOUNT_BYTES = 512 * 1024;
const MAX_UNTRACKED_DIFF_BYTES = 512 * 1024;

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
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: taskPath,
    });
  } catch {
    return [];
  }

  const { stdout: statusOutput } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    {
      cwd: taskPath,
    }
  );

  if (!statusOutput.trim()) return [];

  const changes: GitChange[] = [];
  const statusLines = statusOutput
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);

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

    const indexStatus = statusCode[0] ?? ' ';
    const worktreeStatus = statusCode[1] ?? ' ';

    // First character is index (staged), second is working tree (unstaged)
    const isStaged = indexStatus !== ' ' && indexStatus !== '?';
    const hasUnstaged = worktreeStatus !== ' ';
    let stagedAdditions = 0;
    let stagedDeletions = 0;
    let unstagedAdditions = 0;
    let unstagedDeletions = 0;

    const parseNumstat = (stdout: string) => {
      let additions = 0;
      let deletions = 0;
      const lines = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      for (const l of lines) {
        const p = l.split('\t');
        if (p.length >= 2) {
          const addStr = p[0];
          const delStr = p[1];
          const a = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
          const d = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
          additions += a;
          deletions += d;
        }
      }
      return { additions, deletions };
    };

    try {
      const staged = await execFileAsync('git', ['diff', '--numstat', '--cached', '--', filePath], {
        cwd: taskPath,
      });
      if (staged.stdout && staged.stdout.trim()) {
        const parsed = parseNumstat(staged.stdout);
        stagedAdditions = parsed.additions;
        stagedDeletions = parsed.deletions;
      }
    } catch {}

    try {
      const unstaged = await execFileAsync('git', ['diff', '--numstat', '--', filePath], {
        cwd: taskPath,
      });
      if (unstaged.stdout && unstaged.stdout.trim()) {
        const parsed = parseNumstat(unstaged.stdout);
        unstagedAdditions = parsed.additions;
        unstagedDeletions = parsed.deletions;
      }
    } catch {}

    let additions = stagedAdditions + unstagedAdditions;
    const deletions = stagedDeletions + unstagedDeletions;

    if (additions === 0 && deletions === 0 && statusCode.includes('?')) {
      const absPath = path.join(taskPath, filePath);
      const count = await countFileNewlinesCapped(absPath, MAX_UNTRACKED_LINECOUNT_BYTES);
      if (typeof count === 'number') {
        additions = count;
        unstagedAdditions = count;
      }
    }

    changes.push({
      path: filePath,
      status,
      additions,
      deletions,
      isStaged,
      hasUnstaged,
      stagedAdditions,
      stagedDeletions,
      unstagedAdditions,
      unstagedDeletions,
    });
  }

  return changes;
}

export async function stageFile(taskPath: string, filePath: string): Promise<void> {
  await execFileAsync('git', ['add', '--', filePath], { cwd: taskPath });
}

export async function stageAllFiles(taskPath: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: taskPath });
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

  const { stdout: rawDiff } = await execFileAsync(
    'git',
    diffArgs,
    { cwd: taskPath }
  );

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
    await execFileAsync(
      'git',
      applyArgs,
      { cwd: taskPath }
    );
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
  const result = await applyDiffRangeToIndex(taskPath, filePath, startLine, endLine, 'staged', true);
  return { unstaged: result.applied, unstagedHunks: result.hunks };
}

export async function unstageFile(taskPath: string, filePath: string): Promise<void> {
  await execFileAsync('git', ['reset', 'HEAD', '--', filePath], { cwd: taskPath });
}

export async function revertFile(
  taskPath: string,
  filePath: string
): Promise<{ action: 'unstaged' | 'reverted' }> {
  // Check if file is staged
  try {
    const { stdout: stagedStatus } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only', '--', filePath],
      {
        cwd: taskPath,
      }
    );

    if (stagedStatus.trim()) {
      // File is staged, unstage it (but keep working directory changes)
      await execFileAsync('git', ['reset', 'HEAD', '--', filePath], { cwd: taskPath });
      return { action: 'unstaged' };
    }
  } catch {}

  // Check if file is tracked in git (exists in HEAD)
  let fileExistsInHead = false;
  try {
    await execFileAsync('git', ['cat-file', '-e', `HEAD:${filePath}`], { cwd: taskPath });
    fileExistsInHead = true;
  } catch {
    // File doesn't exist in HEAD (it's a new/untracked file), delete it
    const absPath = path.join(taskPath, filePath);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
    return { action: 'reverted' };
  }

  // File exists in HEAD, revert it
  if (fileExistsInHead) {
    try {
      await execFileAsync('git', ['checkout', 'HEAD', '--', filePath], { cwd: taskPath });
    } catch (error) {
      // If checkout fails, don't delete the file - throw the error instead
      throw new Error(
        `Failed to revert file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { action: 'reverted' };
}

export type GitDiffScope = 'all' | 'staged' | 'unstaged';

type GitDiffLine = { left?: string; right?: string; type: 'context' | 'add' | 'del' };

function parseDiffOutput(stdout: string): GitDiffLine[] {
  const linesRaw = stdout.split('\n');
  const result: GitDiffLine[] = [];

  for (const line of linesRaw) {
    if (!line) continue;
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@')
    ) {
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === ' ') result.push({ left: content, right: content, type: 'context' });
    else if (prefix === '-') result.push({ left: content, type: 'del' });
    else if (prefix === '+') result.push({ right: content, type: 'add' });
    else result.push({ left: line, right: line, type: 'context' });
  }

  return result;
}

function toAddedLines(content: string): GitDiffLine[] {
  return content.split('\n').map((line) => ({ right: line, type: 'add' as const }));
}

function toDeletedLines(content: string): GitDiffLine[] {
  return content.split('\n').map((line) => ({ left: line, type: 'del' as const }));
}

function getDiffArgs(filePath: string, scope: GitDiffScope): string[] {
  if (scope === 'staged') {
    return ['diff', '--cached', '--no-color', '--unified=2000', '--', filePath];
  }
  if (scope === 'unstaged') {
    return ['diff', '--no-color', '--unified=2000', '--', filePath];
  }
  return ['diff', '--no-color', '--unified=2000', 'HEAD', '--', filePath];
}

export async function getFileDiff(
  taskPath: string,
  filePath: string,
  scope: GitDiffScope = 'all'
): Promise<{ lines: GitDiffLine[] }> {
  try {
    const { stdout } = await execFileAsync('git', getDiffArgs(filePath, scope), {
      cwd: taskPath,
    });
    const parsed = parseDiffOutput(stdout);
    if (parsed.length > 0) {
      return { lines: parsed };
    }
  } catch {
    // Fall through to scope-specific recovery paths.
  }

  if (scope !== 'staged') {
    const absPath = path.join(taskPath, filePath);
    const currentContent = await readFileTextCapped(absPath, MAX_UNTRACKED_DIFF_BYTES);
    if (currentContent !== null) {
      return { lines: toAddedLines(currentContent) };
    }
  }

  if (scope === 'unstaged') {
    try {
      const { stdout: indexContent } = await execFileAsync('git', ['show', `:${filePath}`], {
        cwd: taskPath,
      });
      return { lines: toDeletedLines(indexContent) };
    } catch {
      return { lines: [] };
    }
  }

  if (scope === 'staged') {
    try {
      const { stdout: indexContent } = await execFileAsync('git', ['show', `:${filePath}`], {
        cwd: taskPath,
      });
      try {
        await execFileAsync('git', ['cat-file', '-e', `HEAD:${filePath}`], { cwd: taskPath });
        // File exists in HEAD and no parsed diff means there are no staged changes for this file.
        return { lines: [] };
      } catch {
        // File exists in index but not in HEAD -> staged add.
        return { lines: toAddedLines(indexContent) };
      }
    } catch {
      try {
        // File missing from index but present in HEAD -> staged delete.
        const { stdout: headContent } = await execFileAsync('git', ['show', `HEAD:${filePath}`], {
          cwd: taskPath,
        });
        return { lines: toDeletedLines(headContent) };
      } catch {
        return { lines: [] };
      }
    }
  }

  try {
    const { stdout: headContent } = await execFileAsync('git', ['show', `HEAD:${filePath}`], {
      cwd: taskPath,
    });
    return { lines: toDeletedLines(headContent) };
  } catch {
    return { lines: [] };
  }
}
