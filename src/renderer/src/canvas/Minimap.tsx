import React, { useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Map as MapIcon } from 'lucide-react';
import { MAX_ZOOM, MIN_ZOOM } from '../../../shared/constants';
import {
  activeLevelAtom,
  canvasOffsetAtom,
  liveFramesAtom,
  zoomAtom,
} from '../state/atoms';

export const Minimap: React.FC<{ viewportSize: { width: number; height: number } }> = ({
  viewportSize,
}) => {
  const [open, setOpen] = useState(false);
  const level = useAtomValue(activeLevelAtom);
  const [offset, setOffset] = useAtom(canvasOffsetAtom);
  const [zoom, setZoom] = useAtom(zoomAtom);
  const liveFrames = useAtomValue(liveFramesAtom);
  const setZoomOnly = useSetAtom(zoomAtom);

  const mapW = 180;
  const mapH = 116;

  const rects = level.nodes.map((n) => ({
    id: n.id,
    kind: n.content.kind,
    frame: liveFrames.get(n.id) ?? n.frame,
  }));

  const camWorld = {
    x: offset.x,
    y: offset.y,
    width: viewportSize.width / zoom,
    height: viewportSize.height / zoom,
  };

  let minX = camWorld.x;
  let minY = camWorld.y;
  let maxX = camWorld.x + camWorld.width;
  let maxY = camWorld.y + camWorld.height;

  for (const r of rects) {
    minX = Math.min(minX, r.frame.x - 100);
    minY = Math.min(minY, r.frame.y - 100);
    maxX = Math.max(maxX, r.frame.x + r.frame.width + 100);
    maxY = Math.max(maxY, r.frame.y + r.frame.height + 100);
  }

  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const scale = Math.min((mapW - 12) / worldW, (mapH - 12) / worldH);

  const toMapX = (wx: number) => 6 + (wx - minX) * scale;
  const toMapY = (wy: number) => 6 + (wy - minY) * scale;

  const handleJump = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = (e.clientX - rect.left - 6) / scale + minX;
    const clickY = (e.clientY - rect.top - 6) / scale + minY;
    setOffset({
      x: clickX - camWorld.width / 2,
      y: clickY - camWorld.height / 2,
    });
  };

  return (
    <div
      data-canvas-overlay="true"
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed bottom-3 right-3 z-30 flex flex-col items-end gap-1.5"
    >
      {open && (
        <div className="glass-strong overflow-hidden rounded-lg shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted-foreground)]">
            <span>Overview</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              Hide
            </button>
          </div>
          <div
            onClick={handleJump}
            className="relative cursor-crosshair bg-[var(--canvas-bg)]/90"
            style={{ width: mapW, height: mapH }}
          >
            {rects.map((r) => {
              const color =
                r.kind === 'stickyNote' || r.kind === 'noteStack'
                  ? 'rgba(255, 245, 157, 0.55)'
                  : r.kind === 'terminal'
                    ? 'rgba(237, 237, 237, 0.28)'
                    : 'rgba(142, 142, 147, 0.25)';
              return (
                <div
                  key={r.id}
                  className="absolute rounded-[2px]"
                  style={{
                    left: toMapX(r.frame.x),
                    top: toMapY(r.frame.y),
                    width: Math.max(4, r.frame.width * scale),
                    height: Math.max(3, r.frame.height * scale),
                    backgroundColor: color,
                  }}
                />
              );
            })}
            <div
              className="pointer-events-none absolute rounded-[2px] border border-[var(--accent)]/80 bg-[var(--accent)]/10"
              style={{
                left: toMapX(camWorld.x),
                top: toMapY(camWorld.y),
                width: camWorld.width * scale,
                height: camWorld.height * scale,
              }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`glass flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors ${
            open
              ? 'text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
          }`}
          title="Toggle minimap"
        >
          <MapIcon className="size-3.5" />
        </button>

        <div className="glass flex h-7 items-center rounded-full px-1 text-[11px] tabular-nums text-[var(--muted-foreground)]">
          <button
            type="button"
            onClick={() => setZoomOnly((z) => Math.max(MIN_ZOOM, +(z - 0.15).toFixed(2)))}
            className="flex size-5 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            title="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
            className="min-w-[40px] text-center font-medium transition-colors hover:text-[var(--foreground)]"
            title="Reset zoom and pan"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoomOnly((z) => Math.min(MAX_ZOOM, +(z + 0.15).toFixed(2)))}
            className="flex size-5 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
};
