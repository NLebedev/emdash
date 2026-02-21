#!/usr/bin/env node

import { spawn } from 'node:child_process';

const DEFAULT_PORT = 3000;

const parsePort = () => {
  const args = process.argv.slice(2);
  const fromFlag = args.find((arg) => arg.startsWith('--port='))?.split('=')[1];
  const fromShortFlagIndex = args.findIndex((arg) => arg === '--port' || arg === '-p');
  const fromShortFlag =
    fromShortFlagIndex >= 0 && fromShortFlagIndex + 1 < args.length
      ? args[fromShortFlagIndex + 1]
      : undefined;
  const fromPositional = args.find((arg) => /^\d+$/.test(arg));
  const fromEnv = process.env.EMDASH_DEV_PORT;

  const raw = fromFlag || fromShortFlag || fromPositional || fromEnv;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
};

const port = parsePort();
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const child = spawn(
  pnpmCmd,
  ['exec', 'concurrently', 'pnpm run dev:main', 'pnpm run dev:renderer'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      EMDASH_DEV_PORT: String(port),
    },
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to start dev processes:', error);
  process.exit(1);
});
