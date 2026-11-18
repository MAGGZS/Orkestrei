import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { watch, type FSWatcher } from 'chokidar';

const execFileAsync = promisify(execFile);

export interface FileTreeEntry {
  name: string;
  path: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
  gitStatus?: string;
}

export interface GitChangeEntry {
  path: string;
  status: string;
  staged: boolean;
}

export class FileTreeService {
  private watchers = new Map<string, FSWatcher>();
  private changeListeners = new Set<(nodeId: string) => void>();

  onDidChange(cb: (nodeId: string) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /**
   * Resolve symlinks/junctions even when the leaf path does not yet exist.
   */
  private async resolveCanonicalPath(targetPath: string): Promise<string> {
    let cur = path.resolve(targetPath);
    const missingParts: string[] = [];
    for (;;) {
      try {
        const real = await fsp.realpath(cur);
        return missingParts.length > 0 ? path.join(real, ...missingParts.reverse()) : real;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) {
          return missingParts.length > 0 ? path.join(cur, ...missingParts.reverse()) : cur;
        }
        missingParts.push(path.basename(cur));
        cur = parent;
      }
    }
  }

  /**
   * Verify that targetPath resolves inside at least one allowed workspace/floor root.
   */
  async isPathWithinRoots(targetPath: string, allowedRoots: string[]): Promise<boolean> {
    const trimmed = targetPath.trim();
    if (!trimmed || allowedRoots.length === 0) return false;
    const realTarget = await this.resolveCanonicalPath(trimmed);
    const cmpTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;

    for (const root of allowedRoots) {
      if (!root || !root.trim()) continue;
      const realRoot = await this.resolveCanonicalPath(root);
      const cmpRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
      const rel = path.relative(cmpRoot, cmpTarget);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return true;
      }
    }
    return false;
  }

  async listDirectory(
    rootPath: string,
    dirPath: string,
    showHidden = false,
    allowedRoots?: string[]
  ): Promise<FileTreeEntry[]> {
    if (allowedRoots !== undefined && !(await this.isPathWithinRoots(rootPath, allowedRoots))) {
      return [];
    }
    const target = dirPath || rootPath;
    if (!(await this.isPathWithinRoots(target, [rootPath]))) {
      return [];
    }
    if (!fs.existsSync(target)) return [];
    const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
    const gitStatuses = await this.getGitStatusMap(rootPath);

    const results: FileTreeEntry[] = [];
    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.') && entry.name !== '.maestri') continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(target, entry.name);
      const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
      let size = 0;
      if (!entry.isDirectory()) {
        try {
          size = (await fsp.stat(fullPath)).size;
        } catch {
          size = 0;
        }
      }
      results.push({
        name: entry.name,
        path: fullPath,
        relativePath: relPath,
        isDirectory: entry.isDirectory(),
        size,
        gitStatus: gitStatuses.get(relPath),
      });
    }

    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return results;
  }

  watchDirectory(nodeId: string, dirPath: string): void {
    this.unwatchDirectory(nodeId);
    if (!fs.existsSync(dirPath)) return;
    try {
      const watcher = watch(dirPath, {
        ignored: /(^|[\\/])(\.git|node_modules)([\\/]|$)/,
        ignoreInitial: true,
        depth: 2,
      });
      let debounce: NodeJS.Timeout | null = null;
      const notify = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          for (const cb of this.changeListeners) cb(nodeId);
        }, 250);
      };
      watcher.on('add', notify).on('unlink', notify).on('addDir', notify).on('unlinkDir', notify).on('change', notify);
      this.watchers.set(nodeId, watcher);
    } catch {
      // ignore watch error
    }
  }

  unwatchDirectory(nodeId: string): void {
    const existing = this.watchers.get(nodeId);
    if (existing) {
      this.watchers.delete(nodeId);
      void existing.close().catch(() => undefined);
    }
  }

  async readFile(
    filePath: string,
    allowedRoots: string[] = []
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    try {
      if (!(await this.isPathWithinRoots(filePath, allowedRoots))) {
        return { ok: false, error: 'Access denied: path is outside workspace/floor root' };
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return { ok: false, error: 'Target path is not a file' };
      }
      if (stat.size > 1024 * 1024) {
        return { ok: false, error: 'File exceeds 1 MiB preview limit' };
      }
      const content = await fsp.readFile(filePath, 'utf8');
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async writeFile(
    filePath: string,
    content: string,
    allowedRoots: string[] = []
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!(await this.isPathWithinRoots(filePath, allowedRoots))) {
        return { ok: false, error: 'Access denied: path is outside workspace/floor root' };
      }
      await fsp.writeFile(filePath, content, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getGitStatusMap(rootPath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: rootPath });
      for (const line of stdout.split(/\r?\n/)) {
        if (line.length < 4) continue;
        const status = line.slice(0, 2).trim() || '?';
        const file = line.slice(3).trim().replace(/^"|"$/g, '');
        map.set(file, status);
      }
    } catch {
      // not a git repo
    }
    return map;
  }

  async getGitInfo(rootPath: string): Promise<{
    isRepo: boolean;
    branch: string | null;
    changes: GitChangeEntry[];
  }> {
    try {
      const { stdout: branchOut } = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: rootPath }
      );
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: rootPath,
      });
      const changes: GitChangeEntry[] = [];
      for (const line of statusOut.split(/\r?\n/)) {
        if (line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        const file = line.slice(3).trim().replace(/^"|"$/g, '');
        changes.push({
          path: file,
          status: `${x}${y}`.trim() || '?',
          staged: x !== ' ' && x !== '?',
        });
      }
      return { isRepo: true, branch: branchOut.trim() || null, changes };
    } catch {
      return { isRepo: false, branch: null, changes: [] };
    }
  }

  async getGitDiff(rootPath: string, filePath?: string): Promise<string> {
    try {
      const args = filePath ? ['diff', '--', filePath] : ['diff'];
      const { stdout } = await execFileAsync('git', args, { cwd: rootPath });
      return stdout;
    } catch {
      return '';
    }
  }

  async gitCommit(rootPath: string, message: string): Promise<{ ok: boolean; output: string }> {
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: rootPath });
      const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd: rootPath });
      return { ok: true, output: stdout };
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.watchers.keys()]) {
      this.unwatchDirectory(id);
    }
  }
}
