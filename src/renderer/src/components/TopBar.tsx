import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  BookOpen,
  Bot,
  ChevronDown,
  Clock,
  Command,
  FolderGit2,
  Globe,
  Hand,
  Layers,
  LayoutGrid,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  PanelLeft,
  Paperclip,
  Pencil,
  Plus,
  Settings,
  StickyNote,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import type { CanvasMode, DrawingToolKind, Workspace } from '../../../shared/types';
import {
  activeLevelAtom,
  activeSheetAtom,
  activeWorkspaceAtom,
  agentUsageAtom,
  appStateAtom,
  canvasModeAtom,
  canvasOffsetAtom,
  drawingToolAtom,
  pendingPresetIdAtom,
  preferencesAtom,
  zoomAtom,
} from '../state/atoms';
import {
  AgentUsagePopover,
  AgentUsageToolbarButton,
  getAllUsageProviders,
  getVisibleProviders,
} from './AgentUsageRing';
import { useDismissable } from './useDismissable';

function offsetFrom(ws: Workspace) {
  const f = ws.activeFloorId ? ws.floors.find((x) => x.id === ws.activeFloorId) : null;
  return f ? f.canvasOrigin : ws.canvasOrigin;
}

export const TopBar: React.FC = () => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const prefs = useAtomValue(preferencesAtom);
  const agentUsage = useAtomValue(agentUsageAtom);
  const [appState, setAppState] = useAtom(appStateAtom);
  const [mode, setMode] = useAtom(canvasModeAtom);
  const [drawingTool, setDrawingTool] = useAtom(drawingToolAtom);
  const zoom = useAtomValue(zoomAtom);
  const setOffset = useSetAtom(canvasOffsetAtom);
  const setSheet = useSetAtom(activeSheetAtom);
  const setPendingPresetId = useSetAtom(pendingPresetIdAtom);

  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [showFloorMenu, setShowFloorMenu] = useState(false);
  const [showDrawMenu, setShowDrawMenu] = useState(false);
  const [showAgentUsage, setShowAgentUsage] = useState(false);

  const floorMenuRef = useRef<HTMLDivElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  const drawMenuRef = useRef<HTMLDivElement | null>(null);
  const agentUsageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const agentUsagePopoverRef = useRef<HTMLDivElement | null>(null);

  const visibleUsageProviders = useMemo(() => getVisibleProviders(agentUsage), [agentUsage]);
  const allUsageProviders = useMemo(() => getAllUsageProviders(agentUsage), [agentUsage]);

  useEffect(() => {
    if (allUsageProviders.length === 0) {
      setShowAgentUsage(false);
    }
  }, [allUsageProviders.length]);

  useDismissable(
    showPresetMenu || showFloorMenu || showDrawMenu,
    [floorMenuRef, presetMenuRef, drawMenuRef],
    () => {
      setShowPresetMenu(false);
      setShowFloorMenu(false);
      setShowDrawMenu(false);
    }
  );

  useDismissable(showAgentUsage, [agentUsageTriggerRef, agentUsagePopoverRef], () => {
    setShowAgentUsage(false);
  });

  const activeFloor = workspace?.activeFloorId
    ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
    : null;

  const toggleSidebar = () => {
    const next = !appState.sidebarOpen;
    setAppState((prev) => ({ ...prev, sidebarOpen: next }));
    void window.maestri.appState.update({ sidebarOpen: next });
  };

  const openUtilitySheet = (nextSheet: Parameters<typeof setSheet>[0]) => {
    setShowAgentUsage(false);
    setShowPresetMenu(false);
    setShowDrawMenu(false);
    setShowFloorMenu(false);
    setSheet(nextSheet);
  };

  const handleTidyCanvas = async () => {
    if (!workspace || level.nodes.length === 0) return;
    const sorted = [...level.nodes].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
    let cursorX = 80;
    let cursorY = 80;
    let rowMaxH = 0;
    const maxRowWidth = 1750;
    const patches: Array<{ nodeId: string; frame: (typeof sorted)[0]['frame'] }> = [];

    for (const n of sorted) {
      if (cursorX + n.frame.width > maxRowWidth && cursorX > 80) {
        cursorX = 80;
        cursorY += rowMaxH + 48;
        rowMaxH = 0;
      }
      patches.push({
        nodeId: n.id,
        frame: { ...n.frame, x: cursorX, y: cursorY },
      });
      cursorX += n.frame.width + 48;
      rowMaxH = Math.max(rowMaxH, n.frame.height);
    }
    await window.maestri.node.patchFrames(workspace.id, patches);
    setOffset({ x: 0, y: 0 });
  };

  const toolBtn = (
    targetMode: CanvasMode,
    icon: React.ReactNode,
    label: string,
    shortcut?: string
  ) => (
    <button
      type="button"
      onClick={() => {
        setShowPresetMenu(false);
        setShowDrawMenu(false);
        setShowFloorMenu(false);
        setShowAgentUsage(false);
        setMode(targetMode);
      }}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`flex size-7 items-center justify-center rounded-full transition-colors ${
        mode === targetMode
          ? 'bg-[var(--foreground)] text-[var(--background)]'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
      }`}
    >
      {icon}
    </button>
  );

  return (
    <>
      <div className="titlebar-drag fixed inset-x-0 top-0 z-20 h-7" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between px-3 pt-2.5">
        {/* Top-left floating pill: Sidebar toggle + Workspace / Floor */}
        <div className="titlebar-no-drag pointer-events-auto flex items-center gap-1.5">
          <div className="glass flex h-9 items-center gap-0.5 rounded-full p-1">
            <button
              type="button"
              onClick={toggleSidebar}
              title="Toggle sidebar"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <PanelLeft className="size-4" />
            </button>

            {workspace && (
              <div ref={floorMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowFloorMenu((v) => !v);
                    setShowPresetMenu(false);
                    setShowDrawMenu(false);
                    setShowAgentUsage(false);
                  }}
                  className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-[var(--foreground)]/90 transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <Layers className="size-3.5 text-[var(--muted-foreground)]" />
                  <span className="max-w-[130px] truncate">{workspace.name}</span>
                  <span className="text-[var(--muted-foreground)]">/</span>
                  <span className="text-[var(--muted-foreground)]">
                    {activeFloor ? activeFloor.name : 'Ground'}
                  </span>
                  <ChevronDown className="size-3 text-[var(--muted-foreground)]" />
                </button>

                {showFloorMenu && (
                  <div className="glass-strong absolute left-0 top-10 z-50 w-56 rounded-lg border border-[var(--border)] p-1 text-xs shadow-2xl">
                    <div className="px-2 py-1 text-[11px] font-medium text-[var(--muted-foreground)]">
                      Floors
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowFloorMenu(false);
                        void window.maestri.floor.switch(workspace.id, null, {
                          origin: offsetFrom(workspace),
                          zoom,
                        });
                      }}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${
                        workspace.activeFloorId === null
                          ? 'bg-[var(--sidebar-active)] font-medium text-[var(--foreground)]'
                          : 'text-[var(--muted-foreground)]'
                      }`}
                    >
                      <span>Ground</span>
                      <span className="font-mono text-[11px] tabular-nums opacity-70">
                        {workspace.nodes.length}
                      </span>
                    </button>
                    {workspace.floors.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setShowFloorMenu(false);
                          void window.maestri.floor.switch(workspace.id, f.id);
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${
                          workspace.activeFloorId === f.id
                            ? 'bg-[var(--sidebar-active)] font-medium text-[var(--foreground)]'
                            : 'text-[var(--muted-foreground)]'
                        }`}
                      >
                        <span className="truncate">{f.name}</span>
                        <span className="font-mono text-[11px] tabular-nums opacity-70">
                          {f.branchName || f.nodes.length}
                        </span>
                      </button>
                    ))}
                    <div className="my-1 border-t border-[var(--border)]" />
                    <button
                      type="button"
                      onClick={() => {
                        setShowFloorMenu(false);
                        setSheet({ kind: 'newFloor' });
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <Plus className="size-3.5 text-[var(--muted-foreground)]" />
                      New floor
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Center floating MainToolbar (icon-only, Maestri style) */}
        <div className="titlebar-no-drag pointer-events-auto glass flex h-9 items-center gap-0.5 rounded-full p-1">
          {toolBtn('select', <MousePointer2 className="size-4" />, 'Select', 'V')}
          {toolBtn('pan', <Hand className="size-4" />, 'Pan', 'H')}

          <div className="mx-1 h-4 w-px bg-[var(--border)]" />

          {/* Terminal + Agent Preset Picker */}
          <div ref={presetMenuRef} className="relative flex items-center">
            <button
              type="button"
              onClick={() => {
                setPendingPresetId(null);
                setShowPresetMenu(false);
                setMode('terminal');
              }}
              title="New terminal (T)"
              className={`flex size-7 items-center justify-center rounded-l-full transition-colors ${
                mode === 'terminal'
                  ? 'bg-[var(--foreground)] text-[var(--background)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <Terminal className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPresetMenu((v) => !v);
                setShowDrawMenu(false);
                setShowFloorMenu(false);
                setShowAgentUsage(false);
              }}
              title="Agent presets"
              className="flex h-7 items-center rounded-r-full px-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <ChevronDown className="size-3" />
            </button>

            {showPresetMenu && (
              <div className="glass-strong absolute left-0 top-10 z-50 w-52 rounded-lg border border-[var(--border)] p-1 text-xs shadow-2xl">
                <div className="px-2 py-1 text-[11px] font-medium text-[var(--muted-foreground)]">
                  Agent presets
                </div>
                {prefs.agentPresets
                  .filter((p) => p.isActive)
                  .map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setShowPresetMenu(false);
                        setPendingPresetId(preset.id);
                        setMode('terminal');
                      }}
                      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span className="flex items-center gap-2 font-medium text-[var(--foreground)]">
                        <Bot className="size-3.5 text-[var(--muted-foreground)]" />
                        {preset.name}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
                        {preset.command || 'shell'}
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {toolBtn('note', <StickyNote className="size-4" />, 'Sticky note', 'N')}
          {toolBtn('connect', <Link2 className="size-4" />, 'Connect ropes', 'C')}
          {toolBtn('cableTie', <Paperclip className="size-4" />, 'Cable tie', 'B')}
          {toolBtn('portal', <Globe className="size-4" />, 'Browser portal', 'P')}
          {toolBtn('fileTree', <FolderGit2 className="size-4" />, 'File tree', 'F')}

          <div ref={drawMenuRef} className="relative flex items-center">
            <button
              type="button"
              onClick={() => {
                setShowDrawMenu(false);
                setMode('draw');
              }}
              title="Draw (D)"
              className={`flex size-7 items-center justify-center rounded-l-full transition-colors ${
                mode === 'draw'
                  ? 'bg-[var(--foreground)] text-[var(--background)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <Pencil className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setShowDrawMenu((v) => !v);
                setShowPresetMenu(false);
                setShowFloorMenu(false);
                setShowAgentUsage(false);
              }}
              title="Draw shape"
              className="flex h-7 items-center rounded-r-full px-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <ChevronDown className="size-3" />
            </button>
            {showDrawMenu && (
              <div className="glass-strong absolute left-0 top-10 z-50 w-36 rounded-lg border border-[var(--border)] p-1 text-xs shadow-2xl">
                {(['pen', 'rect', 'ellipse', 'line', 'arrow'] as DrawingToolKind[]).map((dt) => (
                  <button
                    key={dt}
                    type="button"
                    onClick={() => {
                      setDrawingTool(dt);
                      setMode('draw');
                      setShowDrawMenu(false);
                    }}
                    className={`w-full rounded-md px-2.5 py-1.5 text-left capitalize transition-colors hover:bg-[var(--bg-hover)] ${
                      drawingTool === dt
                        ? 'font-medium text-[var(--foreground)]'
                        : 'text-[var(--muted-foreground)]'
                    }`}
                  >
                    {dt}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Top-right floating cluster: Utilities + Window Controls */}
        <div className="titlebar-no-drag pointer-events-auto flex items-center gap-1.5">
          <div className="glass flex h-9 items-center gap-0.5 rounded-full p-1">
            <button
              type="button"
              onClick={() => openUtilitySheet({ kind: 'partituras' })}
              title="Partituras"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <BookOpen className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => openUtilitySheet({ kind: 'rolesAndPresets' })}
              title="Roles and agent presets"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Bot className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => openUtilitySheet({ kind: 'routines' })}
              title="Routines"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Clock className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => openUtilitySheet({ kind: 'floorHooks' })}
              title="Floor hooks"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Wrench className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAgentUsage(false);
                void handleTidyCanvas();
              }}
              title="Arrange canvas"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <LayoutGrid className="size-4" />
            </button>
            <div className="mx-0.5 h-4 w-px bg-[var(--border)]" />
            <button
              type="button"
              onClick={() => openUtilitySheet({ kind: 'commandPalette' })}
              title="Command palette (Ctrl+K)"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Command className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => openUtilitySheet({ kind: 'preferences' })}
              title="Preferences"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Settings className="size-4" />
            </button>
            {allUsageProviders.length > 0 && (
              <>
                <div className="mx-0.5 h-4 w-px bg-[var(--border)]" />
                <AgentUsageToolbarButton
                  ref={agentUsageTriggerRef}
                  providers={visibleUsageProviders}
                  allProviders={allUsageProviders}
                  isOpen={showAgentUsage}
                  onToggle={() => {
                    setShowAgentUsage((v) => !v);
                    setShowPresetMenu(false);
                    setShowDrawMenu(false);
                    setShowFloorMenu(false);
                  }}
                />
              </>
            )}
          </div>

          <div className="glass flex h-9 items-center gap-0.5 rounded-full p-1">
            <button
              type="button"
              onClick={() => void window.maestri.windowControls.minimize()}
              title="Minimize"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Minus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void window.maestri.windowControls.toggleMaximize()}
              title="Maximize"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Maximize2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void window.maestri.windowControls.close()}
              title="Close"
              className="flex size-7 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)] hover:text-white"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </header>

      {showAgentUsage && allUsageProviders.length > 0 && (
        <AgentUsagePopover
          ref={agentUsagePopoverRef}
          providers={allUsageProviders}
          anchorRef={agentUsageTriggerRef}
          onClose={() => setShowAgentUsage(false)}
          onRefresh={(id) => window.maestri.agentUsage.refresh(id)}
        />
      )}
    </>
  );
};
