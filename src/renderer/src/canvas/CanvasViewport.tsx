import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Layers, Link2, Trash2, Users } from 'lucide-react';
import {
  DEFAULT_FILE_TREE_SIZE,
  DEFAULT_NOTE_SIZE,
  DEFAULT_PORTAL_SIZE,
  DEFAULT_TERMINAL_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../../../shared/constants';
import type { CanvasDrawing, CanvasNode, Point } from '../../../shared/types';
import { ContextMenus } from '../components/ContextMenus';
import { BandNode } from '../nodes/BandNode';
import { CrossFloorBadgeLayer } from '../nodes/CrossFloorBadgeLayer';
import { FicharioNode } from '../nodes/FicharioNode';
import { FileTreeNode } from '../nodes/FileTreeNode';
import { PortalNode } from '../nodes/PortalNode';
import { StickyNoteNode } from '../nodes/StickyNoteNode';
import { TerminalNode } from '../nodes/TerminalNode';
import {
  activeLevelAtom,
  activeSheetAtom,
  activeWorkspaceAtom,
  canvasContextMenuAtom,
  canvasModeAtom,
  canvasOffsetAtom,
  canvasViewportSizeAtom,
  connectingCursorAtom,
  connectingFromNodeIdAtom,
  drawingColorAtom,
  drawingToolAtom,
  liftedNodeIdAtom,
  liveFramesAtom,
  marqueeAtom,
  nodeContextMenuAtom,
  pendingPresetIdAtom,
  preferencesAtom,
  ropePopoverAtom,
  selectedNodeIdsAtom,
  snapGuidesAtom,
  tieLassoAtom,
  zoomAtom,
} from '../state/atoms';
import {
  getTmuxPrefixControlChar,
  getTmuxPrefixLabel,
  matchesTmuxPrefix,
  pendingTerminalFocusAtom,
  tmuxPrefixActiveAtom,
  tmuxPrefixSettingAtom,
} from '../state/ui-atoms';
import {
  computeZoomToFit,
  focusTerminalTarget,
  getTerminalTargets,
} from './canvas-navigation';
import { ConnectionsLayer, getRopePointsMap } from './ConnectionsLayer';
import { DrawingsLayer } from './DrawingsLayer';
import { GraphPaperGrid } from './GraphPaperGrid';
import { GroupFrameLayer } from './GroupFrameLayer';
import { Minimap } from './Minimap';
import { segmentsIntersect } from './rope-physics';

function getEventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function hasScrollableAncestor(el: Element | null, boundary: HTMLElement | null): boolean {
  let cur: Element | null = el;
  while (cur && cur !== boundary) {
    const tag = cur.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'WEBVIEW') {
      return true;
    }
    const style = window.getComputedStyle(cur);
    const canScrollY =
      /(auto|scroll|overlay)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight;
    const canScrollX =
      /(auto|scroll|overlay)/.test(style.overflowX) && cur.scrollWidth > cur.clientWidth;
    if (canScrollY || canScrollX) return true;
    cur = cur.parentElement;
  }
  return false;
}

function shouldIgnoreCanvasWheel(target: EventTarget | null, boundary: HTMLElement | null): boolean {
  const el = getEventTargetElement(target);
  if (!el) return false;
  if (
    el.closest(
      '[data-canvas-node-id], [data-canvas-overlay="true"], .xterm, .xterm-viewport, .glass-strong'
    )
  ) {
    return true;
  }
  return hasScrollableAncestor(el, boundary);
}

export const CanvasViewport: React.FC = () => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const prefs = useAtomValue(preferencesAtom);
  const [mode, setMode] = useAtom(canvasModeAtom);
  const drawingTool = useAtomValue(drawingToolAtom);
  const drawingColor = useAtomValue(drawingColorAtom);
  const [offset, setOffset] = useAtom(canvasOffsetAtom);
  const [zoom, setZoom] = useAtom(zoomAtom);
  const [selectedIds, setSelectedIds] = useAtom(selectedNodeIdsAtom);
  const [connectingFrom, setConnectingFrom] = useAtom(connectingFromNodeIdAtom);
  const setConnectingCursor = useSetAtom(connectingCursorAtom);
  const [tieLasso, setTieLasso] = useAtom(tieLassoAtom);
  const [marquee, setMarquee] = useAtom(marqueeAtom);
  const snapGuides = useAtomValue(snapGuidesAtom);
  const liveFrames = useAtomValue(liveFramesAtom);
  const [liftedNodeId, setLiftedNodeId] = useAtom(liftedNodeIdAtom);
  const setRopePopover = useSetAtom(ropePopoverAtom);
  const setCanvasMenu = useSetAtom(canvasContextMenuAtom);
  const setNodeMenu = useSetAtom(nodeContextMenuAtom);
  const [sheet, setSheet] = useAtom(activeSheetAtom);
  const [pendingPresetId, setPendingPresetId] = useAtom(pendingPresetIdAtom);
  const tmuxPrefixSetting = useAtomValue(tmuxPrefixSettingAtom);
  const [tmuxPrefixActive, setTmuxPrefixActive] = useAtom(tmuxPrefixActiveAtom);
  const [pendingTerminalFocus, setPendingTerminalFocus] = useAtom(pendingTerminalFocusAtom);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const prefixBannerRef = useRef<HTMLDivElement | null>(null);
  const tmuxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedLevelKeyRef = useRef<string | null>(null);
  const [viewportSize, setViewportSize] = useAtom(canvasViewportSizeAtom);
  const [spacePressed, setSpacePressed] = useState(false);
  const [previewDrawing, setPreviewDrawing] = useState<CanvasDrawing | null>(null);

  // Compute hidden member IDs (terminals inside a Band, notes inside a Fichário)
  const hiddenMemberIds = new Set<string>();
  for (const n of level.nodes) {
    if (n.content.kind === 'band') {
      for (const mid of n.content.band.memberNodeIds) hiddenMemberIds.add(mid);
    } else if (n.content.kind === 'noteStack') {
      for (const mid of n.content.noteStack.memberNodeIds) hiddenMemberIds.add(mid);
    }
  }
  const visibleNodes = level.nodes.filter((n) => !hiddenMemberIds.has(n.id));

  const tmuxStateRef = useRef({
    workspace,
    level,
    visibleNodes,
    selectedIds,
    liftedNodeId,
    zoom,
    viewportSize,
    liveFrames,
    sheet,
    tmuxPrefixSetting,
    tmuxPrefixActive,
  });
  tmuxStateRef.current = {
    workspace,
    level,
    visibleNodes,
    selectedIds,
    liftedNodeId,
    zoom,
    viewportSize,
    liveFrames,
    sheet,
    tmuxPrefixSetting,
    tmuxPrefixActive,
  };

  const clearTmuxPrefix = useCallback(() => {
    if (tmuxTimerRef.current) {
      clearTimeout(tmuxTimerRef.current);
      tmuxTimerRef.current = null;
    }
    setTmuxPrefixActive(false);
  }, [setTmuxPrefixActive]);

  const armTmuxPrefix = useCallback(() => {
    if (tmuxTimerRef.current) {
      clearTimeout(tmuxTimerRef.current);
    }
    setTmuxPrefixActive(true);
    tmuxTimerRef.current = setTimeout(() => {
      tmuxTimerRef.current = null;
      setTmuxPrefixActive(false);
    }, 2000);
  }, [setTmuxPrefixActive]);

  // Sync camera from workspace/floor change
  useEffect(() => {
    if (!workspace) return;
    const activeFloor = workspace.activeFloorId
      ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
      : null;
    setOffset(activeFloor ? activeFloor.canvasOrigin : workspace.canvasOrigin);
    setZoom(activeFloor ? activeFloor.canvasZoom : workspace.canvasZoom);
  }, [workspace?.id, workspace?.activeFloorId]);

  // Consume cross-workspace/floor terminal focus requests (e.g. from attention notifications)
  useEffect(() => {
    if (!workspace) return;
    const curLevelKey = `${workspace.id}::${workspace.activeFloorId ?? ''}`;
    const levelJustChanged = syncedLevelKeyRef.current !== curLevelKey;
    syncedLevelKeyRef.current = curLevelKey;

    if (!pendingTerminalFocus) return;
    if (
      pendingTerminalFocus.workspaceId &&
      pendingTerminalFocus.workspaceId.toLowerCase() !== workspace.id.toLowerCase()
    ) {
      return;
    }
    const reqFloor = pendingTerminalFocus.floorId ?? null;
    const curFloor = workspace.activeFloorId ?? null;
    if ((reqFloor ?? '').toLowerCase() !== (curFloor ?? '').toLowerCase()) {
      return;
    }

    const targets = getTerminalTargets(level);
    const target = targets.find(
      (t) =>
        t.terminal.id.toLowerCase() === pendingTerminalFocus.terminalId.toLowerCase() ||
        (pendingTerminalFocus.nodeId !== null &&
          t.terminalNode.id.toLowerCase() === pendingTerminalFocus.nodeId.toLowerCase())
    );

    setPendingTerminalFocus(null);
    if (!target) return;
    if (sheet) setSheet(null);

    const activeFloor = workspace.activeFloorId
      ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
      : null;
    const focusZoom = levelJustChanged
      ? activeFloor
        ? activeFloor.canvasZoom
        : workspace.canvasZoom
      : zoom;

    focusTerminalTarget(target, {
      workspaceId: workspace.id,
      viewportSize,
      zoom: focusZoom,
      liveFrames,
      liftedNodeId,
      setLiftedNodeId,
      setOffset,
      setSelectedIds,
    });
  }, [
    pendingTerminalFocus,
    workspace,
    level,
    zoom,
    viewportSize,
    liveFrames,
    liftedNodeId,
    sheet,
    setPendingTerminalFocus,
    setSheet,
    setLiftedNodeId,
    setOffset,
    setSelectedIds,
  ]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setViewportSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onTmuxKeyDown = (e: KeyboardEvent) => {
      const s = tmuxStateRef.current;
      if (s.sheet !== null || !s.workspace || s.tmuxPrefixSetting === 'off') {
        if (s.tmuxPrefixActive) clearTmuxPrefix();
        return;
      }

      const target = e.target as HTMLElement | null;
      const isInXterm = Boolean(target?.closest('.xterm'));
      const isInTextInput =
        !isInXterm &&
        Boolean(
          target &&
            (target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.tagName === 'SELECT' ||
              target.isContentEditable)
        );
      if (isInTextInput) {
        if (s.tmuxPrefixActive) clearTmuxPrefix();
        return;
      }

      const resolveFocusedNodeId = (): string | null => {
        const activeEl = document.activeElement;
        const nodeEl =
          activeEl instanceof Element ? activeEl.closest('[data-canvas-node-id]') : null;
        if (nodeEl instanceof HTMLElement && nodeEl.dataset.canvasNodeId) {
          return nodeEl.dataset.canvasNodeId;
        }
        if (s.liftedNodeId) return s.liftedNodeId;
        for (const id of s.selectedIds) return id;
        return null;
      };

      const resolveFocusedTerminalId = (nodeId: string | null): string | null => {
        if (!nodeId) return null;
        const found = s.level.nodes.find((n) => n.id === nodeId);
        if (!found) return null;
        if (found.content.kind === 'terminal') return found.content.terminal.id;
        if (found.content.kind === 'band') {
          const activeId =
            found.content.band.selectedMemberNodeId ?? found.content.band.memberNodeIds[0];
          const member = activeId ? s.level.nodes.find((n) => n.id === activeId) : null;
          if (member?.content.kind === 'terminal') return member.content.terminal.id;
        }
        return null;
      };

      // Arm prefix: capture only exact prefix (no extra modifiers, not repeated, not already prevented).
      // In xterm, double-pressing the prefix (e.g. Ctrl+B Ctrl+B) forwards the literal control char to the PTY.
      if (!s.tmuxPrefixActive) {
        if (!e.defaultPrevented && matchesTmuxPrefix(e, s.tmuxPrefixSetting)) {
          e.preventDefault();
          e.stopPropagation();
          armTmuxPrefix();
        }
        return;
      }

      if (
        e.key === 'Control' ||
        e.key === 'Shift' ||
        e.key === 'Alt' ||
        e.key === 'Meta' ||
        e.key === 'CapsLock'
      ) {
        return;
      }

      if (matchesTmuxPrefix(e, s.tmuxPrefixSetting)) {
        e.preventDefault();
        e.stopPropagation();
        clearTmuxPrefix();
        if (isInXterm) {
          const termId = resolveFocusedTerminalId(resolveFocusedNodeId());
          const ctrlChar = getTmuxPrefixControlChar(s.tmuxPrefixSetting);
          if (termId && ctrlChar) {
            window.maestri.terminal.write(termId, ctrlChar);
          }
        }
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) {
        clearTmuxPrefix();
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      clearTmuxPrefix();

      if (e.key === 'Escape') {
        return;
      }

      const key = e.key.toLowerCase();
      const targets = getTerminalTargets(s.level);
      const focusCtx = {
        workspaceId: s.workspace.id,
        viewportSize: s.viewportSize,
        zoom: s.zoom,
        liveFrames: s.liveFrames,
        liftedNodeId: s.liftedNodeId,
        setLiftedNodeId,
        setOffset,
        setSelectedIds,
      };

      if (/^[1-9]$/.test(key)) {
        const targetTerm = targets[Number(key) - 1];
        if (targetTerm) focusTerminalTarget(targetTerm, focusCtx);
        return;
      }

      if (key === 'n' || key === 'p') {
        if (targets.length === 0) return;
        const focusedId = resolveFocusedNodeId();
        const focusedNode = focusedId ? s.level.nodes.find((n) => n.id === focusedId) : null;
        let curIdx = -1;
        if (focusedNode?.content.kind === 'band') {
          const bandMemberId =
            focusedNode.content.band.selectedMemberNodeId ??
            focusedNode.content.band.memberNodeIds[0];
          curIdx = targets.findIndex((t) => t.terminalNode.id === bandMemberId);
        } else if (focusedId) {
          curIdx = targets.findIndex((t) => t.terminalNode.id === focusedId);
        }
        const nextIdx =
          curIdx === -1
            ? key === 'n'
              ? 0
              : targets.length - 1
            : key === 'n'
              ? (curIdx + 1) % targets.length
              : (curIdx - 1 + targets.length) % targets.length;
        focusTerminalTarget(targets[nextIdx], focusCtx);
        return;
      }

      if (key === 'z') {
        if (s.liftedNodeId) {
          setLiftedNodeId(null);
        } else {
          const targetId =
            resolveFocusedNodeId() ?? targets[0]?.focusNode.id ?? s.visibleNodes[0]?.id ?? null;
          if (targetId) setLiftedNodeId(targetId);
        }
        return;
      }

      if (key === 'f') {
        if (s.liftedNodeId) setLiftedNodeId(null);
        const fit = computeZoomToFit(s.visibleNodes, s.liveFrames, s.viewportSize);
        setZoom(fit.zoom);
        setOffset(fit.offset);
      }
    };

    const onTmuxBlur = () => {
      if (tmuxStateRef.current.tmuxPrefixActive) clearTmuxPrefix();
    };

    const onTmuxPointerDown = (ev: PointerEvent) => {
      if (!tmuxStateRef.current.tmuxPrefixActive) return;
      if (
        prefixBannerRef.current &&
        ev.target instanceof Node &&
        prefixBannerRef.current.contains(ev.target)
      ) {
        return;
      }
      clearTmuxPrefix();
    };

    window.addEventListener('keydown', onTmuxKeyDown, true);
    window.addEventListener('blur', onTmuxBlur);
    window.addEventListener('pointerdown', onTmuxPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onTmuxKeyDown, true);
      window.removeEventListener('blur', onTmuxBlur);
      window.removeEventListener('pointerdown', onTmuxPointerDown, true);
      if (tmuxTimerRef.current) clearTimeout(tmuxTimerRef.current);
    };
  }, [armTmuxPrefix, clearTmuxPrefix, setLiftedNodeId, setOffset, setSelectedIds, setZoom]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (tmuxStateRef.current.tmuxPrefixActive) return;
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.closest('.xterm') !== null ||
          target.isContentEditable);
      if (isInput) return;

      if (e.code === 'Space') setSpacePressed(true);
      if (e.key === 'Escape') {
        setConnectingFrom(null);
        setConnectingCursor(null);
        setLiftedNodeId(null);
        setRopePopover(null);
        setMode('select');
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0 && workspace) {
        void window.maestri.node.deleteMany(workspace.id, [...selectedIds]);
        setSelectedIds(new Set());
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && workspace) {
        e.preventDefault();
        if (e.shiftKey) void window.maestri.workspace.redo(workspace.id);
        else void window.maestri.workspace.undo(workspace.id);
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'v') setMode('select');
        else if (k === 'h') setMode('pan');
        else if (k === 't') setMode('terminal');
        else if (k === 'n') setMode('note');
        else if (k === 'c') setMode('connect');
        else if (k === 'p') setMode('portal');
        else if (k === 'f') setMode('fileTree');
        else if (k === 'd') setMode('draw');
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [workspace, selectedIds]);

  const screenToWorld = (clientX: number, clientY: number): Point => {
    const rect = rootRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      x: (clientX - rect.left) / zoom + offset.x,
      y: (clientY - rect.top) / zoom + offset.y,
    };
  };

  useEffect(() => {
    // Prevent Chromium page-zoom on Ctrl/Cmd+wheel anywhere in the app window
    // without marking React's onWheel non-passive.
    const preventPageZoom = (ev: WheelEvent) => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
      }
    };
    window.addEventListener('wheel', preventPageZoom, { passive: false });
    return () => window.removeEventListener('wheel', preventPageZoom);
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    // While a node is lifted (focus mode) the wheel belongs to that node (e.g. xterm scrollback).
    if (liftedNodeId) return;
    // Never pan or zoom the canvas when the wheel originates inside any node, overlay, or scrollable control.
    if (shouldIgnoreCanvasWheel(e.target, rootRef.current)) return;

    if (e.ctrlKey || e.metaKey) {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.002);
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      const worldX = mx / zoom + offset.x;
      const worldY = my / zoom + offset.y;
      setZoom(nextZoom);
      setOffset({ x: worldX - mx / nextZoom, y: worldY - my / nextZoom });
    } else {
      setOffset((prev) => ({
        x: prev.x + e.deltaX / zoom,
        y: prev.y + e.deltaY / zoom,
      }));
    }
  };

  const spawnNodeAt = async (kind: 'terminal' | 'note' | 'portal' | 'fileTree', pt: Point) => {
    if (!workspace) return;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const floor = workspace.activeFloorId
      ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
      : null;
    const cwd = floor?.clonePath || workspace.workingDirectory;

    let node: CanvasNode;
    if (kind === 'terminal') {
      const preset =
        (pendingPresetId && prefs.agentPresets.find((p) => p.id === pendingPresetId)) ||
        prefs.agentPresets.find((p) => p.agentType === 'shell') ||
        prefs.agentPresets[0];
      setPendingPresetId(null);

      const termCount = level.nodes.filter((n) => n.content.kind === 'terminal').length + 1;
      node = {
        id,
        frame: {
          x: Math.round(pt.x - DEFAULT_TERMINAL_SIZE.width / 2),
          y: Math.round(pt.y - DEFAULT_TERMINAL_SIZE.height / 2),
          width: DEFAULT_TERMINAL_SIZE.width,
          height: DEFAULT_TERMINAL_SIZE.height,
        },
        zIndex: 1,
        groupId: null,
        createdAt: now,
        lastModifiedAt: now,
        content: {
          kind: 'terminal',
          terminal: {
            id: crypto.randomUUID(),
            name: preset?.name && preset.agentType !== 'shell' ? `${preset.name} ${termCount}` : `Agent ${termCount}`,
            command: preset?.command || null,
            workingDirectory: cwd,
            agentType: preset?.agentType ?? 'shell',
            presetId: preset?.id ?? null,
            roleId: null,
            roleName: null,
            isManager: preset?.maestroMode ?? false,
            inChatMode: preset?.startInChatMode ?? false,
            color: preset?.color ?? '#0a84ff',
            icon: preset?.icon ?? 'terminal',
            accountName: preset?.account ?? 'Default',
            isUnloaded: false,
          },
        },
      };
    } else if (kind === 'note') {
      const nCount = level.nodes.filter((n) => n.content.kind === 'stickyNote').length + 1;
      node = {
        id,
        frame: {
          x: Math.round(pt.x - DEFAULT_NOTE_SIZE.width / 2),
          y: Math.round(pt.y - DEFAULT_NOTE_SIZE.height / 2),
          width: DEFAULT_NOTE_SIZE.width,
          height: DEFAULT_NOTE_SIZE.height,
        },
        zIndex: 1,
        groupId: null,
        createdAt: now,
        lastModifiedAt: now,
        content: {
          kind: 'stickyNote',
          stickyNote: {
            fileName: `Note ${nCount}.md`,
            customName: null,
            color: prefs.defaultNoteColor || 'yellow',
            customColor: null,
            isContentLocked: false,
            fontFamily: null,
            text: `# Note ${nCount}\n\n`,
            storageMode: { kind: 'managed' },
          },
        },
      };
    } else if (kind === 'portal') {
      node = {
        id,
        frame: {
          x: Math.round(pt.x - DEFAULT_PORTAL_SIZE.width / 2),
          y: Math.round(pt.y - DEFAULT_PORTAL_SIZE.height / 2),
          width: DEFAULT_PORTAL_SIZE.width,
          height: DEFAULT_PORTAL_SIZE.height,
        },
        zIndex: 1,
        groupId: null,
        createdAt: now,
        lastModifiedAt: now,
        content: {
          kind: 'portal',
          portal: {
            id: crypto.randomUUID(),
            name: 'Portal',
            url: 'http://localhost:3000',
            userAgentPreset: 'desktop',
            viewportSize: null,
          },
        },
      };
    } else {
      node = {
        id,
        frame: {
          x: Math.round(pt.x - DEFAULT_FILE_TREE_SIZE.width / 2),
          y: Math.round(pt.y - DEFAULT_FILE_TREE_SIZE.height / 2),
          width: DEFAULT_FILE_TREE_SIZE.width,
          height: DEFAULT_FILE_TREE_SIZE.height,
        },
        zIndex: 1,
        groupId: null,
        createdAt: now,
        lastModifiedAt: now,
        content: {
          kind: 'fileTree',
          fileTree: {
            id: crypto.randomUUID(),
            rootPath: cwd,
            expandedPaths: [],
            showHidden: false,
          },
        },
      };
    }

    await window.maestri.node.create(workspace.id, node);
    setSelectedIds(new Set([node.id]));
    setMode('select');
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setRopePopover(null);
    setCanvasMenu(null);
    setNodeMenu(null);
    if (!workspace) return;

    // Middle mouse or Pan mode or Spacebar pan
    if (e.button === 1 || mode === 'pan' || spacePressed) {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startOffset = { ...offset };

      const onMove = (ev: PointerEvent) => {
        setOffset({
          x: startOffset.x - (ev.clientX - startX) / zoom,
          y: startOffset.y - (ev.clientY - startY) / zoom,
        });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    if (e.button !== 0) return;

    const worldPt = screenToWorld(e.clientX, e.clientY);

    if (mode === 'terminal' || mode === 'note' || mode === 'portal' || mode === 'fileTree') {
      void spawnNodeAt(mode, worldPt);
      return;
    }

    if (mode === 'connect') {
      setConnectingFrom(null);
      setConnectingCursor(null);
      return;
    }

    if (mode === 'cableTie') {
      const start = worldPt;
      setTieLasso({ start, end: start });
      const onMove = (ev: PointerEvent) => {
        setTieLasso({ start, end: screenToWorld(ev.clientX, ev.clientY) });
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const end = screenToWorld(ev.clientX, ev.clientY);
        setTieLasso(null);

        const ropes = getRopePointsMap();
        const crossed: string[] = [];
        const hits: Point[] = [];
        for (const [rid, pts] of ropes.entries()) {
          for (let i = 0; i < pts.length - 1; i++) {
            const hit = segmentsIntersect(start, end, pts[i], pts[i + 1]);
            if (hit) {
              crossed.push(rid);
              hits.push(hit);
              break;
            }
          }
        }
        if (crossed.length >= 2) {
          const avgX = hits.reduce((s, p) => s + p.x, 0) / hits.length;
          const avgY = hits.reduce((s, p) => s + p.y, 0) / hits.length;
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const len = Math.hypot(dx, dy) || 1;
          void window.maestri.cableTie.create(workspace.id, {
            id: crypto.randomUUID(),
            position: { x: avgX, y: avgY },
            perp: { x: dx / len, y: dy / len },
            memberRopeIds: crossed,
          });
        }
        setMode('select');
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    if (mode === 'draw') {
      const id = crypto.randomUUID();
      let points: Point[] = [worldPt];
      const base: CanvasDrawing = {
        id,
        tool: drawingTool,
        points,
        color: drawingColor,
        lineWidth: 2.5,
        layer: 'background',
      };
      setPreviewDrawing(base);

      const onMove = (ev: PointerEvent) => {
        const pt = screenToWorld(ev.clientX, ev.clientY);
        if (drawingTool === 'pen') {
          points = [...points, pt];
        } else {
          points = [points[0], pt];
        }
        setPreviewDrawing({ ...base, points });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setPreviewDrawing(null);
        if (points.length >= 2) {
          void window.maestri.drawing.create(workspace.id, { ...base, points });
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    // Marquee selection
    setSelectedIds(new Set());
    const start = worldPt;
    setMarquee({ start, end: start });
    const onMove = (ev: PointerEvent) => {
      const end = screenToWorld(ev.clientX, ev.clientY);
      setMarquee({ start, end });
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);

      const inside = new Set<string>();
      for (const n of level.nodes) {
        const f = liveFrames.get(n.id) ?? n.frame;
        if (f.x < maxX && f.x + f.width > minX && f.y < maxY && f.y + f.height > minY) {
          inside.add(n.id);
        }
      }
      setSelectedIds(inside);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setMarquee(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selectedArray = [...selectedIds];
  const selectedTerminalsCount = selectedArray.filter(
    (id) => level.nodes.find((n) => n.id === id)?.content.kind === 'terminal'
  ).length;

  const cursorClass =
    mode === 'pan' || spacePressed
      ? 'cursor-grab active:cursor-grabbing'
      : mode === 'connect' || mode === 'draw' || mode === 'cableTie'
        ? 'cursor-crosshair'
        : mode === 'terminal' || mode === 'note' || mode === 'portal' || mode === 'fileTree'
          ? 'cursor-copy'
          : 'cursor-default';

  const contentTransform =
    zoom === 1
      ? { left: -offset.x, top: -offset.y, transform: 'none' }
      : {
          left: 0,
          top: 0,
          transform: `translate(${-offset.x * zoom}px, ${-offset.y * zoom}px) scale(${zoom})`,
        };

  return (
    <div
      ref={rootRef}
      data-canvas-viewport="true"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setNodeMenu(null);
        const wp = screenToWorld(e.clientX, e.clientY);
        setCanvasMenu({ screenX: e.clientX, screenY: e.clientY, worldX: wp.x, worldY: wp.y });
      }}
      onPointerMove={(e) => {
        if (connectingFrom) {
          setConnectingCursor(screenToWorld(e.clientX, e.clientY));
        }
      }}
      className={`relative h-full w-full overflow-hidden outline-none ${cursorClass}`}
    >
      <GraphPaperGrid />
      <GroupFrameLayer />
      <ConnectionsLayer />

      {/* Transformed Canvas World Plane */}
      <div
        className="absolute left-0 top-0"
        style={{
          ...contentTransform,
          transformOrigin: '0 0',
          width: 0,
          height: 0,
            // When a node is lifted the whole plane must sit above the canvas chrome, because the
          // lifted node and its backdrop live inside this transformed stacking context.
          zIndex: liftedNodeId ? 9000 : 10,
        }}
      >
        <DrawingsLayer previewDrawing={previewDrawing} />

        {/* Lift Backdrop — rendered in world space so it stays under the lifted node */}
        {liftedNodeId && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setLiftedNodeId(null)}
            className="absolute bg-black/55 backdrop-blur-sm"
            style={{
              left: offset.x,
              top: offset.y,
              width: viewportSize.width / zoom,
              height: viewportSize.height / zoom,
              zIndex: 9000,
            }}
          />
        )}

        {visibleNodes.map((node) => {
          switch (node.content.kind) {
            case 'terminal':
              return <TerminalNode key={node.id} node={node} />;
            case 'band':
              return <BandNode key={node.id} node={node} />;
            case 'stickyNote':
              return <StickyNoteNode key={node.id} node={node} />;
            case 'noteStack':
              return <FicharioNode key={node.id} node={node} />;
            case 'portal':
              return <PortalNode key={node.id} node={node} />;
            case 'fileTree':
              return <FileTreeNode key={node.id} node={node} />;
            default:
              return null;
          }
        })}

        <CrossFloorBadgeLayer />

        {/* Magnetic Snap Guides */}
        {snapGuides.x !== null && (
          <div
            className="pointer-events-none fixed top-[-10000px] h-[20000px] w-px bg-[var(--accent)] opacity-70"
            style={{ left: snapGuides.x }}
          />
        )}
        {snapGuides.y !== null && (
          <div
            className="pointer-events-none fixed left-[-10000px] h-px w-[20000px] bg-[var(--accent)] opacity-70"
            style={{ top: snapGuides.y }}
          />
        )}

        {/* Marquee Box */}
        {marquee && (
          <div
            className="pointer-events-none absolute rounded-lg border border-[var(--accent)] bg-[var(--accent)]/15"
            style={{
              left: Math.min(marquee.start.x, marquee.end.x),
              top: Math.min(marquee.start.y, marquee.end.y),
              width: Math.abs(marquee.end.x - marquee.start.x),
              height: Math.abs(marquee.end.y - marquee.start.y),
              zIndex: 999,
            }}
          />
        )}
      </div>

      {/* Multi-selection Action Bar */}
      {selectedArray.length >= 2 && workspace && (
        <div
          data-canvas-overlay="true"
          onPointerDown={(e) => e.stopPropagation()}
          className="glass-strong fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-[var(--border)] px-3 py-1.5 text-xs shadow-2xl"
        >
          <span className="px-1.5 font-medium text-[var(--muted-foreground)]">
            {selectedArray.length} selected
          </span>
          <button
            type="button"
            onClick={() => void window.maestri.group.create(workspace.id, selectedArray)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-[var(--bg-hover)]"
          >
            <Layers className="size-3.5" />
            Group
          </button>
          {selectedTerminalsCount >= 2 && (
            <button
              type="button"
              onClick={() => setSheet({ kind: 'bandCreate', nodeIds: selectedArray })}
              className="flex items-center gap-1 rounded-lg bg-[var(--accent)]/20 px-2 py-1 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/30"
            >
              <Users className="size-3.5" />
              Form Band
            </button>
          )}
          {selectedArray.length === 2 && (
            <button
              type="button"
              onClick={() =>
                void window.maestri.connection.connectNodes(
                  workspace.id,
                  selectedArray[0],
                  selectedArray[1]
                )
              }
              className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-[var(--bg-hover)]"
            >
              <Link2 className="size-3.5" />
              Connect
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void window.maestri.node.deleteMany(workspace.id, selectedArray);
              setSelectedIds(new Set());
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[var(--destructive)] hover:bg-[var(--destructive)]/15"
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
        </div>
      )}

      {tmuxPrefixActive && (
        <div
          ref={prefixBannerRef}
          data-canvas-overlay="true"
          onPointerDown={(e) => e.stopPropagation()}
          className="glass-strong fixed bottom-3 left-3 z-30 flex items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--muted-foreground)] shadow-xl"
        >
          <span className="flex items-center gap-1.5 font-medium text-[var(--foreground)]">
            <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            <kbd className="rounded border border-[var(--border-strong)] bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--foreground)]">
              {getTmuxPrefixLabel(tmuxPrefixSetting)}
            </kbd>
          </span>
          <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
            <span>1–9 focus</span>
            <span>n/p cycle</span>
            <span>z expand</span>
            <span>f fit</span>
          </span>
          <button
            type="button"
            onClick={clearTmuxPrefix}
            className="rounded px-1 py-0.5 font-mono text-[10px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            title="Cancel prefix (Esc)"
          >
            Esc
          </button>
        </div>
      )}

      <Minimap viewportSize={viewportSize} />
      <ContextMenus />
    </div>
  );
};
