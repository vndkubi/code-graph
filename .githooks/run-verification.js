import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'npm' : 'npm';
const shell = process.platform === 'win32';
const result = spawnSync(command, ['run', 'verify'], {
  stdio: 'inherit',
  shell,
});

if (result.error) throw result.error;
process.exit(result.status ?? 0);
