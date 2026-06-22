import { spawnSync } from 'node:child_process';

const config = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  stdio: 'inherit',
});
if (config.error) throw config.error;
if (config.status !== 0) process.exit(config.status);

if (process.platform !== 'win32') {
  const chmod = spawnSync('chmod', ['+x', '.githooks/pre-push'], {
    stdio: 'inherit',
  });
  if (chmod.error) throw chmod.error;
  if (chmod.status !== 0) process.exit(chmod.status);
}
