import React from 'react';
import { useAtomValue } from 'jotai';
import type { CanvasDrawing } from '../../../shared/types';
import { activeLevelAtom, activeWorkspaceAtom, canvasModeAtom } from '../state/atoms';

interface Props {
  previewDrawing?: CanvasDrawing | null;
}

function renderShape(d: CanvasDrawing, onDelete?: () => void) {
  const { tool, points, color, lineWidth } = d;
  if (points.length === 0) return null;

  if (tool === 'pen') {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    return (
      <path
        key={d.id}
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={lineWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        onDoubleClick={onDelete}
        className="pointer-events-auto cursor-pointer"
      />
    );
  }

  const p0 = points[0];
  const p1 = points[points.length - 1];
  const x = Math.min(p0.x, p1.x);
  const y = Math.min(p0.y, p1.y);
  const w = Math.abs(p1.x - p0.x);
  const h = Math.abs(p1.y - p0.y);

  if (tool === 'rect') {
    return (
      <rect
        key={d.id}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill={`${color}18`}
        stroke={color}
        strokeWidth={lineWidth}
        onDoubleClick={onDelete}
        className="pointer-events-auto cursor-pointer"
      />
    );
  }

  if (tool === 'ellipse') {
    return (
      <ellipse
        key={d.id}
        cx={x + w / 2}
        cy={y + h / 2}
        rx={w / 2}
        ry={h / 2}
        fill={`${color}18`}
        stroke={color}
        strokeWidth={lineWidth}
        onDoubleClick={onDelete}
        className="pointer-events-auto cursor-pointer"
      />
    );
  }

  if (tool === 'line' || tool === 'arrow') {
    const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const head = 12;
    const ax1 = p1.x - head * Math.cos(angle - Math.PI / 6);
    const ay1 = p1.y - head * Math.sin(angle - Math.PI / 6);
    const ax2 = p1.x - head * Math.cos(angle + Math.PI / 6);
    const ay2 = p1.y - head * Math.sin(angle + Math.PI / 6);
    return (
      <g key={d.id} onDoubleClick={onDelete} className="pointer-events-auto cursor-pointer">
        <line
          x1={p0.x}
          y1={p0.y}
          x2={p1.x}
          y2={p1.y}
          stroke={color}
          strokeWidth={lineWidth}
          strokeLinecap="round"
        />
        {tool === 'arrow' && (
          <path
            d={`M ${ax1} ${ay1} L ${p1.x} ${p1.y} L ${ax2} ${ay2}`}
            fill="none"
            stroke={color}
            strokeWidth={lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
    );
  }

  return null;
}

export const DrawingsLayer: React.FC<Props> = ({ previewDrawing }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const mode = useAtomValue(canvasModeAtom);

  return (
    <svg
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      style={{ width: 1, height: 1, zIndex: 1 }}
    >
      {level.drawings.map((d) =>
        renderShape(d, () => {
          if (workspace && (mode === 'select' || mode === 'draw')) {
            void window.orkestrei.drawing.delete(workspace.id, d.id);
          }
        })
      )}
      {previewDrawing && renderShape(previewDrawing)}
    </svg>
  );
};
