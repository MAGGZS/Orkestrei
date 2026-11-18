import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Folder,
  Globe,
  Layers,
  Maximize2,
  Search,
  Sparkles,
  StickyNote,
  Terminal,
  Users,
} from 'lucide-react';
import {
  computeCenteredOffset,
  computeZoomToFit,
  focusTerminalTarget,
  getNodeLiveFrame,
  getStackMemberMap,
  getTerminalTargets,
} from '../canvas/canvas-navigation';
import {
  activeLevelAtom,
  activeSheetAtom,
  activeWorkspaceAtom,
  canvasModeAtom,
  canvasOffsetAtom,
  canvasViewportSizeAtom,
  liftedNodeIdAtom,
  liveFramesAtom,
  selectedNodeIdsAtom,
  workspacesAtom,
  zoomAtom,
} from '../state/atoms';

type PaletteCategory =
  | 'Terminal'
  | 'Band'
  | 'Floor'
  | 'Note'
  | 'Portal'
  | 'Workspace'
  | 'Action';

interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
  category: PaletteCategory;
  action: () => void;
}

export const CommandPalette: React.FC = () => {
  const [sheet, setSheet] = useAtom(activeSheetAtom);
  const workspaces = useAtomValue(workspacesAtom);
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const viewportSize = useAtomValue(canvasViewportSizeAtom);
  const liveFrames = useAtomValue(liveFramesAtom);
  const [zoom, setZoom] = useAtom(zoomAtom);
  const [liftedNodeId, setLiftedNodeId] = useAtom(liftedNodeIdAtom);
  const setMode = useSetAtom(canvasModeAtom);
  const setOffset = useSetAtom(canvasOffsetAtom);
  const setSelectedIds = useSetAtom(selectedNodeIdsAtom);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isOpen = sheet?.kind === 'commandPalette';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSheet((prev) => (prev?.kind === 'commandPalette' ? null : { kind: 'commandPalette' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSheet]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!isOpen) return [];

    const q = query.trim().toLowerCase();
    const list: PaletteItem[] = [];

    const focusSingleNode = (nodeId: string, frameOverride?: (typeof level.nodes)[0]['frame']) => {
      const targetNode = level.nodes.find((n) => n.id === nodeId);
      const frame = frameOverride ?? (targetNode ? getNodeLiveFrame(targetNode, liveFrames) : null);
      if (liftedNodeId && liftedNodeId !== nodeId) {
        setLiftedNodeId(null);
      }
      if (frame) {
        setOffset(computeCenteredOffset(frame, viewportSize, zoom));
      }
      setSelectedIds(new Set([nodeId]));
    };

    if (workspace) {
      const focusCtx = {
        workspaceId: workspace.id,
        viewportSize,
        zoom,
        liveFrames,
        liftedNodeId,
        setLiftedNodeId,
        setOffset,
        setSelectedIds,
      };

      // Terminals (standalone + Band members)
      for (const target of getTerminalTargets(level)) {
        const bandLabel =
          target.bandNode?.content.kind === 'band' ? target.bandNode.content.band.name : null;
        list.push({
          id: `term-${target.terminalNode.id}`,
          label: target.terminal.name,
          detail: bandLabel
            ? `in ${bandLabel}`
            : target.terminal.roleName || target.terminal.agentType,
          category: 'Terminal',
          action: () => focusTerminalTarget(target, focusCtx),
        });
      }

      // Bands
      for (const n of level.nodes) {
        if (n.content.kind !== 'band') continue;
        const band = n.content.band;
        list.push({
          id: `band-${n.id}`,
          label: band.name,
          detail: `${band.memberNodeIds.length} member${band.memberNodeIds.length === 1 ? '' : 's'}`,
          category: 'Band',
          action: () => focusSingleNode(n.id),
        });
      }

      // Floors (Ground + worktree/branch floors)
      list.push({
        id: 'floor-ground',
        label: 'Ground',
        detail:
          workspace.activeFloorId === null
            ? `Active · ${workspace.nodes.length} nodes`
            : `${workspace.nodes.length} nodes`,
        category: 'Floor',
        action: () => {
          setLiftedNodeId(null);
          void window.maestri.floor.switch(workspace.id, null);
        },
      });
      for (const f of workspace.floors) {
        const activeLabel = workspace.activeFloorId === f.id ? 'Active · ' : '';
        list.push({
          id: `floor-${f.id}`,
          label: f.name,
          detail: `${activeLabel}${f.branchName || `${f.nodes.length} nodes`}`,
          category: 'Floor',
          action: () => {
            setLiftedNodeId(null);
            void window.maestri.floor.switch(workspace.id, f.id);
          },
        });
      }

      // Notes (Fichários + Sticky Notes, including notes filed inside a Fichário)
      const stackByMemberId = getStackMemberMap(level);
      for (const n of level.nodes) {
        if (n.content.kind === 'noteStack') {
          const stack = n.content.noteStack;
          list.push({
            id: `stack-${n.id}`,
            label: stack.name,
            detail: `Fichário · ${stack.memberNodeIds.length} page${stack.memberNodeIds.length === 1 ? '' : 's'}`,
            category: 'Note',
            action: () => focusSingleNode(n.id),
          });
        } else if (n.content.kind === 'stickyNote') {
          const sn = n.content.stickyNote;
          const label = sn.customName || sn.fileName.replace(/\.(?:md|markdown|txt)$/i, '');
          const parentStack = stackByMemberId.get(n.id) ?? null;
          list.push({
            id: `note-${n.id}`,
            label,
            detail:
              parentStack?.content.kind === 'noteStack'
                ? `in ${parentStack.content.noteStack.name}`
                : undefined,
            category: 'Note',
            action: () => {
              if (parentStack && parentStack.content.kind === 'noteStack') {
                if (parentStack.content.noteStack.frontNoteId !== n.id) {
                  void window.maestri.node.patch(workspace.id, parentStack.id, {
                    content: {
                      kind: 'noteStack',
                      noteStack: { ...parentStack.content.noteStack, frontNoteId: n.id },
                    },
                  });
                }
                focusSingleNode(parentStack.id, getNodeLiveFrame(parentStack, liveFrames));
              } else {
                focusSingleNode(n.id);
              }
            },
          });
        }
      }

      // Portals
      for (const n of level.nodes) {
        if (n.content.kind !== 'portal') continue;
        const portal = n.content.portal;
        list.push({
          id: `portal-${n.id}`,
          label: portal.name || 'Portal',
          detail: portal.url,
          category: 'Portal',
          action: () => focusSingleNode(n.id),
        });
      }
    }

    // Workspaces
    for (const w of workspaces) {
      list.push({
        id: `ws-${w.id}`,
        label: w.name,
        detail: w.id === workspace?.id ? 'Active' : w.workingDirectory,
        category: 'Workspace',
        action: () => {
          setLiftedNodeId(null);
          void window.maestri.workspace.switch(w.id);
        },
      });
    }

    // Canvas & Orchestration Actions
    const hiddenIds = new Set<string>();
    for (const n of level.nodes) {
      if (n.content.kind === 'band') {
        for (const mid of n.content.band.memberNodeIds) hiddenIds.add(mid);
      } else if (n.content.kind === 'noteStack') {
        for (const mid of n.content.noteStack.memberNodeIds) hiddenIds.add(mid);
      }
    }
    const visibleNodes = level.nodes.filter((n) => !hiddenIds.has(n.id));

    list.push(
      {
        id: 'act-fit',
        label: 'Zoom to fit all nodes',
        category: 'Action',
        action: () => {
          setLiftedNodeId(null);
          const fit = computeZoomToFit(visibleNodes, liveFrames, viewportSize);
          setZoom(fit.zoom);
          setOffset(fit.offset);
        },
      },
      {
        id: 'act-term',
        label: 'Create agent terminal',
        category: 'Action',
        action: () => setMode('terminal'),
      },
      {
        id: 'act-note',
        label: 'Create sticky note',
        category: 'Action',
        action: () => setMode('note'),
      },
      {
        id: 'act-portal',
        label: 'Create browser portal',
        category: 'Action',
        action: () => setMode('portal'),
      },
      {
        id: 'act-partituras',
        label: 'Open Partituras',
        category: 'Action',
        action: () => setSheet({ kind: 'partituras' }),
      },
      {
        id: 'act-routines',
        label: 'Open scheduled routines',
        category: 'Action',
        action: () => setSheet({ kind: 'routines' }),
      },
      {
        id: 'act-roles',
        label: 'Manage agent roles & presets',
        category: 'Action',
        action: () => setSheet({ kind: 'rolesAndPresets' }),
      }
    );

    if (!q) return list;
    return list.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        (item.detail && item.detail.toLowerCase().includes(q))
    );
  }, [
    isOpen,
    query,
    workspace,
    level,
    workspaces,
    viewportSize,
    liveFrames,
    zoom,
    liftedNodeId,
    setLiftedNodeId,
    setMode,
    setOffset,
    setSelectedIds,
    setSheet,
    setZoom,
  ]);

  const effectiveIndex = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : 0;

  useEffect(() => {
    if (!isOpen || items.length === 0) return;
    itemRefs.current[effectiveIndex]?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, effectiveIndex, items.length]);

  if (!isOpen) return null;

  const renderCategoryIcon = (category: PaletteCategory) => {
    const cls = 'size-3.5 shrink-0 text-[var(--muted-foreground)]';
    switch (category) {
      case 'Terminal':
        return <Terminal className={cls} />;
      case 'Band':
        return <Users className={cls} />;
      case 'Floor':
        return <Layers className={cls} />;
      case 'Note':
        return <StickyNote className={cls} />;
      case 'Portal':
        return <Globe className={cls} />;
      case 'Workspace':
        return <Folder className={cls} />;
      case 'Action':
        return <Sparkles className={cls} />;
    }
  };

  const executeItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    setSheet(null);
    item.action();
  };

  return (
    <div
      onClick={() => setSheet(null)}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-24 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-strong w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--border)] shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <Search className="size-4 shrink-0 text-[var(--muted-foreground)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setSheet(null);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (items.length > 0) {
                  setSelectedIndex((i) => (i + 1) % items.length);
                }
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (items.length > 0) {
                  setSelectedIndex((i) => (i - 1 + items.length) % items.length);
                }
              } else if (e.key === 'Enter') {
                e.preventDefault();
                executeItem(items[effectiveIndex]);
              }
            }}
            placeholder="Jump to node, floor, workspace, or action"
            className="flex-1 bg-transparent text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none"
          />
        </div>

        <div className="max-h-80 overflow-y-auto p-2" role="listbox">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
              No matching results
            </div>
          ) : (
            items.map((item, idx) => {
              const isSelected = idx === effectiveIndex;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => executeItem(item)}
                  className={`flex h-9 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-xs transition-colors ${
                    isSelected
                      ? 'bg-[var(--sidebar-active)] text-[var(--foreground)] shadow-[inset_0_0_0_0.5px_var(--border-strong)]'
                      : 'text-[var(--foreground)]/85 hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {item.id === 'act-fit' ? (
                      <Maximize2 className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
                    ) : (
                      renderCategoryIcon(item.category)
                    )}
                    <span className="truncate font-medium">{item.label}</span>
                    {item.detail && (
                      <span className="truncate text-[11px] text-[var(--muted-foreground)]">
                        {item.detail}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--muted-foreground)]">
                    {item.category}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted-foreground)]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--border)] bg-[var(--secondary)] px-1 py-0.5 font-mono text-[10px] leading-none">
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--border)] bg-[var(--secondary)] px-1 py-0.5 font-mono text-[10px] leading-none">
                ↵
              </kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-[var(--border)] bg-[var(--secondary)] px-1 py-0.5 font-mono text-[10px] leading-none">
                esc
              </kbd>
              close
            </span>
          </div>
          <span className="font-mono tabular-nums">{items.length}</span>
        </div>
      </div>
    </div>
  );
};
