import React from 'react';
import { useAtomValue } from 'jotai';
import { activeLevelAtom, canvasOffsetAtom, liveFramesAtom, zoomAtom } from '../state/atoms';

export const GroupFrameLayer: React.FC = () => {
  const level = useAtomValue(activeLevelAtom);
  const offset = useAtomValue(canvasOffsetAtom);
  const zoom = useAtomValue(zoomAtom);
  const liveFrames = useAtomValue(liveFramesAtom);

  if (level.groups.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 2 }}>
      {level.groups.map((group) => {
        const members = level.nodes.filter((n) => n.groupId === group.id);
        if (members.length === 0) return null;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const m of members) {
          const f = liveFrames.get(m.id) ?? m.frame;
          minX = Math.min(minX, f.x);
          minY = Math.min(minY, f.y);
          maxX = Math.max(maxX, f.x + f.width);
          maxY = Math.max(maxY, f.y + f.height);
        }
        const pad = 22;
        const left = (minX - pad - offset.x) * zoom;
        const top = (minY - pad - 24 - offset.y) * zoom;
        const width = (maxX - minX + pad * 2) * zoom;
        const height = (maxY - minY + pad * 2 + 24) * zoom;
        const color = group.colorHex || '#0a84ff';

        return (
          <div
            key={group.id}
            className="absolute rounded-2xl border-2 border-dashed"
            style={{
              left,
              top,
              width,
              height,
              borderColor: `${color}66`,
              backgroundColor: `${color}0d`,
            }}
          >
            {group.name && (
              <span
                className="absolute left-3 top-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold"
                style={{ color }}
              >
                {group.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
