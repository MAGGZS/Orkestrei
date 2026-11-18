import React from 'react';
import { useAtomValue } from 'jotai';
import { Crown, Plus, Trash2, Unlink, Users } from 'lucide-react';
import type { CanvasNode, TerminalData } from '../../../shared/types';
import {
  activeLevelAtom,
  activeWorkspaceAtom,
  activityStateAtom,
} from '../state/atoms';
import { NodeFrame } from './NodeFrame';
import { TerminalContentBody } from './TerminalNode';

export const BandNode: React.FC<{ node: CanvasNode }> = ({ node }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const activity = useAtomValue(activityStateAtom);

  if (node.content.kind !== 'band' || !workspace) return null;
  const band = node.content.band;

  const memberNodes = band.memberNodeIds
    .map((id) => level.nodes.find((n) => n.id === id))
    .filter((n): n is CanvasNode => Boolean(n && n.content.kind === 'terminal'));

  const selectedMember =
    memberNodes.find((n) => n.id === band.selectedMemberNodeId) ?? memberNodes[0] ?? null;

  const activeFloor = workspace.activeFloorId
    ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
    : null;
  const cwd = activeFloor?.clonePath || workspace.workingDirectory;

  const handleAddMember = async () => {
    const newTermId = crypto.randomUUID();
    const newNodeId = crypto.randomUUID();
    const now = new Date().toISOString();
    const count = memberNodes.length + 1;
    const memberNode: CanvasNode = {
      id: newNodeId,
      frame: { x: node.frame.x + 40, y: node.frame.y + 40, width: 520, height: 360 },
      zIndex: 1,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'terminal',
        terminal: {
          id: newTermId,
          name: `Member ${count}`,
          command: null,
          workingDirectory: cwd,
          agentType: 'shell',
          presetId: 'preset-shell',
          roleId: null,
          roleName: null,
          isManager: false,
          inChatMode: false,
          color: '#30d158',
          icon: 'terminal',
          accountName: 'Default',
          isUnloaded: false,
        },
      },
    };
    await window.maestri.node.create(workspace.id, memberNode);
    await window.maestri.band.addTerminal(workspace.id, node.id, newNodeId);
    await window.maestri.band.select(workspace.id, node.id, newNodeId);
  };

  return (
    <NodeFrame node={node} minWidth={560} minHeight={340}>
      {({ startDrag }) => (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-lg bg-[var(--card)]">
          {/* Band Header */}
          <div
            onPointerDown={startDrag}
            className="flex h-8 shrink-0 cursor-grab items-center justify-between border-b border-[var(--border)] bg-[var(--card)] px-3 active:cursor-grabbing"
          >
            <div className="flex items-center gap-2">
              <Users className="size-3.5 text-[var(--muted-foreground)]" />
              <span className="text-xs font-medium text-[var(--foreground)]">{band.name}</span>
              <span className="font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {memberNodes.length}
              </span>
            </div>

            <div
              className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => void handleAddMember()}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--bg-hover)]"
                title="Add agent"
              >
                <Plus className="size-3" />
                Add
              </button>
              <button
                type="button"
                onClick={() => void window.maestri.band.dissolve(workspace.id, node.id)}
                className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
                title="Dissolve band"
              >
                <Unlink className="size-3.5" />
              </button>
            </div>
          </div>

          {/* Body: Left member list + Active member terminal */}
          <div className="flex min-h-0 flex-1">
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar-bg)] p-2"
              style={{ width: band.sidebarWidth || 180 }}
            >
              <div className="mb-1.5 px-1.5 text-[11px] font-medium text-[var(--muted-foreground)]">
                Members
              </div>
              <div className="flex-1 space-y-0.5 overflow-y-auto">
                {memberNodes.map((m) => {
                  const t = (m.content as { kind: 'terminal'; terminal: TerminalData }).terminal;
                  const active = selectedMember?.id === m.id;
                  const working = activity.working.includes(t.id);
                  const running = activity.active.includes(t.id);
                  return (
                    <div
                      key={m.id}
                      onClick={() => void window.maestri.band.select(workspace.id, node.id, m.id)}
                      className={`group/row flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
                        active
                          ? 'bg-[var(--sidebar-active)] text-[var(--foreground)]'
                          : 'text-[var(--muted-foreground)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`size-2 shrink-0 rounded-full ${
                            working
                              ? 'bg-[var(--warning)]'
                              : running
                                ? 'bg-[var(--success)]'
                                : 'bg-[var(--muted-foreground)]/40'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1 truncate font-medium">
                            {t.isManager && <Crown className="size-3 shrink-0 text-[#ff9f0a]" />}
                            <span className="truncate">{t.name}</span>
                          </div>
                          {t.roleName && (
                            <div className="truncate text-[10px] opacity-75">{t.roleName}</div>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.maestri.band.removeMember(workspace.id, node.id, m.id);
                        }}
                        title="Remove from band"
                        className="hidden rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)] group-hover/row:block"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="relative min-w-0 flex-1">
              {memberNodes.length > 0 ? (
                memberNodes.map((member) => {
                  const terminal = (member.content as { kind: 'terminal'; terminal: TerminalData })
                    .terminal;
                  const isActive = selectedMember?.id === member.id;
                  return (
                    <div
                      key={terminal.id}
                      data-band-active={isActive ? 'true' : 'false'}
                      aria-hidden={!isActive}
                      className={`absolute inset-0 h-full w-full ${
                        isActive
                          ? 'visible pointer-events-auto z-10'
                          : 'invisible pointer-events-none z-0'
                      }`}
                    >
                      <TerminalContentBody
                        workspaceId={workspace.id}
                        terminal={terminal}
                        nodeId={member.id}
                      />
                    </div>
                  );
                })
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-[var(--muted-foreground)]">
                  No members in band
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </NodeFrame>
  );
};
