import chokidar, { type FSWatcher } from 'chokidar';

export interface WorkspaceWatchHandle {
  close(): Promise<void>;
}

export function watchWorkspace(root: string, onChange: () => void): WorkspaceWatchHandle {
  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: [
      '**/.git/**',
      '**/node_modules/**',
      '**/target/**',
      '**/build/**',
      '**/dist/**',
      '**/.gradle/**',
    ],
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, 750);
  };

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('error', () => undefined);

  return {
    async close() {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
