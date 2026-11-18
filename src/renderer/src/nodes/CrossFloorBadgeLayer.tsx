import React from 'react';
import { useAtomValue } from 'jotai';
import { ArrowLeftRight, ArrowUpRight } from 'lucide-react';
import type { CanvasNode } from '../../../shared/types';
import {
  activeLevelAtom,
  activeWorkspaceAtom,
  liveFramesAtom,
  workspacesAtom,
} from '../state/atoms';

interface BridgeBadge {
  id: string;
  label: string;
  title: string;
  kind: 'floor' | 'workspace';
  onClick: () => void;
}

export const CrossFloorBadgeLayer: React.FC = () => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const workspaces = useAtomValue(workspacesAtom);
  const level = useAtomValue(activeLevelAtom);
  const liveFrames = useAtomValue(liveFramesAtom);

  if (!workspace) return null;

  const findTerminalInWs = (
    ws: typeof workspace,
    termId: string
  ): { name: string; floorId: string | null } | null => {
    for (const n of ws.nodes) {
      if (n.content.kind === 'terminal' && n.content.terminal.id === termId) {
        return { name: n.content.terminal.name, floorId: null };
      }
    }
    for (const f of ws.floors) {
      for (const n of f.nodes) {
        if (n.content.kind === 'terminal' && n.content.terminal.id === termId) {
          return { name: n.content.terminal.name, floorId: f.id };
        }
      }
    }
    return null;
  };

  const terminalNodes = level.nodes.filter(
    (n): n is CanvasNode & { content: { kind: 'terminal'; terminal: { id: string; name: string } } } =>
      n.content.kind === 'terminal'
  );

  if (
    workspace.crossFloorConnections.length === 0 &&
    workspace.crossWorkspaceConnections.length === 0
  ) {
    return null;
  }

  return (
    <>
      {terminalNodes.map((node) => {
        const termId = node.content.terminal.id;
        const frame = liveFrames.get(node.id) ?? node.frame;
        const badges: BridgeBadge[] = [];

        for (const cf of workspace.crossFloorConnections) {
          const isA = cf.terminalIdA === termId;
          const isB = cf.terminalIdB === termId;
          if (!isA && !isB) continue;

          const peerTermId = isA ? cf.terminalIdB : cf.terminalIdA;
          const peerFloorId = isA ? cf.floorIdB : cf.floorIdA;
          const peerInfo = findTerminalInWs(workspace, peerTermId);
          const floorName = peerFloorId
            ? workspace.floors.find((f) => f.id === peerFloorId)?.name ?? 'Floor'
            : 'Ground';

          badges.push({
            id: `cf-${cf.id}-${peerTermId}`,
            label: `${peerInfo?.name ?? 'Peer'} @ ${floorName}`,
            title: `Cross-floor rope to ${peerInfo?.name ?? 'Peer'} on ${floorName}. Click to switch floor.`,
            kind: 'floor',
            onClick: () => {
              void window.maestri.floor.switch(workspace.id, peerFloorId);
            },
          });
        }

        for (const cw of workspace.crossWorkspaceConnections) {
          if (cw.localTerminalId !== termId) continue;
          const remoteWs = workspaces.find((w) => w.id === cw.remoteWorkspaceId);
          if (!remoteWs) continue;
          const remoteInfo = findTerminalInWs(remoteWs, cw.remoteTerminalId);

          badges.push({
            id: `cw-${cw.id}`,
            label: `${remoteInfo?.name ?? 'Agent'} @ ${remoteWs.name}`,
            title: `Cross-workspace link to ${remoteWs.name}. Click to switch workspace.`,
            kind: 'workspace',
            onClick: () => {
              void window.maestri.workspace.switch(remoteWs.id);
            },
          });
        }

        if (badges.length === 0) return null;

        return (
          <div
            key={`cf-badges-${node.id}`}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              left: frame.x + 10,
              top: frame.y - 26,
              zIndex: node.zIndex + 60,
            }}
            className="absolute flex max-w-[460px] flex-wrap items-center gap-1"
          >
            {badges.map((b) => (
              <button
                key={b.id}
                type="button"
                title={b.title}
                onClick={b.onClick}
                className="flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--card)]/90 px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)] backdrop-blur transition-colors hover:text-[var(--foreground)]"
              >
                {b.kind === 'workspace' ? (
                  <ArrowLeftRight className="size-2.5" />
                ) : (
                  <ArrowUpRight className="size-2.5" />
                )}
                <span className="truncate">{b.label}</span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
};
