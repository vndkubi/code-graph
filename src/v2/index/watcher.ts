import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';

export interface WorkspaceWatchHandle {
  close(): Promise<void>;
}

export function watchWorkspace(root: string, onChange: (changedPaths: string[]) => void): WorkspaceWatchHandle {
  let timer: NodeJS.Timeout | undefined;
  const pendingPaths = new Set<string>();
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

  const schedule = (changedPath: string) => {
    const relPath = normalizeWatchPath(root, changedPath);
    if (relPath) pendingPaths.add(relPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const changedPaths = [...pendingPaths];
      pendingPaths.clear();
      timer = undefined;
      onChange(changedPaths);
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

function normalizeWatchPath(root: string, changedPath: string): string | undefined {
  const absolute = path.isAbsolute(changedPath) ? path.resolve(changedPath) : path.resolve(root, changedPath);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.replace(/\\/g, '/');
}
