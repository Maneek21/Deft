import { spawnSync } from 'node:child_process';

const pnpmArgs = process.argv.slice(2);
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArgs] : pnpmArgs;
const result = spawnSync(command, args, { stdio: 'inherit' });

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
