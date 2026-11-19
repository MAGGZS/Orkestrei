import React, { useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Bot,
  Copy,
  Crown,
  Eye,
  EyeOff,
  FolderGit2,
  FolderPlus,
  Globe,
  Layers,
  MessageSquare,
  RotateCw,
  Settings,
  Sparkles,
  StickyNote,
  Terminal,
  Trash2,
  Unlink,
} from 'lucide-react';
import {
  DEFAULT_FILE_TREE_SIZE,
  DEFAULT_NOTE_SIZE,
  DEFAULT_PORTAL_SIZE,
  DEFAULT_TERMINAL_SIZE,
} from '../../../shared/constants';
import type { CanvasNode } from '../../../shared/types';
import {
  activeLevelAtom,
  activeSheetAtom,
  activeWorkspaceAtom,
  canvasContextMenuAtom,
  nodeContextMenuAtom,
  preferencesAtom,
} from '../state/atoms';
import { useDismissable } from './useDismissable';

export const ContextMenus: React.FC = () => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const prefs = useAtomValue(preferencesAtom);
  const [canvasMenu, setCanvasMenu] = useAtom(canvasContextMenuAtom);
  const [nodeMenu, setNodeMenu] = useAtom(nodeContextMenuAtom);
  const setSheet = useSetAtom(activeSheetAtom);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useDismissable(Boolean(canvasMenu || nodeMenu), menuRef, () => {
    setCanvasMenu(null);
    setNodeMenu(null);
  });

  if (!workspace) return null;

  const spawnAt = async (
    kind: 'terminal' | 'antigravity' | 'note' | 'portal' | 'fileTree',
    worldX: number,
    worldY: number
  ) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const activeFloor = workspace.activeFloorId
      ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
      : null;
    const cwd = activeFloor?.clonePath || workspace.workingDirectory;

    let node: CanvasNode;
    if (kind === 'antigravity') {
      const preset = prefs.agentPresets.find(
        (p) => p.agentType === 'antigravity' || p.command.trim().toLowerCase() === 'agy'
      );
      const count =
        level.nodes.filter(
          (n) => n.content.kind === 'terminal' && n.content.terminal.agentType === 'antigravity'
        ).length + 1;
      node = {
        id,
        frame: {
          x: Math.round(worldX - DEFAULT_TERMINAL_SIZE.width / 2),
          y: Math.round(worldY - DEFAULT_TERMINAL_SIZE.height / 2),
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
            name: count === 1 ? 'Antigravity' : `Antigravity ${count}`,
            command: preset?.command || 'agy',
            workingDirectory: cwd,
            agentType: 'antigravity',
            presetId: preset?.id ?? 'preset-antigravity',
            roleId: null,
            roleName: null,
            isManager: preset?.maestroMode ?? false,
            inChatMode: false,
            color: preset?.color ?? '#4285f4',
            icon: preset?.icon ?? 'sparkles',
            accountName: 'Default',
            isUnloaded: false,
          },
        },
      };
    } else if (kind === 'terminal') {
      const preset =
        prefs.agentPresets.find((p) => p.agentType === 'shell') ?? prefs.agentPresets[0];
      const count = level.nodes.filter((n) => n.content.kind === 'terminal').length + 1;
      node = {
        id,
        frame: {
          x: Math.round(worldX - DEFAULT_TERMINAL_SIZE.width / 2),
          y: Math.round(worldY - DEFAULT_TERMINAL_SIZE.height / 2),
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
            name: preset ? `${preset.name} ${count}` : `Terminal ${count}`,
            command: preset?.command ?? null,
            workingDirectory: cwd,
            agentType: preset?.agentType ?? 'shell',
            presetId: preset?.id ?? null,
            roleId: null,
            roleName: null,
            isManager: false,
            inChatMode: false,
            color: preset?.color ?? '#30d158',
            icon: preset?.icon ?? 'terminal',
            accountName: 'Default',
            isUnloaded: false,
          },
        },
      };
    } else if (kind === 'note') {
      const count = level.nodes.filter((n) => n.content.kind === 'stickyNote').length + 1;
      node = {
        id,
        frame: {
          x: Math.round(worldX - DEFAULT_NOTE_SIZE.width / 2),
          y: Math.round(worldY - DEFAULT_NOTE_SIZE.height / 2),
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
            fileName: `Note ${count}.md`,
            customName: `Note ${count}`,
            color: 'yellow',
            customColor: null,
            isContentLocked: false,
            fontFamily: null,
            text: `# Note ${count}\n\n- [ ] Task item\n`,
            storageMode: { kind: 'managed' },
          },
        },
      };
    } else if (kind === 'portal') {
      node = {
        id,
        frame: {
          x: Math.round(worldX - DEFAULT_PORTAL_SIZE.width / 2),
          y: Math.round(worldY - DEFAULT_PORTAL_SIZE.height / 2),
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
          x: Math.round(worldX - DEFAULT_FILE_TREE_SIZE.width / 2),
          y: Math.round(worldY - DEFAULT_FILE_TREE_SIZE.height / 2),
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

    await window.orkestrei.node.create(workspace.id, node);
    setCanvasMenu(null);
  };

  if (canvasMenu) {
    const left = Math.min(canvasMenu.screenX, window.innerWidth - 230);
    const top = Math.min(canvasMenu.screenY, window.innerHeight - 310);

    return (
      <div
        ref={menuRef}
        data-canvas-overlay="true"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ left, top, zIndex: 9600 }}
        className="glass-strong fixed w-52 rounded-lg border border-[var(--border)] p-1 text-xs shadow-2xl"
      >
        <button
          type="button"
          onClick={() => void spawnAt('terminal', canvasMenu.worldX, canvasMenu.worldY)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Terminal className="size-3.5 text-[var(--muted-foreground)]" />
          New terminal
        </button>
        <button
          type="button"
          onClick={() => void spawnAt('antigravity', canvasMenu.worldX, canvasMenu.worldY)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Bot className="size-3.5 text-[var(--muted-foreground)]" />
          New Antigravity agent
        </button>
        <button
          type="button"
          onClick={() => void spawnAt('note', canvasMenu.worldX, canvasMenu.worldY)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <StickyNote className="size-3.5 text-[var(--muted-foreground)]" />
          New sticky note
        </button>
        <button
          type="button"
          onClick={() => void spawnAt('portal', canvasMenu.worldX, canvasMenu.worldY)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Globe className="size-3.5 text-[var(--muted-foreground)]" />
          New browser portal
        </button>
        <button
          type="button"
          onClick={() => void spawnAt('fileTree', canvasMenu.worldX, canvasMenu.worldY)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <FolderGit2 className="size-3.5 text-[var(--muted-foreground)]" />
          New file tree
        </button>

        <div className="my-1 border-t border-[var(--border)]" />

        <button
          type="button"
          onClick={() => {
            setCanvasMenu(null);
            setSheet({ kind: 'partituras' });
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Sparkles className="size-3.5 text-[var(--muted-foreground)]" />
          Insert Partitura
        </button>
        <button
          type="button"
          onClick={() => {
            setCanvasMenu(null);
            setSheet({ kind: 'floorHooks' });
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Layers className="size-3.5 text-[var(--muted-foreground)]" />
          Floor hooks
        </button>
        <button
          type="button"
          onClick={() => {
            setCanvasMenu(null);
            setSheet({ kind: 'rolesAndPresets' });
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Bot className="size-3.5 text-[var(--muted-foreground)]" />
          Roles & presets
        </button>
        <button
          type="button"
          onClick={() => {
            setCanvasMenu(null);
            setSheet({ kind: 'preferences' });
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Settings className="size-3.5 text-[var(--muted-foreground)]" />
          Preferences
        </button>
      </div>
    );
  }

  if (nodeMenu) {
    const targetNode = level.nodes.find((n) => n.id === nodeMenu.nodeId);
    if (!targetNode) return null;

    const left = Math.min(nodeMenu.x, window.innerWidth - 240);
    const top = Math.min(nodeMenu.y, window.innerHeight - 340);

    const targetFloors: Array<{ id: string | null; label: string }> = [
      ...(workspace.activeFloorId !== null ? [{ id: null, label: 'Ground Floor' }] : []),
      ...workspace.floors
        .filter((f) => f.id !== workspace.activeFloorId)
        .map((f) => ({ id: f.id, label: f.name })),
    ];

    return (
      <div
        ref={menuRef}
        data-canvas-overlay="true"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ left, top, zIndex: 9600 }}
        className="glass-strong fixed w-56 rounded-lg border border-[var(--border)] p-1 text-xs shadow-2xl"
      >
        {targetNode.content.kind === 'terminal' && (
          <>
            <button
              type="button"
              onClick={() => {
                const t = (targetNode.content as { kind: 'terminal'; terminal: { id: string; isManager: boolean } }).terminal;
                setNodeMenu(null);
                void window.orkestrei.terminal.updateData(workspace.id, t.id, {
                  isManager: !t.isManager,
                });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
            >
              <Crown className="size-3.5 text-[#ff9f0a]" />
              {targetNode.content.terminal.isManager ? 'Disable Maestro mode' : 'Enable Maestro mode'}
            </button>
            <button
              type="button"
              onClick={() => {
                const t = (targetNode.content as { kind: 'terminal'; terminal: { id: string; inChatMode: boolean } }).terminal;
                setNodeMenu(null);
                void window.orkestrei.terminal.updateData(workspace.id, t.id, {
                  inChatMode: !t.inChatMode,
                });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
            >
              <MessageSquare className="size-3.5 text-[var(--muted-foreground)]" />
              {targetNode.content.terminal.inChatMode ? 'Switch to shell' : 'Switch to chat threads'}
            </button>
            <button
              type="button"
              onClick={() => {
                const t = (targetNode.content as { kind: 'terminal'; terminal: { id: string } }).terminal;
                setNodeMenu(null);
                void window.orkestrei.terminal.restart(workspace.id, t.id);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
            >
              <RotateCw className="size-3.5 text-[var(--muted-foreground)]" />
              Restart terminal
            </button>
            <div className="my-1 border-t border-[var(--border)]" />
          </>
        )}

        <button
          type="button"
          onClick={() => {
            setNodeMenu(null);
            void window.orkestrei.node.duplicate(workspace.id, targetNode.id);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Copy className="size-3.5 text-[var(--muted-foreground)]" />
          Duplicate node
        </button>

        <button
          type="button"
          onClick={() => {
            setNodeMenu(null);
            void window.orkestrei.node.setRedacted(
              workspace.id,
              targetNode.id,
              !targetNode.isRedacted
            );
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
        >
          {targetNode.isRedacted ? (
            <>
              <Eye className="size-3.5 text-[var(--success)]" />
              Remove blur
            </>
          ) : (
            <>
              <EyeOff className="size-3.5 text-[var(--warning)]" />
              Blur content
            </>
          )}
        </button>

        {targetNode.content.kind === 'stickyNote' && (
          <button
            type="button"
            onClick={() => {
              setNodeMenu(null);
              void window.orkestrei.noteStack.fileNote(workspace.id, targetNode.id, 'Fichário');
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
          >
            <FolderPlus className="size-3.5 text-[var(--muted-foreground)]" />
            File into Fichário
          </button>
        )}

        {targetFloors.length > 0 && (
          <>
            <div className="my-1 border-t border-[var(--border)]" />
            <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--muted-foreground)]">
              Move to floor
            </div>
            {targetFloors.map((tf) => (
              <button
                key={tf.id ?? 'ground'}
                type="button"
                onClick={() => {
                  setNodeMenu(null);
                  void window.orkestrei.node.moveToFloor(workspace.id, targetNode.id, tf.id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left transition-colors hover:bg-[var(--bg-hover)]"
              >
                <Layers className="size-3 text-[var(--muted-foreground)]" />
                <span className="truncate">{tf.label}</span>
              </button>
            ))}
          </>
        )}

        <div className="my-1 border-t border-[var(--border)]" />

        <button
          type="button"
          onClick={() => {
            setNodeMenu(null);
            void window.orkestrei.connection.removeAllFor(workspace.id, targetNode.id);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
        >
          <Unlink className="size-3.5 text-[var(--muted-foreground)]" />
          Disconnect all ropes
        </button>

        <button
          type="button"
          onClick={() => {
            setNodeMenu(null);
            void window.orkestrei.node.deleteMany(workspace.id, [targetNode.id]);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/15"
        >
          <Trash2 className="size-3.5" />
          Delete node
        </button>
      </div>
    );
  }

  return null;
};
