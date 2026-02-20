import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildExternalToolEnv } from './childProcessEnv';

const execFileAsync = promisify(execFile);

export const DEFAULT_GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function normalizePathForChild(pathValue: string): string {
  const separator = process.platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  return pathValue
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 512)
    .filter((part) => {
      const key = process.platform === 'win32' ? part.toLowerCase() : part;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200)
    .join(separator);
}

function buildGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const externalEnv = buildExternalToolEnv(baseEnv);
  const env: NodeJS.ProcessEnv = {};
  const keys = [
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'SSH_AUTH_SOCK',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
  ];

  for (const key of keys) {
    const value = externalEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }

  const normalizedPath = normalizePathForChild(
    typeof externalEnv.PATH === 'string' ? externalEnv.PATH : ''
  );
  const defaultPath =
    process.platform === 'win32'
      ? 'C:\\Windows\\System32;C:\\Windows'
      : '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';
  env.PATH = normalizedPath || defaultPath;

  return env;
}

function buildMinimalRetryEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = buildGitEnv(baseEnv);
  const minimal: NodeJS.ProcessEnv = {};
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'SSH_AUTH_SOCK',
    'TMPDIR',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
  ];

  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      minimal[key] = value;
    }
  }

  return minimal;
}

export interface ExecGitOptions {
  timeout?: number;
  maxBuffer?: number;
  baseEnv?: NodeJS.ProcessEnv;
  onRetryOversizedEnv?: (code: 'ENAMETOOLONG' | 'E2BIG') => void;
}

export async function execGit(
  args: string[],
  cwd: string,
  options: ExecGitOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const baseEnv = options.baseEnv ?? process.env;
  const timeout = options.timeout;
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES;

  const run = async (env: NodeJS.ProcessEnv) =>
    (await execFileAsync('git', args, {
      cwd,
      env,
      timeout,
      maxBuffer,
    })) as { stdout: string; stderr: string };

  try {
    return await run(buildGitEnv(baseEnv));
  } catch (error: any) {
    const code = error?.code;
    if (code === 'ENAMETOOLONG' || code === 'E2BIG') {
      options.onRetryOversizedEnv?.(code);
      return await run(buildMinimalRetryEnv(baseEnv));
    }
    throw error;
  }
}

