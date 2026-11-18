import React from 'react';
import { useAtomValue } from 'jotai';
import { CELL_WORLD_SIZE } from '../../../shared/constants';
import { canvasOffsetAtom, preferencesAtom, zoomAtom } from '../state/atoms';

export const GraphPaperGrid: React.FC = () => {
  const zoom = useAtomValue(zoomAtom);
  const offset = useAtomValue(canvasOffsetAtom);
  const prefs = useAtomValue(preferencesAtom);

  if (prefs.canvasBackground === 'solid') {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundColor: 'var(--canvas-bg)' }}
      />
    );
  }

  const thickness = (window.devicePixelRatio || 1) >= 1.5 ? 0.5 : 1;
  const cellPx = CELL_WORLD_SIZE * zoom;
  const posX = -offset.x * zoom;
  const posY = -offset.y * zoom;
  const lineColor = 'var(--grid-line)';
  const vertical = `linear-gradient(to right, ${lineColor} 0, ${lineColor} ${thickness}px, transparent ${thickness}px, transparent 100%)`;
  const horizontal = `linear-gradient(to bottom, ${lineColor} 0, ${lineColor} ${thickness}px, transparent ${thickness}px, transparent 100%)`;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundColor: 'var(--canvas-bg)',
        backgroundImage: `${vertical}, ${horizontal}`,
        backgroundSize: `${cellPx}px ${cellPx}px`,
        backgroundPosition: `${posX}px ${posY}px`,
      }}
    />
  );
};
