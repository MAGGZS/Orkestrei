import React, { useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Eye, EyeOff } from 'lucide-react';
import type { CanvasNode, Rect } from '../../../shared/types';
import {
  activeLevelAtom,
  activeWorkspaceAtom,
  canvasModeAtom,
  canvasOffsetAtom,
  canvasViewportSizeAtom,
  connectingCursorAtom,
  connectingFromNodeIdAtom,
  draggingNodeIdsAtom,
  liftedNodeIdAtom,
  liveFramesAtom,
  nodeContextMenuAtom,
  selectedNodeIdsAtom,
  snapGuidesAtom,
  zoomAtom,
} from '../state/atoms';

interface NodeFrameProps {
  node: CanvasNode;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  children: (ctx: {
    startDrag: (e: React.PointerEvent) => void;
    isSelected: boolean;
    isLifted: boolean;
    toggleLift: () => void;
  }) => React.ReactNode;
}

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const NodeFrame: React.FC<NodeFrameProps> = ({
  node,
  minWidth = 200,
  minHeight = 160,
  className = '',
  style,
  children,
}) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const zoom = useAtomValue(zoomAtom);
  const viewportSize = useAtomValue(canvasViewportSizeAtom);
  const offset = useAtomValue(canvasOffsetAtom);
  const mode = useAtomValue(canvasModeAtom);
  const [selectedIds, setSelectedIds] = useAtom(selectedNodeIdsAtom);
  const setDraggingIds = useSetAtom(draggingNodeIdsAtom);
  const [liveFrames, setLiveFrames] = useAtom(liveFramesAtom);
  const liveFramesRef = useRef(liveFrames);
  liveFramesRef.current = liveFrames;
  const setSnapGuides = useSetAtom(snapGuidesAtom);
  const [liftedNodeId, setLiftedNodeId] = useAtom(liftedNodeIdAtom);
  const [connectingFrom, setConnectingFrom] = useAtom(connectingFromNodeIdAtom);
  const setConnectingCursor = useSetAtom(connectingCursorAtom);
  const setNodeContextMenu = useSetAtom(nodeContextMenuAtom);

  const liveRect = liveFrames.get(node.id) ?? node.frame;
  const isSelected = selectedIds.has(node.id);
  const isLifted = liftedNodeId === node.id;
  const isConnectSource = connectingFrom === node.id;

  const dragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    initialFrames: Map<string, Rect>;
    latestFrames: Map<string, Rect>;
  } | null>(null);
  const resizeLatestFrameRef = useRef<Rect | null>(null);

  const selectThis = (additive: boolean) => {
    setSelectedIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      }
      if (prev.has(node.id)) return prev;
      return new Set([node.id]);
    });
  };

  const handleCompleteConnection = (e: React.PointerEvent | React.MouseEvent) => {
    if (!workspace) return;
    if (connectingFrom && connectingFrom !== node.id) {
      e.stopPropagation();
      void window.orkestrei.connection.connectNodes(workspace.id, connectingFrom, node.id);
      setConnectingFrom(null);
      setConnectingCursor(null);
      return true;
    }
    return false;
  };

  const startDrag = (e: React.PointerEvent) => {
    if (isLifted || e.button !== 0) return;
    if (mode === 'connect') {
      e.stopPropagation();
      if (!connectingFrom) {
        setConnectingFrom(node.id);
      } else if (connectingFrom !== node.id && workspace) {
        void window.orkestrei.connection.connectNodes(workspace.id, connectingFrom, node.id);
        setConnectingFrom(null);
        setConnectingCursor(null);
      } else {
        setConnectingFrom(null);
        setConnectingCursor(null);
      }
      return;
    }

    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const movingIds = new Set(selectedIds.has(node.id) && !additive ? selectedIds : [node.id]);
    if (!selectedIds.has(node.id) || additive) {
      selectThis(additive);
    }

    // Include group members if any
    for (const id of [...movingIds]) {
      const target = level.nodes.find((n) => n.id === id);
      if (target?.groupId) {
        for (const peer of level.nodes) {
          if (peer.groupId === target.groupId) movingIds.add(peer.id);
        }
      }
    }

    const initialFrames = new Map<string, Rect>();
    for (const id of movingIds) {
      const n = level.nodes.find((x) => x.id === id);
      if (n) initialFrames.set(id, { ...n.frame });
    }

    dragStateRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      initialFrames,
      latestFrames: new Map(),
    };
    setDraggingIds(movingIds);

    const onMove = (ev: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const dx = (ev.clientX - st.startClientX) / zoom;
      const dy = (ev.clientY - st.startClientY) / zoom;

      let snapDx = 0;
      let snapDy = 0;
      let guideX: number | null = null;
      let guideY: number | null = null;

      const primaryInit = st.initialFrames.get(node.id);
      if (primaryInit && !ev.altKey) {
        const candX = primaryInit.x + dx;
        const candY = primaryInit.y + dy;
        const threshold = 7;
        for (const other of level.nodes) {
          if (st.initialFrames.has(other.id)) continue;
          if (Math.abs(candX - other.frame.x) < threshold) {
            snapDx = other.frame.x - candX;
            guideX = other.frame.x;
          } else if (Math.abs(candX + primaryInit.width - (other.frame.x + other.frame.width)) < threshold) {
            snapDx = other.frame.x + other.frame.width - (candX + primaryInit.width);
            guideX = other.frame.x + other.frame.width;
          }
          if (Math.abs(candY - other.frame.y) < threshold) {
            snapDy = other.frame.y - candY;
            guideY = other.frame.y;
          } else if (Math.abs(candY + primaryInit.height - (other.frame.y + other.frame.height)) < threshold) {
            snapDy = other.frame.y + other.frame.height - (candY + primaryInit.height);
            guideY = other.frame.y + other.frame.height;
          }
        }
      }

      setSnapGuides({ x: guideX, y: guideY });

      const batchFrames = new Map<string, Rect>();
      for (const [id, init] of st.initialFrames.entries()) {
        const nextFrame: Rect = {
          ...init,
          x: Math.round(init.x + dx + snapDx),
          y: Math.round(init.y + dy + snapDy),
        };
        st.latestFrames.set(id, nextFrame);
        batchFrames.set(id, nextFrame);
      }

      setLiveFrames((prev) => {
        const next = new Map(prev);
        for (const [id, frame] of batchFrames.entries()) {
          next.set(id, frame);
        }
        return next;
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const st = dragStateRef.current;
      dragStateRef.current = null;
      setDraggingIds(new Set());
      setSnapGuides({ x: null, y: null });

      if (st && workspace) {
        const currentFrames = liveFramesRef.current;
        const patches: Array<{ nodeId: string; frame: Rect }> = [];
        for (const [id] of st.initialFrames.entries()) {
          const f = st.latestFrames.get(id) ?? currentFrames.get(id);
          if (f) patches.push({ nodeId: id, frame: f });
        }
        setLiveFrames((prev) => {
          const next = new Map(prev);
          for (const [id] of st.initialFrames.entries()) {
            next.delete(id);
          }
          return next;
        });
        if (patches.length > 0) {
          void window.orkestrei.node.patchFrames(workspace.id, patches);
        }
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startResize = (dir: ResizeDir, e: React.PointerEvent) => {
    if (isLifted || e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const init = { ...liveRect };
    resizeLatestFrameRef.current = null;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      let { x, y, width, height } = init;

      if (dir.includes('e')) width = Math.max(minWidth, init.width + dx);
      if (dir.includes('s')) height = Math.max(minHeight, init.height + dy);
      if (dir.includes('w')) {
        const nextW = Math.max(minWidth, init.width - dx);
        x = init.x + (init.width - nextW);
        width = nextW;
      }
      if (dir.includes('n')) {
        const nextH = Math.max(minHeight, init.height - dy);
        y = init.y + (init.height - nextH);
        height = nextH;
      }

      const nextFrame: Rect = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
      resizeLatestFrameRef.current = nextFrame;

      setLiveFrames((prev) => {
        const next = new Map(prev);
        next.set(node.id, nextFrame);
        return next;
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!workspace) return;
      const finalFrame = resizeLatestFrameRef.current ?? liveFramesRef.current.get(node.id);
      resizeLatestFrameRef.current = null;
      setLiveFrames((prev) => {
        if (!prev.has(node.id)) return prev;
        const next = new Map(prev);
        next.delete(node.id);
        return next;
      });
      if (finalFrame) {
        void window.orkestrei.node.patchFrames(workspace.id, [{ nodeId: node.id, frame: finalFrame }]);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startRopeFromPort = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!workspace) return;
    setConnectingFrom(node.id);

    const onMove = (ev: PointerEvent) => {
      const viewportEl = document.querySelector('[data-canvas-viewport="true"]');
      const rect = viewportEl?.getBoundingClientRect();
      if (!rect) return;
      setConnectingCursor({
        x: (ev.clientX - rect.left) / zoom + offset.x,
        y: (ev.clientY - rect.top) / zoom + offset.y,
      });
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetNodeEl = targetEl?.closest('[data-canvas-node-id]') as HTMLElement | null;
      const targetId = targetNodeEl?.dataset.canvasNodeId;
      if (targetId && targetId !== node.id) {
        void window.orkestrei.connection.connectNodes(workspace.id, node.id, targetId);
      }
      setConnectingFrom(null);
      setConnectingCursor(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Lifted (focus) frame. The node lives inside the transformed world plane, so `position: fixed`
  // would resolve against that plane (wrong place, scaled, and trapped under the backdrop).
  // Instead place it in world coordinates over the visible viewport and cancel the zoom with an
  // inverse scale, so the content renders 1:1 in screen pixels.
  const liftMarginX = Math.max(16, Math.round(viewportSize.width * 0.04));
  const liftMarginY = 16;
  const liftedScreenW = Math.max(minWidth, viewportSize.width - liftMarginX * 2);
  const liftedScreenH = Math.max(minHeight, viewportSize.height - liftMarginY * 2);

  const frameStyle: React.CSSProperties = isLifted
    ? {
        position: 'absolute',
        left: offset.x + liftMarginX / zoom,
        top: offset.y + liftMarginY / zoom,
        width: liftedScreenW,
        height: liftedScreenH,
        transform: zoom === 1 ? undefined : `scale(${1 / zoom})`,
        transformOrigin: '0 0',
        zIndex: 9500,
        boxShadow: '0 24px 70px rgba(0, 0, 0, 0.72), 0 0 0 1px var(--accent)',
        ...style,
      }
    : {
        position: 'absolute',
        left: liveRect.x,
        top: liveRect.y,
        width: liveRect.width,
        height: liveRect.height,
        zIndex: isSelected ? node.zIndex + 50 : node.zIndex,
        boxShadow: isConnectSource
          ? '0 0 0 2px var(--accent), var(--shadow-node-selected)'
          : isSelected
            ? 'var(--shadow-node-selected)'
            : 'var(--shadow-node)',
        ...style,
      };

  const showPorts = connectingFrom !== null || mode === 'connect';

  return (
    <div
      data-canvas-node-id={node.id}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        selectThis(false);
        setNodeContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
      }}
      onPointerDown={(e) => {
        if (handleCompleteConnection(e)) return;
        if (mode === 'connect') {
          e.stopPropagation();
          setConnectingFrom(node.id);
          return;
        }
        e.stopPropagation();
        selectThis(e.shiftKey || e.ctrlKey || e.metaKey);
      }}
      onPointerUp={(e) => {
        if (connectingFrom && connectingFrom !== node.id) {
          handleCompleteConnection(e);
        }
      }}
      className={`group rounded-lg transition-shadow ${
        mode === 'connect' ? 'cursor-crosshair' : ''
      } ${className}`}
      style={frameStyle}
    >
      {children({
        startDrag,
        isSelected,
        isLifted,
        toggleLift: () => setLiftedNodeId(isLifted ? null : node.id),
      })}

      {/* Redacted / Blur privacy cover */}
      {node.isRedacted && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg bg-[var(--background)]/75 p-4 text-center backdrop-blur-md"
        >
          <div className="flex size-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)]/90 text-[var(--muted-foreground)] shadow-lg">
            <EyeOff className="size-4" />
          </div>
          <div className="text-xs font-medium text-[var(--foreground)]">Content hidden</div>
          <button
            type="button"
            onClick={() => {
              if (workspace) void window.orkestrei.node.setRedacted(workspace.id, node.id, false);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--bg-hover)]"
          >
            <Eye className="size-3" />
            Reveal
          </button>
        </div>
      )}

      {/* Edge connection ports (only in connect mode) */}
      {!isLifted && showPorts && (
        <>
          <button
            type="button"
            title="Drag to connect"
            onPointerDown={startRopeFromPort}
            className="absolute -left-1.5 top-1/2 z-20 size-2.5 -translate-y-1/2 rounded-full border-[1.5px] border-[var(--background)] bg-[var(--accent)] opacity-90 hover:opacity-100"
          />
          <button
            type="button"
            title="Drag to connect"
            onPointerDown={startRopeFromPort}
            className="absolute -right-1.5 top-1/2 z-20 size-2.5 -translate-y-1/2 rounded-full border-[1.5px] border-[var(--background)] bg-[var(--accent)] opacity-90 hover:opacity-100"
          />
          <button
            type="button"
            title="Drag to connect"
            onPointerDown={startRopeFromPort}
            className="absolute -top-1.5 left-1/2 z-20 size-2.5 -translate-x-1/2 rounded-full border-[1.5px] border-[var(--background)] bg-[var(--accent)] opacity-90 hover:opacity-100"
          />
          <button
            type="button"
            title="Drag to connect"
            onPointerDown={startRopeFromPort}
            className="absolute -bottom-1.5 left-1/2 z-20 size-2.5 -translate-x-1/2 rounded-full border-[1.5px] border-[var(--background)] bg-[var(--accent)] opacity-90 hover:opacity-100"
          />
        </>
      )}

      {/* Resize handles */}
      {!isLifted && (
        <>
          <div
            onPointerDown={(e) => startResize('e', e)}
            className="absolute bottom-2 right-0 top-2 w-1.5 cursor-ew-resize"
          />
          <div
            onPointerDown={(e) => startResize('w', e)}
            className="absolute bottom-2 left-0 top-2 w-1.5 cursor-ew-resize"
          />
          <div
            onPointerDown={(e) => startResize('s', e)}
            className="absolute bottom-0 left-2 right-2 h-1.5 cursor-ns-resize"
          />
          <div
            onPointerDown={(e) => startResize('se', e)}
            className="absolute bottom-0 right-0 size-3.5 cursor-nwse-resize"
          />
          <div
            onPointerDown={(e) => startResize('sw', e)}
            className="absolute bottom-0 left-0 size-3.5 cursor-nesw-resize"
          />
        </>
      )}
    </div>
  );
};
