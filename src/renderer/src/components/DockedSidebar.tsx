import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  AlertCircle,
  CheckCircle2,
  Folder,
  GitBranch,
  GitMerge,
  Layers,
  Loader2,
  Pin,
  Plus,
  Trash2,
} from 'lucide-react';
import type { FloorStatus } from '../../../shared/types';
import {
  activeSheetAtom,
  activeWorkspaceIdAtom,
  appStateAtom,
  workspacesAtom,
} from '../state/atoms';

function StatusBadge({ status }: { status: FloorStatus | null }) {
  if (!status) return null;
  const icon =
    status.state === 'working' ? (
      <Loader2 className="size-3 text-[var(--muted-foreground)]" />
    ) : status.state === 'blocked' ? (
      <AlertCircle className="size-3 text-[var(--destructive)]" />
    ) : status.state === 'review' ? (
      <GitMerge className="size-3 text-[var(--warning)]" />
    ) : (
      <CheckCircle2 className="size-3 text-[var(--success)]" />
    );

  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
      {icon}
      <span className="truncate">{status.text}</span>
      {status.progress !== undefined && (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
          {Math.round(status.progress * 100)}%
        </span>
      )}
    </div>
  );
}

export const DockedSidebar: React.FC = () => {
  const appState = useAtomValue(appStateAtom);
  const workspaces = useAtomValue(workspacesAtom);
  const activeId = useAtomValue(activeWorkspaceIdAtom);
  const setSheet = useSetAtom(activeSheetAtom);

  if (!appState.sidebarOpen) return null;

  const pinned = workspaces.filter((w) => w.isPinned);
  const unpinned = workspaces.filter((w) => !w.isPinned);

  const renderWorkspace = (ws: (typeof workspaces)[0]) => {
    const isActive = ws.id === activeId;
    return (
      <div key={ws.id} className="space-y-0.5">
        <div
          onClick={() => void window.maestri.workspace.switch(ws.id)}
          title={ws.workingDirectory}
          className={`group flex h-8 cursor-pointer items-center justify-between gap-2 rounded-lg px-2 transition-colors ${
            isActive
              ? 'bg-[var(--sidebar-active)] text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--foreground)]'
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Folder className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
            <span className="truncate text-[12.5px] font-medium">{ws.name}</span>
          </div>

          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void window.maestri.workspace.patch(ws.id, { isPinned: !ws.isPinned });
              }}
              title={ws.isPinned ? 'Unpin' : 'Pin workspace'}
              className={`rounded p-1 hover:bg-[var(--bg-hover)] ${
                ws.isPinned ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'
              }`}
            >
              <Pin className="size-3" />
            </button>
            {workspaces.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void window.maestri.workspace.delete(ws.id);
                }}
                title="Delete workspace"
                className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Floors inside active workspace */}
        {isActive && (
          <div className="space-y-0.5 pl-4">
            <button
              type="button"
              onClick={() => void window.maestri.floor.switch(ws.id, null)}
              className={`flex h-7 w-full items-center justify-between rounded-md px-2 text-left text-[12px] transition-colors ${
                ws.activeFloorId === null
                  ? 'bg-white/[0.06] font-medium text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Layers className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
                Ground
              </span>
              <span className="font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {ws.nodes.length}
              </span>
            </button>
            {ws.groundStatus && (
              <div className="px-2 pb-1">
                <StatusBadge status={ws.groundStatus} />
              </div>
            )}

            {ws.floors.map((floor) => {
              const isFloorActive = ws.activeFloorId === floor.id;
              return (
                <div
                  key={floor.id}
                  onClick={() => void window.maestri.floor.switch(ws.id, floor.id)}
                  className={`group/fl flex cursor-pointer flex-col rounded-md px-2 py-1 text-[12px] transition-colors ${
                    isFloorActive
                      ? 'bg-white/[0.06] font-medium text-[var(--foreground)]'
                      : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
                  }`}
                >
                  <div className="flex h-5 items-center justify-between gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <GitBranch className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
                      <span className="truncate">{floor.name}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {floor.cloneKind === 'worktree' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSheet({ kind: 'landFloor', floorId: floor.id });
                          }}
                          title="Land floor"
                          className="hidden rounded px-1 py-0.5 text-[10px] font-medium text-[var(--success)] hover:bg-[var(--bg-hover)] group-hover/fl:block"
                        >
                          Land
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.maestri.floor.delete(ws.id, floor.id);
                        }}
                        title="Delete floor"
                        className="hidden rounded p-0.5 hover:text-[var(--destructive)] group-hover/fl:block"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>
                  {floor.branchName && (
                    <div className="truncate pl-5 font-mono text-[10px] text-[var(--muted-foreground)] opacity-75">
                      {floor.branchName}
                    </div>
                  )}
                  <StatusBadge status={floor.status} />
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => setSheet({ kind: 'newFloor' })}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Plus className="size-3.5 shrink-0" />
              New floor
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]"
      style={{ width: appState.sidebarWidth ? Math.min(260, Math.max(216, appState.sidebarWidth)) : 232 }}
    >
      <div className="flex h-11 items-center justify-between px-3">
        <span className="text-[12px] font-medium text-[var(--muted-foreground)]">
          Workspaces
        </span>
        <button
          type="button"
          onClick={() => setSheet({ kind: 'newWorkspace' })}
          title="New workspace"
          className="flex size-7 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--foreground)]"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {pinned.length > 0 && (
          <div className="space-y-0.5">
            <div className="px-2 pb-1 text-[11px] font-medium text-[var(--muted-foreground)]">
              Pinned
            </div>
            {pinned.map(renderWorkspace)}
          </div>
        )}
        <div className="space-y-0.5">{unpinned.map(renderWorkspace)}</div>
      </div>
    </aside>
  );
};
