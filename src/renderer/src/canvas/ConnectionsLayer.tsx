import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Unlink } from 'lucide-react';
import type { CableTie, CanvasNode, Point, Rect } from '../../../shared/types';
import { useDismissable } from '../components/useDismissable';
import {
  activeLevelAtom,
  activeWorkspaceAtom,
  asksInFlightAtom,
  canvasOffsetAtom,
  connectingCursorAtom,
  connectingFromNodeIdAtom,
  liveFramesAtom,
  recentTransfersAtom,
  ropePopoverAtom,
  tieLassoAtom,
  zoomAtom,
} from '../state/atoms';
import {
  FIXED_DT,
  MAX_SUBSTEPS,
  pointsToSmoothSvgPath,
  Rope,
  SLEEP_THRESHOLD,
  type TieTarget,
} from './rope-physics';

interface RopeDescriptor {
  id: string;
  kind: 'terminal' | 'note' | 'noteToNote' | 'portal' | 'portalToPortal';
  nodeA: CanvasNode;
  nodeB: CanvasNode;
  endpointIdA: string;
  endpointIdB: string;
  labelA: string;
  labelB: string;
  isActiveTraffic: boolean;
}

const ropeCache = new Map<string, Rope>();

export function getRopePointsMap(): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  for (const [id, rope] of ropeCache.entries()) {
    out.set(id, rope.points);
  }
  return out;
}

function getNodeLabel(node: CanvasNode): string {
  switch (node.content.kind) {
    case 'terminal':
      return node.content.terminal.name;
    case 'band':
      return node.content.band.name;
    case 'stickyNote':
      return node.content.stickyNote.customName || node.content.stickyNote.fileName.replace(/\.md$/i, '');
    case 'noteStack':
      return node.content.noteStack.name;
    case 'portal':
      return node.content.portal.name || 'Portal';
    case 'fileTree':
      return 'Files';
    default:
      return 'Node';
  }
}

function resolveRopePins(rectA: Rect, rectB: Rect): { start: Point; end: Point } {
  const cxA = rectA.x + rectA.width / 2;
  const cyA = rectA.y + rectA.height / 2;
  const cxB = rectB.x + rectB.width / 2;
  const cyB = rectB.y + rectB.height / 2;
  const dx = cxB - cxA;
  const dy = cyB - cyA;

  if (Math.abs(dx) >= Math.abs(dy) * 0.65) {
    return dx >= 0
      ? { start: { x: rectA.x + rectA.width, y: cyA }, end: { x: rectB.x, y: cyB } }
      : { start: { x: rectA.x, y: cyA }, end: { x: rectB.x + rectB.width, y: cyB } };
  }
  return dy >= 0
    ? { start: { x: cxA, y: rectA.y + rectA.height }, end: { x: cxB, y: rectB.y } }
    : { start: { x: cxA, y: rectA.y }, end: { x: cxB, y: rectB.y + rectB.height } };
}

export const ConnectionsLayer: React.FC = () => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const offset = useAtomValue(canvasOffsetAtom);
  const zoom = useAtomValue(zoomAtom);
  const liveFrames = useAtomValue(liveFramesAtom);
  const asksInFlight = useAtomValue(asksInFlightAtom);
  const recentTransfers = useAtomValue(recentTransfersAtom);
  const connectingFrom = useAtomValue(connectingFromNodeIdAtom);
  const connectingCursor = useAtomValue(connectingCursorAtom);
  const tieLasso = useAtomValue(tieLassoAtom);
  const [ropePopover, setRopePopover] = useAtom(ropePopoverAtom);

  const [, setTick] = useState(0);
  const [hoveredRopeId, setHoveredRopeId] = useState<string | null>(null);
  const [hoveredTieId, setHoveredTieId] = useState<string | null>(null);
  const draggingTieRef = useRef<{ tieId: string; startPos: Point } | null>(null);
  const awakeUntilRef = useRef<number>(0);
  const ropePopoverRef = useRef<HTMLDivElement | null>(null);

  useDismissable(Boolean(ropePopover), ropePopoverRef, () => setRopePopover(null));

  const frameOf = (node: CanvasNode): Rect => liveFrames.get(node.id) ?? node.frame;

  // Map nodes + terminal IDs + stacked notes -> visible canvas node
  const descriptors = useMemo<RopeDescriptor[]>(() => {
    const visibleById = new Map<string, CanvasNode>();
    const nodeByTerminalId = new Map<string, CanvasNode>();
    const nodeByStackedNoteId = new Map<string, CanvasNode>();
    const bandMemberTermIds = new Map<string, Set<string>>();

    for (const n of level.nodes) {
      if (n.content.kind === 'band') {
        visibleById.set(n.id, n);
        const set = new Set<string>();
        for (const mid of n.content.band.memberNodeIds) {
          const member = level.nodes.find((x) => x.id === mid);
          if (member && member.content.kind === 'terminal') {
            nodeByTerminalId.set(member.content.terminal.id, n);
            nodeByTerminalId.set(member.id, n);
            set.add(member.content.terminal.id.toLowerCase());
          }
        }
        bandMemberTermIds.set(n.id, set);
      } else if (n.content.kind === 'noteStack') {
        visibleById.set(n.id, n);
        for (const mid of n.content.noteStack.memberNodeIds) {
          nodeByStackedNoteId.set(mid, n);
        }
      }
    }

    for (const n of level.nodes) {
      if (n.content.kind === 'terminal') {
        if (!nodeByTerminalId.has(n.content.terminal.id)) {
          visibleById.set(n.id, n);
          nodeByTerminalId.set(n.content.terminal.id, n);
          nodeByTerminalId.set(n.id, n);
        }
      } else if (n.content.kind === 'stickyNote') {
        if (!nodeByStackedNoteId.has(n.id)) {
          visibleById.set(n.id, n);
        }
      } else if (n.content.kind !== 'band' && n.content.kind !== 'noteStack') {
        visibleById.set(n.id, n);
      }
    }

    const activeTrafficPairs = new Set<string>();
    const addTrafficPair = (a: string, b: string) => {
      activeTrafficPairs.add(`${a.toLowerCase()}::${b.toLowerCase()}`);
      activeTrafficPairs.add(`${b.toLowerCase()}::${a.toLowerCase()}`);
    };
    for (const ask of Object.values(asksInFlight)) {
      addTrafficPair(ask.fromTerminalId, ask.toTerminalId);
    }
    const now = Date.now();
    for (const tr of recentTransfers) {
      if (now - tr.timestamp < 2200) {
        addTrafficPair(tr.fromTerminalId, tr.toTerminalId);
      }
    }

    const isPairActive = (nodeA: CanvasNode, nodeB: CanvasNode): boolean => {
      const termsA =
        nodeA.content.kind === 'terminal'
          ? [nodeA.content.terminal.id]
          : nodeA.content.kind === 'band'
            ? [...(bandMemberTermIds.get(nodeA.id) ?? [])]
            : [];
      const termsB =
        nodeB.content.kind === 'terminal'
          ? [nodeB.content.terminal.id]
          : nodeB.content.kind === 'band'
            ? [...(bandMemberTermIds.get(nodeB.id) ?? [])]
            : [];
      for (const a of termsA) {
        for (const b of termsB) {
          if (activeTrafficPairs.has(`${a.toLowerCase()}::${b.toLowerCase()}`)) return true;
        }
      }
      return false;
    };

    const list: RopeDescriptor[] = [];

    for (const c of level.connections) {
      const nA = nodeByTerminalId.get(c.terminalIdA) ?? visibleById.get(c.terminalIdA);
      const nB = nodeByTerminalId.get(c.terminalIdB) ?? visibleById.get(c.terminalIdB);
      if (!nA || !nB || nA.id === nB.id) continue;
      list.push({
        id: c.id,
        kind: 'terminal',
        nodeA: nA,
        nodeB: nB,
        endpointIdA: c.terminalIdA,
        endpointIdB: c.terminalIdB,
        labelA: getNodeLabel(nA),
        labelB: getNodeLabel(nB),
        isActiveTraffic: isPairActive(nA, nB),
      });
    }

    for (const c of level.noteConnections) {
      const nA = nodeByTerminalId.get(c.terminalId) ?? visibleById.get(c.terminalId);
      const nB = nodeByStackedNoteId.get(c.noteNodeId) ?? visibleById.get(c.noteNodeId);
      if (!nA || !nB || nA.id === nB.id) continue;
      list.push({
        id: c.id,
        kind: 'note',
        nodeA: nA,
        nodeB: nB,
        endpointIdA: c.terminalId,
        endpointIdB: c.noteNodeId,
        labelA: getNodeLabel(nA),
        labelB: getNodeLabel(nB),
        isActiveTraffic: false,
      });
    }

    for (const c of level.noteToNoteConnections) {
      const nA = nodeByStackedNoteId.get(c.noteNodeIdA) ?? visibleById.get(c.noteNodeIdA);
      const nB = nodeByStackedNoteId.get(c.noteNodeIdB) ?? visibleById.get(c.noteNodeIdB);
      if (!nA || !nB || nA.id === nB.id) continue;
      list.push({
        id: c.id,
        kind: 'noteToNote',
        nodeA: nA,
        nodeB: nB,
        endpointIdA: c.noteNodeIdA,
        endpointIdB: c.noteNodeIdB,
        labelA: getNodeLabel(nA),
        labelB: getNodeLabel(nB),
        isActiveTraffic: false,
      });
    }

    for (const c of level.portalConnections) {
      const nA = nodeByTerminalId.get(c.terminalId) ?? visibleById.get(c.terminalId);
      const nB = visibleById.get(c.portalNodeId);
      if (!nA || !nB || nA.id === nB.id) continue;
      list.push({
        id: c.id,
        kind: 'portal',
        nodeA: nA,
        nodeB: nB,
        endpointIdA: c.terminalId,
        endpointIdB: c.portalNodeId,
        labelA: getNodeLabel(nA),
        labelB: getNodeLabel(nB),
        isActiveTraffic: false,
      });
    }

    for (const c of level.portalToPortalConnections) {
      const nA = visibleById.get(c.portalNodeIdA);
      const nB = visibleById.get(c.portalNodeIdB);
      if (!nA || !nB || nA.id === nB.id) continue;
      list.push({
        id: c.id,
        kind: 'portalToPortal',
        nodeA: nA,
        nodeB: nB,
        endpointIdA: c.portalNodeIdA,
        endpointIdB: c.portalNodeIdB,
        labelA: getNodeLabel(nA),
        labelB: getNodeLabel(nB),
        isActiveTraffic: false,
      });
    }

    return list;
  }, [level, asksInFlight, recentTransfers]);

  // Wake simulation whenever descriptors, liveFrames, or cableTies change
  useEffect(() => {
    awakeUntilRef.current = performance.now() + 2600;
  }, [descriptors, liveFrames, level.cableTies]);

  useEffect(() => {
    if (descriptors.length === 0) return;

    let rafId = 0;
    let lastTime = performance.now();

    const stepSimulation = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, MAX_SUBSTEPS * FIXED_DT);
      lastTime = now;

      const tiesByRope = new Map<string, TieTarget[]>();
      for (const tie of level.cableTies) {
        const tangent = { x: -tie.perp.y, y: tie.perp.x };
        for (const rid of tie.memberRopeIds) {
          const arr = tiesByRope.get(rid) ?? [];
          arr.push({ id: tie.id, point: tie.position, tangent });
          tiesByRope.set(rid, arr);
        }
      }

      const obstacles: Rect[] = level.nodes
        .filter((n) => {
          // Only top-level visible cards act as obstacles
          return n.content.kind === 'terminal' || n.content.kind === 'band' || n.content.kind === 'portal';
        })
        .map((n) => frameOf(n));

      let maxMove = 0;
      const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(dt / FIXED_DT)));
      const subDt = dt / substeps || FIXED_DT;

      for (const desc of descriptors) {
        const rA = frameOf(desc.nodeA);
        const rB = frameOf(desc.nodeB);
        const { start, end } = resolveRopePins(rA, rB);
        let rope = ropeCache.get(desc.id);
        if (!rope) {
          rope = new Rope(start, end);
          rope.settle(30, obstacles, tiesByRope.get(desc.id) ?? []);
          ropeCache.set(desc.id, rope);
        } else {
          const pinMoved =
            Math.hypot(rope.pinStart.x - start.x, rope.pinStart.y - start.y) > 0.5 ||
            Math.hypot(rope.pinEnd.x - end.x, rope.pinEnd.y - end.y) > 0.5;
          rope.pinStart = start;
          rope.pinEnd = end;
          if (pinMoved) {
            awakeUntilRef.current = Math.max(awakeUntilRef.current, now + 1800);
          }
        }

        const targets = tiesByRope.get(desc.id) ?? [];
        const localObstacles = obstacles.filter(
          (obs) => obs !== rA && obs !== rB
        );
        for (let s = 0; s < substeps; s++) {
          rope.step(subDt, localObstacles, targets);
        }
        if (rope.lastMovement > maxMove) maxMove = rope.lastMovement;
      }

      setTick((t) => (t + 1) % 1000000);

      if (now < awakeUntilRef.current || maxMove > SLEEP_THRESHOLD) {
        rafId = requestAnimationFrame(stepSimulation);
      }
    };

    rafId = requestAnimationFrame(stepSimulation);
    return () => cancelAnimationFrame(rafId);
  }, [descriptors, liveFrames, level.cableTies]);

  // Cable tie drag
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = draggingTieRef.current;
      if (!drag || !workspace) return;
      const worldPt = {
        x: e.clientX / zoom + offset.x,
        y: e.clientY / zoom + offset.y,
      };
      // adjust relative to canvas container? Wait: we calculate delta from screen movement
      void worldPt;
    };
    const onUp = () => {
      draggingTieRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [workspace, zoom, offset]);

  const worldToScreen = (pt: Point): Point => ({
    x: (pt.x - offset.x) * zoom,
    y: (pt.y - offset.y) * zoom,
  });

  // Preview rope while connecting
  let previewPath = '';
  if (connectingFrom && connectingCursor) {
    const src = level.nodes.find((n) => n.id === connectingFrom);
    if (src) {
      const rect = frameOf(src);
      const start = worldToScreen({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
      const end = worldToScreen(connectingCursor);
      const midY = (start.y + end.y) / 2 + 45 * zoom;
      previewPath = `M ${start.x} ${start.y} Q ${(start.x + end.x) / 2} ${midY} ${end.x} ${end.y}`;
    }
  }

  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        style={{ zIndex: 5 }}
      >
        <defs>
          <filter id="rope-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {descriptors.map((desc) => {
          const rA = frameOf(desc.nodeA);
          const rB = frameOf(desc.nodeB);
          const { start, end } = resolveRopePins(rA, rB);
          const rope = ropeCache.get(desc.id) ?? new Rope(start, end);
          const screenPts = rope.points.map(worldToScreen);
          const d = pointsToSmoothSvgPath(screenPts);
          const isHovered = hoveredRopeId === desc.id;
          const isNote = desc.kind === 'note' || desc.kind === 'noteToNote';
          const isPortal = desc.kind === 'portal' || desc.kind === 'portalToPortal';

          const baseStroke = desc.isActiveTraffic
            ? '#0a84ff'
            : isHovered
              ? 'var(--foreground)'
              : isPortal
                ? 'rgba(191, 90, 242, 0.58)'
                : isNote
                  ? 'rgba(255, 214, 10, 0.55)'
                  : 'var(--rope)';

          return (
            <g key={desc.id} className="pointer-events-auto cursor-pointer">
              {/* Wide invisible hit target */}
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                onMouseEnter={() => setHoveredRopeId(desc.id)}
                onMouseLeave={() => setHoveredRopeId(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setRopePopover({
                    connectionId: desc.id,
                    x: e.clientX,
                    y: e.clientY,
                    labelA: desc.labelA,
                    labelB: desc.labelB,
                  });
                }}
              />
              {/* Main cable */}
              <path
                d={d}
                fill="none"
                stroke={baseStroke}
                strokeWidth={desc.isActiveTraffic ? 2.8 : isHovered ? 2.5 : 2}
                strokeDasharray={isNote ? '7 5' : undefined}
                strokeLinecap="round"
                filter={desc.isActiveTraffic ? 'url(#rope-glow)' : undefined}
                className="pointer-events-none transition-colors duration-150"
              />
              {/* Active transfer flow animation */}
              {desc.isActiveTraffic && (
                <path
                  d={d}
                  fill="none"
                  stroke="#64d2ff"
                  strokeWidth={3}
                  strokeLinecap="round"
                  className="pointer-events-none rope-active-flow"
                />
              )}
              {/* End connector dots */}
              {screenPts.length > 1 && (
                <>
                  <circle
                    cx={screenPts[0].x}
                    cy={screenPts[0].y}
                    r={3.5}
                    fill={desc.isActiveTraffic ? '#0a84ff' : 'var(--muted-foreground)'}
                    className="pointer-events-none"
                  />
                  <circle
                    cx={screenPts[screenPts.length - 1].x}
                    cy={screenPts[screenPts.length - 1].y}
                    r={3.5}
                    fill={desc.isActiveTraffic ? '#0a84ff' : 'var(--muted-foreground)'}
                    className="pointer-events-none"
                  />
                </>
              )}
            </g>
          );
        })}

        {/* Cable Ties */}
        {level.cableTies.map((tie: CableTie) => {
          const halfLength = ((10 + tie.memberRopeIds.length * 4) / 2) * zoom + 4;
          const center = worldToScreen(tie.position);
          const angle = (Math.atan2(tie.perp.y, tie.perp.x) * 180) / Math.PI;
          const isHov = hoveredTieId === tie.id;
          return (
            <g
              key={tie.id}
              transform={`translate(${center.x.toFixed(2)} ${center.y.toFixed(2)}) rotate(${angle.toFixed(2)})`}
              className="pointer-events-auto cursor-pointer"
              onMouseEnter={() => setHoveredTieId(tie.id)}
              onMouseLeave={() => setHoveredTieId(null)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (workspace) void window.maestri.cableTie.delete(workspace.id, tie.id);
              }}
            >
              <rect
                x={-halfLength}
                y={-2.5}
                width={halfLength * 2}
                height={5}
                rx={2.5}
                fill={isHov ? 'var(--accent)' : 'var(--muted-foreground)'}
              />
            </g>
          );
        })}

        {/* Cable tie lasso preview */}
        {tieLasso && (() => {
          const s = worldToScreen(tieLasso.start);
          const e = worldToScreen(tieLasso.end);
          return (
            <line
              x1={s.x}
              y1={s.y}
              x2={e.x}
              y2={e.y}
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="4 4"
              strokeLinecap="round"
            />
          );
        })()}

        {/* Active connection drag preview */}
        {previewPath && (
          <path
            d={previewPath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.5}
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
        )}
      </svg>

      {/* Rope Inspection / Disconnect Popover */}
      {ropePopover && workspace && (
        <div
          ref={ropePopoverRef}
          data-canvas-overlay="true"
          className="glass-strong fixed z-50 flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs shadow-xl"
          style={{ left: ropePopover.x + 8, top: ropePopover.y + 8 }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="font-medium text-[var(--foreground)]">{ropePopover.labelA}</span>
          <span className="text-[var(--muted-foreground)]">↔</span>
          <span className="font-medium text-[var(--foreground)]">{ropePopover.labelB}</span>
          <button
            type="button"
            onClick={() => {
              void window.maestri.connection.delete(workspace.id, ropePopover.connectionId);
              setRopePopover(null);
            }}
            className="ml-2 inline-flex items-center gap-1 rounded-lg bg-[var(--destructive)]/15 px-2 py-1 text-[11px] font-medium text-[var(--destructive)] hover:bg-[var(--destructive)]/25"
          >
            <Unlink className="size-3" />
            Disconnect
          </button>
        </div>
      )}
    </>
  );
};
