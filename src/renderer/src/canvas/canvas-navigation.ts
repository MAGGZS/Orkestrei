import { MAX_ZOOM, MIN_ZOOM } from '../../../shared/constants';
import type { CanvasLevelContents, CanvasNode, Point, Rect, TerminalData } from '../../../shared/types';

export interface TerminalTarget {
  terminalNode: CanvasNode;
  terminal: TerminalData;
  /** The visible canvas node to center/select/lift (the Band if inside one, otherwise terminalNode). */
  focusNode: CanvasNode;
  bandNode: CanvasNode | null;
  label: string;
}

export function getNodeLiveFrame(node: CanvasNode, liveFrames: Map<string, Rect>): Rect {
  return liveFrames.get(node.id) ?? node.frame;
}

export function getBandMemberMap(level: CanvasLevelContents): Map<string, CanvasNode> {
  const bandByMemberId = new Map<string, CanvasNode>();
  for (const n of level.nodes) {
    if (n.content.kind === 'band') {
      for (const mid of n.content.band.memberNodeIds) {
        bandByMemberId.set(mid, n);
      }
    }
  }
  return bandByMemberId;
}

export function getStackMemberMap(level: CanvasLevelContents): Map<string, CanvasNode> {
  const stackByMemberId = new Map<string, CanvasNode>();
  for (const n of level.nodes) {
    if (n.content.kind === 'noteStack') {
      for (const mid of n.content.noteStack.memberNodeIds) {
        stackByMemberId.set(mid, n);
      }
    }
  }
  return stackByMemberId;
}

export function getTerminalTargets(level: CanvasLevelContents): TerminalTarget[] {
  const bandByMemberId = getBandMemberMap(level);
  const targets: TerminalTarget[] = [];

  for (const n of level.nodes) {
    if (n.content.kind !== 'terminal') continue;
    const bandNode = bandByMemberId.get(n.id) ?? null;
    targets.push({
      terminalNode: n,
      terminal: n.content.terminal,
      focusNode: bandNode ?? n,
      bandNode,
      label: n.content.terminal.name,
    });
  }

  return targets;
}

export function computeCenteredOffset(
  frame: Rect,
  viewportSize: { width: number; height: number },
  zoom: number
): Point {
  const safeZoom = Math.max(MIN_ZOOM, zoom);
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  return {
    x: cx - viewportSize.width / (2 * safeZoom),
    y: cy - viewportSize.height / (2 * safeZoom),
  };
}

export function computeZoomToFit(
  visibleNodes: CanvasNode[],
  liveFrames: Map<string, Rect>,
  viewportSize: { width: number; height: number }
): { offset: Point; zoom: number } {
  if (visibleNodes.length === 0) {
    return { offset: { x: 0, y: 0 }, zoom: 1 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of visibleNodes) {
    const f = getNodeLiveFrame(n, liveFrames);
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.height);
  }

  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const padX = 64;
  const padTop = 72;
  const padBottom = 48;
  const availW = Math.max(120, viewportSize.width - padX * 2);
  const availH = Math.max(120, viewportSize.height - padTop - padBottom);

  const rawZoom = Math.min(availW / contentW, availH / contentH, 1);
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(rawZoom.toFixed(3))));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return {
    zoom: nextZoom,
    offset: {
      x: cx - viewportSize.width / (2 * nextZoom),
      y: cy - viewportSize.height / (2 * nextZoom) - (padTop - padBottom) / (2 * nextZoom),
    },
  };
}

export function focusNodeXterm(focusNodeId: string): void {
  const tryFocus = () => {
    const nodeEl = document.querySelector(`[data-canvas-node-id="${CSS.escape(focusNodeId)}"]`);
    if (!nodeEl) return;
    const activeContainer = nodeEl.querySelector('[data-band-active="true"]') ?? nodeEl;
    const textarea = activeContainer.querySelector(
      'textarea.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null;
    textarea?.focus({ preventScroll: true });
  };
  window.requestAnimationFrame(() => {
    tryFocus();
    window.setTimeout(tryFocus, 40);
  });
}

export interface FocusTargetContext {
  workspaceId: string;
  viewportSize: { width: number; height: number };
  zoom: number;
  liveFrames: Map<string, Rect>;
  liftedNodeId: string | null;
  setLiftedNodeId: (id: string | null) => void;
  setOffset: (p: Point) => void;
  setSelectedIds: (ids: Set<string>) => void;
}

export function focusTerminalTarget(target: TerminalTarget, ctx: FocusTargetContext): void {
  if (ctx.liftedNodeId && ctx.liftedNodeId !== target.focusNode.id) {
    ctx.setLiftedNodeId(null);
  }
  if (
    target.bandNode &&
    target.bandNode.content.kind === 'band' &&
    target.bandNode.content.band.selectedMemberNodeId !== target.terminalNode.id
  ) {
    void window.orkestrei.band.select(ctx.workspaceId, target.bandNode.id, target.terminalNode.id);
  }
  const frame = getNodeLiveFrame(target.focusNode, ctx.liveFrames);
  ctx.setOffset(computeCenteredOffset(frame, ctx.viewportSize, ctx.zoom));
  ctx.setSelectedIds(new Set([target.focusNode.id]));
  focusNodeXterm(target.focusNode.id);
}
