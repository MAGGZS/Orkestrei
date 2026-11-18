import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderGit2,
  GitBranch,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { CanvasNode } from '../../../shared/types';
import { activeSheetAtom, activeWorkspaceAtom } from '../state/atoms';
import { NodeFrame } from './NodeFrame';

interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
  gitStatus?: string;
}

export const FileTreeNode: React.FC<{ node: CanvasNode }> = ({ node }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const setSheet = useSetAtom(activeSheetAtom);
  const ft = node.content.kind === 'fileTree' ? node.content.fileTree : null;

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Map<string, FileEntry[]>>(new Map());
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitChangesCount, setGitChangesCount] = useState(0);
  const [commitMsg, setCommitMsg] = useState('');
  const [showCommit, setShowCommit] = useState(false);

  const rootPath = ft?.rootPath || workspace?.workingDirectory || '';

  const refresh = async () => {
    if (!rootPath) return;
    const list = await window.maestri.fileTree.list(rootPath, rootPath, ft?.showHidden);
    setEntries(list);
    const git = await window.maestri.fileTree.gitInfo(rootPath);
    setGitBranch(git.isRepo ? git.branch : null);
    setGitChangesCount(git.changes.length);
  };

  useEffect(() => {
    if (!rootPath) return;
    void refresh();
    void window.maestri.fileTree.watch(node.id, rootPath);
    const unsub = window.maestri.fileTree.onDidChange((nid) => {
      if (nid === node.id) void refresh();
    });
    return () => {
      unsub();
      void window.maestri.fileTree.unwatch(node.id);
    };
  }, [node.id, rootPath]);

  if (!ft || !workspace) return null;

  const toggleDir = async (dirPath: string) => {
    if (expanded.has(dirPath)) {
      const next = new Map(expanded);
      next.delete(dirPath);
      setExpanded(next);
      return;
    }
    const children = await window.maestri.fileTree.list(rootPath, dirPath, ft.showHidden);
    const next = new Map(expanded);
    next.set(dirPath, children);
    setExpanded(next);
  };

  const renderEntries = (list: FileEntry[], depth = 0) =>
    list.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const children = expanded.get(entry.path) ?? [];
      const statusColor =
        entry.gitStatus === 'M'
          ? 'text-[var(--git-modified)]'
          : entry.gitStatus === '??' || entry.gitStatus === 'A'
            ? 'text-[var(--git-untracked)]'
            : entry.gitStatus === 'D'
              ? 'text-[var(--git-deleted)]'
              : 'text-[var(--foreground)]';

      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => {
              if (entry.isDirectory) {
                void toggleDir(entry.path);
              } else {
                setSheet({ kind: 'fileEditor', filePath: entry.path, title: entry.name });
              }
            }}
            className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-xs hover:bg-[var(--bg-hover)]"
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            {entry.isDirectory ? (
              <>
                <ChevronRight
                  className={`size-3 shrink-0 text-[var(--muted-foreground)] transition-transform ${
                    isOpen ? 'rotate-90' : ''
                  }`}
                />
                <Folder className="size-3.5 shrink-0 text-[#64d2ff]" />
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileIcon className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
              </>
            )}
            <span className={`flex-1 truncate ${statusColor}`}>{entry.name}</span>
            {entry.gitStatus && (
              <span className={`text-[10px] font-semibold ${statusColor}`}>{entry.gitStatus}</span>
            )}
          </button>
          {entry.isDirectory && isOpen && renderEntries(children, depth + 1)}
        </div>
      );
    });

  return (
    <NodeFrame node={node} minWidth={230} minHeight={220}>
      {({ startDrag }) => (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-[var(--card)]">
          <div
            onPointerDown={startDrag}
            className="flex h-9 shrink-0 cursor-grab items-center justify-between border-b border-[var(--border)] px-3 active:cursor-grabbing"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <FolderGit2 className="size-3.5 shrink-0 text-[#64d2ff]" />
              <span className="truncate text-xs font-semibold text-[var(--foreground)]">
                Files
              </span>
              {gitBranch && (
                <span className="flex items-center gap-1 rounded-full bg-[var(--secondary)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                  <GitBranch className="size-2.5" />
                  {gitBranch}
                  {gitChangesCount > 0 ? ` (${gitChangesCount})` : ''}
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
              {gitBranch && gitChangesCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowCommit((v) => !v)}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                >
                  Commit
                </button>
              )}
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)]"
              >
                <RefreshCw className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => void window.maestri.node.deleteMany(workspace.id, [node.id])}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/20 hover:text-[var(--destructive)]"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          </div>

          {showCommit && (
            <form
              onPointerDown={(e) => e.stopPropagation()}
              onSubmit={async (e) => {
                e.preventDefault();
                if (!commitMsg.trim()) return;
                await window.maestri.fileTree.gitCommit(rootPath, commitMsg.trim());
                setCommitMsg('');
                setShowCommit(false);
                void refresh();
              }}
              className="flex gap-1 border-b border-[var(--border)] p-2"
            >
              <input
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message…"
                className="flex-1 rounded bg-[var(--input)] px-2 py-1 text-xs outline-none"
              />
              <button
                type="submit"
                className="rounded bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white"
              >
                Save
              </button>
            </form>
          )}

          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex-1 overflow-y-auto p-1.5"
          >
            {entries.length === 0 ? (
              <div className="p-3 text-center text-xs text-[var(--muted-foreground)]">
                Empty directory
              </div>
            ) : (
              renderEntries(entries)
            )}
          </div>
        </div>
      )}
    </NodeFrame>
  );
};
