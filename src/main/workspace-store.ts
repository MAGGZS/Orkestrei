import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_BAND_SIZE,
  DEFAULT_FILE_TREE_SIZE,
  DEFAULT_FICHARIO_SIZE,
  DEFAULT_NOTE_SIZE,
  DEFAULT_PORTAL_SIZE,
  DEFAULT_PREFERENCES,
  DEFAULT_TERMINAL_SIZE,
  DEFAULT_ZOOM,
  STICKY_COLORS,
} from '../shared/constants';
import type {
  AgentPreset,
  AppState,
  BandData,
  CableTie,
  CanvasDrawing,
  CanvasLevelContents,
  CanvasNode,
  CrossFloorConnection,
  CrossWorkspaceConnection,
  Floor,
  FloorLandingPreview,
  FloorStatus,
  NodeGroup,
  NoteColor,
  NoteStackData,
  Partitura,
  Point,
  PortalData,
  Preferences,
  ReachableListResponse,
  ReachableNoteInfo,
  ReachablePortalInfo,
  ReachableTerminalInfo,
  Rect,
  RolePreset,
  SavedPrompt,
  SidebarLayout,
  StickyNoteData,
  TerminalData,
  Workspace,
} from '../shared/types';
import {
  displayNameForNoteFile,
  ensureDir,
  idsEqual,
  newId,
  readJsonFile,
  sameFloor,
  sanitizeFileName,
  slugifyBranch,
  truncate,
  writeJsonAtomic,
} from './utils';

const execFileAsync = promisify(execFile);

interface UndoSnapshot {
  levelFloorId: string | null;
  contents: CanvasLevelContents;
  crossFloorConnections?: CrossFloorConnection[];
  secondaryLevel?: {
    levelFloorId: string | null;
    contents: CanvasLevelContents;
  };
}

export class WorkspaceStore {
  private baseDir: string;
  private workspaces = new Map<string, Workspace>();
  private appState: AppState = {
    activeWorkspaceId: null,
    hasCompletedOnboarding: true,
    sidebarOpen: true,
    sidebarWidth: 260,
  };
  private preferences: Preferences = { ...DEFAULT_PREFERENCES };
  private sidebarLayout: SidebarLayout = {
    pinnedIds: [],
    rootWorkspaceIds: [],
    rootFolders: [],
    groups: [],
  };
  private roles: RolePreset[] = [];
  private partituras: Partitura[] = [];
  private savedPrompts: SavedPrompt[] = [];

  private undoStacks = new Map<string, UndoSnapshot[]>();
  private redoStacks = new Map<string, UndoSnapshot[]>();
  private undoGroupDepth = 0;
  private undoGroupPushed = false;

  private changedListeners = new Set<(workspace: Workspace) => void>();
  private deletedListeners = new Set<(workspaceId: string) => void>();
  private activeListeners = new Set<(workspaceId: string | null) => void>();
  private prefListeners = new Set<(prefs: Preferences) => void>();
  private sidebarListeners = new Set<(layout: SidebarLayout) => void>();
  private partituraListeners = new Set<() => void>();
  private roleListeners = new Set<() => void>();
  private savedPromptsListeners = new Set<() => void>();

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir ?? path.join(os.homedir(), '.orkestrei');
  }

  getDataDir(): string {
    return this.baseDir;
  }

  private workspaceDir(workspaceId: string): string {
    return path.join(this.baseDir, 'workspaces', workspaceId);
  }

  private notesDir(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'notes');
  }

  private workspaceFile(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'workspace.json');
  }

  async init(): Promise<void> {
    await ensureDir(this.baseDir);
    await ensureDir(path.join(this.baseDir, 'workspaces'));

    this.appState = await readJsonFile<AppState>(path.join(this.baseDir, 'app-state.json'), {
      activeWorkspaceId: null,
      hasCompletedOnboarding: true,
      sidebarOpen: true,
      sidebarWidth: 260,
    });

    const loadedPrefs = await readJsonFile<Partial<Preferences>>(
      path.join(this.baseDir, 'preferences.json'),
      {}
    );
    const existingPresets =
      loadedPrefs.agentPresets && loadedPrefs.agentPresets.length > 0
        ? loadedPrefs.agentPresets
        : [...DEFAULT_PREFERENCES.agentPresets];
    const missingBuiltinPresets = DEFAULT_PREFERENCES.agentPresets.filter(
      (builtin) =>
        builtin.id === 'preset-antigravity' &&
        !existingPresets.some(
          (p) =>
            p.id === builtin.id ||
            p.agentType === 'antigravity' ||
            p.command.trim().toLowerCase() === 'agy'
        )
    );
    const mergedPresets =
      missingBuiltinPresets.length > 0
        ? [...missingBuiltinPresets, ...existingPresets]
        : existingPresets;
    this.preferences = {
      ...DEFAULT_PREFERENCES,
      ...loadedPrefs,
      agentPresets: mergedPresets,
    };
    if (missingBuiltinPresets.length > 0) {
      await this.persistPreferences();
    }

    this.sidebarLayout = await readJsonFile<SidebarLayout>(
      path.join(this.baseDir, 'sidebar-layout.json'),
      { pinnedIds: [], rootWorkspaceIds: [], rootFolders: [], groups: [] }
    );

    this.roles = await readJsonFile<RolePreset[]>(path.join(this.baseDir, 'roles.json'), []);
    if (this.roles.length === 0) {
      this.roles = this.createStarterRoles();
      await this.persistRoles();
    }

    this.partituras = await readJsonFile<Partitura[]>(
      path.join(this.baseDir, 'partituras.json'),
      []
    );
    if (this.partituras.length === 0) {
      this.partituras = this.createStarterPartituras();
      await this.persistPartituras();
    }

    this.savedPrompts = await readJsonFile<SavedPrompt[]>(
      path.join(this.baseDir, 'saved-prompts.json'),
      []
    );
    if (this.savedPrompts.length === 0) {
      this.savedPrompts = this.createStarterSavedPrompts();
      await this.persistSavedPrompts();
    }

    const wsRoot = path.join(this.baseDir, 'workspaces');
    const entries = await fsp.readdir(wsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const ws = await readJsonFile<Workspace | null>(
        path.join(wsRoot, entry.name, 'workspace.json'),
        null
      );
      if (ws && ws.id) {
        await this.hydrateNoteTexts(ws);
        this.workspaces.set(ws.id, ws);
      }
    }

    if (this.workspaces.size === 0) {
      await this.createStarterWorkspace();
    } else if (!this.appState.activeWorkspaceId || !this.workspaces.has(this.appState.activeWorkspaceId)) {
      const first = [...this.workspaces.values()][0];
      this.appState.activeWorkspaceId = first?.id ?? null;
      await this.persistAppState();
    }

    this.syncSidebarOrder();
  }

  private createStarterSavedPrompts(): SavedPrompt[] {
    const now = new Date().toISOString();
    return [
      {
        id: newId(),
        title: 'Architecture Review',
        prompt:
          'Review the current architecture, list any bottlenecks or missing edge-case guards, and check connected notes before replying.',
        tags: ['architecture', 'review'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId(),
        title: 'Run Tests & Fix',
        prompt:
          'Run the full build and test suite, inspect any failing checks, fix the root causes, and re-run until green.',
        tags: ['testing', 'ci'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId(),
        title: 'Summarize Progress',
        prompt:
          'Inspect recent git changes and workspace state, then summarize what is finished, what was verified, and the next concrete steps.',
        tags: ['status', 'handoff'],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private createStarterRoles(): RolePreset[] {
    const now = new Date().toISOString();
    return [
      {
        id: newId(),
        name: 'Maestro Architect',
        prompt:
          'You coordinate the team on the Orkestrei canvas. Run `orkestrei list` to inspect teammates, notes, and portals. Break tasks down, recruit specialists with `orkestrei recruit`, wire them with `orkestrei connect`, and delegate via `orkestrei ask`.',
        scope: 'global',
        workspaceId: null,
        icon: 'crown',
        color: '#0a84ff',
        createdAt: now,
      },
      {
        id: newId(),
        name: 'Implementer',
        prompt:
          'You implement clean, well-tested code changes in the workspace. Run `orkestrei list` to discover teammates and shared notes. Report back to the Maestro via `orkestrei ask` when done.',
        scope: 'global',
        workspaceId: null,
        icon: 'hammer',
        color: '#30d158',
        createdAt: now,
      },
      {
        id: newId(),
        name: 'Code Reviewer',
        prompt:
          'Review diffs and implementation details for correctness, edge cases, and security. Never edit files without approval — respond with clear, actionable findings. Run `orkestrei list` to see connected notes and peers.',
        scope: 'global',
        workspaceId: null,
        icon: 'shield',
        color: '#bf5af2',
        createdAt: now,
      },
    ];
  }

  private createStarterPartituras(): Partitura[] {
    const now = new Date().toISOString();
    const maestroTermId = 'partitura-maestro-term';
    const implTermId = 'partitura-impl-term';
    const revTermId = 'partitura-rev-term';
    const specNoteId = 'partitura-spec-note';
    return [
      {
        id: 'starter-triad-squad',
        name: 'Triad Squad (Maestro + Dev + Reviewer)',
        summary: 'Maestro coordenando um Implementer e um Code Reviewer conectados a uma nota de especificação',
        icon: 'sparkles',
        color: '#0a84ff',
        workspaceId: null,
        nodes: [
          {
            id: 'partitura-maestro-node',
            frame: { x: 80, y: 120, width: 520, height: 370 },
            zIndex: 1,
            groupId: null,
            createdAt: now,
            lastModifiedAt: now,
            content: {
              kind: 'terminal',
              terminal: {
                id: maestroTermId,
                name: 'Maestro',
                command: null,
                workingDirectory: null,
                agentType: 'shell',
                presetId: 'preset-shell',
                roleId: null,
                roleName: 'Maestro Architect',
                isManager: true,
                inChatMode: false,
                color: '#0a84ff',
                icon: 'crown',
                accountName: 'Default',
                isUnloaded: false,
              },
            },
          },
          {
            id: 'partitura-impl-node',
            frame: { x: 680, y: 40, width: 500, height: 340 },
            zIndex: 2,
            groupId: null,
            createdAt: now,
            lastModifiedAt: now,
            content: {
              kind: 'terminal',
              terminal: {
                id: implTermId,
                name: 'Builder',
                command: null,
                workingDirectory: null,
                agentType: 'shell',
                presetId: 'preset-shell',
                roleId: null,
                roleName: 'Implementer',
                isManager: false,
                inChatMode: false,
                color: '#30d158',
                icon: 'hammer',
                accountName: 'Default',
                isUnloaded: false,
              },
            },
          },
          {
            id: 'partitura-rev-node',
            frame: { x: 680, y: 420, width: 500, height: 340 },
            zIndex: 3,
            groupId: null,
            createdAt: now,
            lastModifiedAt: now,
            content: {
              kind: 'terminal',
              terminal: {
                id: revTermId,
                name: 'Sentinel',
                command: null,
                workingDirectory: null,
                agentType: 'shell',
                presetId: 'preset-shell',
                roleId: null,
                roleName: 'Code Reviewer',
                isManager: false,
                inChatMode: false,
                color: '#bf5af2',
                icon: 'shield',
                accountName: 'Default',
                isUnloaded: false,
              },
            },
          },
          {
            id: specNoteId,
            frame: { x: 80, y: 530, width: 320, height: 230 },
            zIndex: 4,
            groupId: null,
            createdAt: now,
            lastModifiedAt: now,
            content: {
              kind: 'stickyNote',
              stickyNote: {
                fileName: 'Architecture Spec.md',
                customName: 'Architecture Spec',
                color: 'yellow',
                customColor: null,
                isContentLocked: false,
                fontFamily: null,
                text: '# Architecture Spec\n\n- Goal: Coordinate changes cleanly\n- Run `orkestrei list` to inspect teammates\n- Use `orkestrei ask "Name" "task"` to delegate',
                storageMode: { kind: 'managed' },
              },
            },
          },
        ],
        connections: [
          { id: 'c1', terminalIdA: maestroTermId, terminalIdB: implTermId },
          { id: 'c2', terminalIdA: maestroTermId, terminalIdB: revTermId },
          { id: 'c3', terminalIdA: implTermId, terminalIdB: revTermId },
        ],
        noteConnections: [
          { id: 'nc1', terminalId: maestroTermId, noteNodeId: specNoteId },
          { id: 'nc2', terminalId: implTermId, noteNodeId: specNoteId },
        ],
        noteToNoteConnections: [],
        portalConnections: [],
        portalToPortalConnections: [],
        drawings: [],
        roles: [],
        createdAt: now,
      },
    ];
  }

  private async createStarterWorkspace(): Promise<void> {
    const defaultDir = fs.existsSync(process.cwd()) ? process.cwd() : os.homedir();
    const ws = await this.createWorkspace({
      name: 'Orkestrei Canvas',
      workingDirectory: defaultDir,
      color: '#0a84ff',
      icon: 'sparkles',
    });

    const now = new Date().toISOString();
    const maestroTermId = newId();
    const agentTermId = newId();
    const noteNodeId = newId();

    const maestroNode: CanvasNode = {
      id: newId(),
      frame: { x: 100, y: 110, width: DEFAULT_TERMINAL_SIZE.width, height: DEFAULT_TERMINAL_SIZE.height },
      zIndex: 1,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'terminal',
        terminal: {
          id: maestroTermId,
          name: 'Maestro',
          command: null,
          workingDirectory: defaultDir,
          agentType: 'shell',
          presetId: 'preset-shell',
          roleId: this.roles[0]?.id ?? null,
          roleName: this.roles[0]?.name ?? 'Maestro Architect',
          isManager: true,
          inChatMode: false,
          color: '#0a84ff',
          icon: 'crown',
          accountName: 'Default',
          isUnloaded: false,
        },
      },
    };

    const specialistNode: CanvasNode = {
      id: newId(),
      frame: { x: 740, y: 110, width: DEFAULT_TERMINAL_SIZE.width, height: DEFAULT_TERMINAL_SIZE.height },
      zIndex: 2,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'terminal',
        terminal: {
          id: agentTermId,
          name: 'Builder',
          command: null,
          workingDirectory: defaultDir,
          agentType: 'shell',
          presetId: 'preset-shell',
          roleId: this.roles[1]?.id ?? null,
          roleName: this.roles[1]?.name ?? 'Implementer',
          isManager: false,
          inChatMode: false,
          color: '#30d158',
          icon: 'hammer',
          accountName: 'Default',
          isUnloaded: false,
        },
      },
    };

    const noteContent = `# Guia Rápido do Orkestrei\n\nVocê está no Canvas Espacial de Orquestração.\n\n### Comandos disponíveis em qualquer terminal:\n- \`orkestrei list\` — Lista colegas, notas e portais conectados\n- \`orkestrei ask "Builder" "echo Ola do Maestro"\` — Envia prompt para outro terminal ligado por corda\n- \`orkestrei check "Builder"\` — Lê a tela atual do terminal conectado\n- \`orkestrei recruit "Reviewer" --role "Code Reviewer"\` — Cria um novo agente já ligado a você\n- \`orkestrei note read "Guia Rápido do Orkestrei"\` — Lê esta nota\n\nUse a ferramenta **Connect (C)** ou arraste das alças laterais para ligar nós com cordas físicas!`;

    await this.writeNoteFile(ws.id, 'Guia Rápido do Orkestrei.md', noteContent);

    const noteNode: CanvasNode = {
      id: noteNodeId,
      frame: { x: 100, y: 540, width: 420, height: 240 },
      zIndex: 3,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'stickyNote',
        stickyNote: {
          fileName: 'Guia Rápido do Orkestrei.md',
          customName: 'Guia Rápido do Orkestrei',
          color: 'yellow',
          customColor: null,
          isContentLocked: false,
          fontFamily: null,
          text: noteContent,
          storageMode: { kind: 'managed' },
        },
      },
    };

    const updated: Workspace = {
      ...ws,
      nodes: [maestroNode, specialistNode, noteNode],
      connections: [{ id: newId(), terminalIdA: maestroTermId, terminalIdB: agentTermId }],
      noteConnections: [{ id: newId(), terminalId: maestroTermId, noteNodeId }],
    };

    await this.commitWorkspace(updated);
    this.appState.activeWorkspaceId = updated.id;
    await this.persistAppState();
  }

  private async hydrateNoteTexts(ws: Workspace): Promise<void> {
    const hydrateLevel = async (level: CanvasLevelContents): Promise<void> => {
      for (const node of level.nodes) {
        if (node.content.kind === 'stickyNote') {
          const sn = node.content.stickyNote;
          try {
            if (sn.storageMode.kind === 'external' && sn.storageMode.originalPath) {
              sn.text = await fsp.readFile(sn.storageMode.originalPath, 'utf8');
            } else {
              sn.text = await this.readNoteFile(ws.id, sn.fileName);
            }
          } catch {
            // keep inline text
          }
        }
      }
    };
    await hydrateLevel(ws);
    for (const floor of ws.floors) {
      await hydrateLevel(floor);
    }
  }

  async readNoteFile(workspaceId: string, fileName: string): Promise<string> {
    const p = path.join(this.notesDir(workspaceId), fileName);
    return fsp.readFile(p, 'utf8').catch(() => '');
  }

  async writeNoteFile(workspaceId: string, fileName: string, text: string): Promise<void> {
    const dir = this.notesDir(workspaceId);
    await ensureDir(dir);
    await fsp.writeFile(path.join(dir, fileName), text, 'utf8');
  }

  private syncSidebarOrder(): void {
    const existingIds = new Set(this.workspaces.keys());
    this.sidebarLayout.pinnedIds = this.sidebarLayout.pinnedIds.filter((id) => existingIds.has(id));
    this.sidebarLayout.rootWorkspaceIds = this.sidebarLayout.rootWorkspaceIds.filter((id) =>
      existingIds.has(id)
    );
    const placed = new Set<string>([
      ...this.sidebarLayout.pinnedIds,
      ...this.sidebarLayout.rootWorkspaceIds,
      ...this.sidebarLayout.rootFolders.flatMap((f) => f.workspaceIds),
      ...this.sidebarLayout.groups.flatMap((g) => [
        ...g.workspaceIds,
        ...g.folders.flatMap((f) => f.workspaceIds),
      ]),
    ]);
    for (const id of existingIds) {
      if (!placed.has(id)) {
        this.sidebarLayout.rootWorkspaceIds.push(id);
      }
    }
  }

  private async persistAppState(): Promise<void> {
    await writeJsonAtomic(path.join(this.baseDir, 'app-state.json'), this.appState);
  }

  private async persistPreferences(): Promise<void> {
    await writeJsonAtomic(path.join(this.baseDir, 'preferences.json'), this.preferences);
  }

  private async persistSidebarLayout(): Promise<void> {
    await writeJsonAtomic(path.join(this.baseDir, 'sidebar-layout.json'), this.sidebarLayout);
  }

  private async persistRoles(): Promise<void> {
    await writeJsonAtomic(path.join(this.baseDir, 'roles.json'), this.roles);
  }

  private async persistPartituras(): Promise<void> {
    await writeJsonAtomic(path.join(this.baseDir, 'partituras.json'), this.partituras);
  }

  private async persistSavedPrompts(): Promise<void> {
    await writeJsonAtomic(path.join(this.baseDir, 'saved-prompts.json'), this.savedPrompts);
  }

  private async persistWorkspace(ws: Workspace): Promise<void> {
    await writeJsonAtomic(this.workspaceFile(ws.id), ws);
  }

  async commitWorkspace(ws: Workspace): Promise<Workspace> {
    this.workspaces.set(ws.id, ws);
    await this.persistWorkspace(ws);
    for (const listener of this.changedListeners) {
      listener(ws);
    }
    return ws;
  }

  // Subscriptions
  onChanged(cb: (ws: Workspace) => void): () => void {
    this.changedListeners.add(cb);
    return () => this.changedListeners.delete(cb);
  }

  onDeleted(cb: (id: string) => void): () => void {
    this.deletedListeners.add(cb);
    return () => this.deletedListeners.delete(cb);
  }

  onActiveChanged(cb: (id: string | null) => void): () => void {
    this.activeListeners.add(cb);
    return () => this.activeListeners.delete(cb);
  }

  onPreferencesChanged(cb: (p: Preferences) => void): () => void {
    this.prefListeners.add(cb);
    return () => this.prefListeners.delete(cb);
  }

  onSidebarLayoutChanged(cb: (l: SidebarLayout) => void): () => void {
    this.sidebarListeners.add(cb);
    return () => this.sidebarListeners.delete(cb);
  }

  onPartiturasChanged(cb: () => void): () => void {
    this.partituraListeners.add(cb);
    return () => this.partituraListeners.delete(cb);
  }

  onRolesChanged(cb: () => void): () => void {
    this.roleListeners.add(cb);
    return () => this.roleListeners.delete(cb);
  }

  onSavedPromptsChanged(cb: () => void): () => void {
    this.savedPromptsListeners.add(cb);
    return () => this.savedPromptsListeners.delete(cb);
  }

  // Getters & Setters
  getAppState(): AppState {
    return { ...this.appState };
  }

  async updateAppState(patch: Partial<AppState>): Promise<AppState> {
    this.appState = { ...this.appState, ...patch };
    await this.persistAppState();
    return this.getAppState();
  }

  getPreferences(): Preferences {
    return { ...this.preferences };
  }

  async setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
    this.preferences = { ...this.preferences, ...patch };
    await this.persistPreferences();
    for (const cb of this.prefListeners) cb(this.preferences);
    return this.getPreferences();
  }

  getSidebarLayout(): SidebarLayout {
    return structuredClone(this.sidebarLayout);
  }

  async setSidebarLayout(layout: SidebarLayout): Promise<SidebarLayout> {
    this.sidebarLayout = structuredClone(layout);
    this.syncSidebarOrder();
    await this.persistSidebarLayout();
    for (const cb of this.sidebarListeners) cb(this.getSidebarLayout());
    return this.getSidebarLayout();
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  getWorkspace(id: string): Workspace | null {
    return this.workspaces.get(id) ?? null;
  }

  getActiveWorkspaceId(): string | null {
    return this.appState.activeWorkspaceId;
  }

  getActiveWorkspace(): Workspace | null {
    return this.appState.activeWorkspaceId ? this.getWorkspace(this.appState.activeWorkspaceId) : null;
  }

  async switchWorkspace(id: string): Promise<Workspace | null> {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    this.appState.activeWorkspaceId = ws.id;
    const updated = { ...ws, lastOpenedAt: new Date().toISOString() };
    await this.commitWorkspace(updated);
    await this.persistAppState();
    for (const cb of this.activeListeners) cb(ws.id);
    return updated;
  }

  async createWorkspace(input: {
    name: string;
    workingDirectory: string;
    color?: string | null;
    icon?: string | null;
    fromWorkspaceId?: string | null;
    groupName?: string | null;
    folderName?: string | null;
  }): Promise<Workspace> {
    const now = new Date().toISOString();
    const id = newId();
    const source = input.fromWorkspaceId ? this.getWorkspace(input.fromWorkspaceId) : null;

    let baseContents: CanvasLevelContents = {
      nodes: [],
      drawings: [],
      groups: [],
      connections: [],
      noteConnections: [],
      noteToNoteConnections: [],
      portalConnections: [],
      portalToPortalConnections: [],
      cableTies: [],
    };
    let floors: Floor[] = [];

    if (source) {
      const idMap = new Map<string, string>();
      const termIdMap = new Map<string, string>();
      const cloneLevel = async (lvl: CanvasLevelContents): Promise<CanvasLevelContents> => {
        const nodes: CanvasNode[] = [];
        for (const n of lvl.nodes) {
          const newNodeId = newId();
          idMap.set(n.id, newNodeId);
          if (n.content.kind === 'terminal') {
            const newTermId = newId();
            termIdMap.set(n.content.terminal.id, newTermId);
            nodes.push({
              ...structuredClone(n),
              id: newNodeId,
              content: {
                kind: 'terminal',
                terminal: {
                  ...structuredClone(n.content.terminal),
                  id: newTermId,
                  workingDirectory: input.workingDirectory,
                },
              },
            });
          } else if (n.content.kind === 'stickyNote') {
            await this.writeNoteFile(id, n.content.stickyNote.fileName, n.content.stickyNote.text);
            nodes.push({ ...structuredClone(n), id: newNodeId });
          } else {
            nodes.push({ ...structuredClone(n), id: newNodeId });
          }
        }
        return {
          nodes,
          drawings: structuredClone(lvl.drawings).map((d) => ({ ...d, id: newId() })),
          groups: structuredClone(lvl.groups).map((g) => ({ ...g, id: newId() })),
          connections: lvl.connections.map((c) => ({
            id: newId(),
            terminalIdA: termIdMap.get(c.terminalIdA) ?? c.terminalIdA,
            terminalIdB: termIdMap.get(c.terminalIdB) ?? c.terminalIdB,
          })),
          noteConnections: lvl.noteConnections.map((c) => ({
            id: newId(),
            terminalId: termIdMap.get(c.terminalId) ?? c.terminalId,
            noteNodeId: idMap.get(c.noteNodeId) ?? c.noteNodeId,
          })),
          noteToNoteConnections: lvl.noteToNoteConnections.map((c) => ({
            id: newId(),
            noteNodeIdA: idMap.get(c.noteNodeIdA) ?? c.noteNodeIdA,
            noteNodeIdB: idMap.get(c.noteNodeIdB) ?? c.noteNodeIdB,
          })),
          portalConnections: lvl.portalConnections.map((c) => ({
            id: newId(),
            terminalId: termIdMap.get(c.terminalId) ?? c.terminalId,
            portalNodeId: idMap.get(c.portalNodeId) ?? c.portalNodeId,
          })),
          portalToPortalConnections: lvl.portalToPortalConnections.map((c) => ({
            id: newId(),
            portalNodeIdA: idMap.get(c.portalNodeIdA) ?? c.portalNodeIdA,
            portalNodeIdB: idMap.get(c.portalNodeIdB) ?? c.portalNodeIdB,
          })),
          cableTies: [],
        };
      };
      baseContents = await cloneLevel(source);
      floors = await Promise.all(
        source.floors.map(async (f) => ({
          ...(await cloneLevel(f)),
          id: newId(),
          name: f.name,
          branchName: null,
          clonePath: null,
          cloneKind: 'none' as const,
          groundPath: input.workingDirectory,
          groundBranch: null,
          color: f.color,
          canvasOrigin: { ...f.canvasOrigin },
          canvasZoom: f.canvasZoom,
          dockedNodeId: null,
          liftedNodeId: null,
          createdAt: now,
          status: null,
        }))
      );
    }

    const ws: Workspace = {
      id,
      name: input.name.trim() || 'Workspace',
      workingDirectory: input.workingDirectory,
      color: input.color ?? '#0a84ff',
      icon: input.icon ?? 'folder',
      isPinned: false,
      canvasOrigin: { x: 0, y: 0 },
      canvasZoom: DEFAULT_ZOOM,
      activeFloorId: null,
      groundStatus: null,
      dockedNodeId: null,
      liftedNodeId: null,
      ...baseContents,
      floors,
      crossFloorConnections: [],
      crossWorkspaceConnections: [],
      hooks: {
        isEnabled: false,
        autoRunSetup: false,
        setupCommands: [],
        runCommands: [],
        teardownCommands: [],
      },
      createdAt: now,
      lastOpenedAt: now,
    };

    await ensureDir(this.notesDir(id));
    await this.commitWorkspace(ws);
    await this.fileWorkspaceInSidebar(ws.id, {
      groupName: input.groupName ?? undefined,
      folderName: input.folderName ?? undefined,
    });
    return ws;
  }

  async fileWorkspaceInSidebar(
    workspaceId: string,
    opts: { groupName?: string; folderName?: string; root?: boolean }
  ): Promise<void> {
    const layout = this.getSidebarLayout();
    // Remove from existing slots
    layout.pinnedIds = layout.pinnedIds.filter((id) => id !== workspaceId);
    layout.rootWorkspaceIds = layout.rootWorkspaceIds.filter((id) => id !== workspaceId);
    for (const f of layout.rootFolders) {
      f.workspaceIds = f.workspaceIds.filter((id) => id !== workspaceId);
    }
    for (const g of layout.groups) {
      g.workspaceIds = g.workspaceIds.filter((id) => id !== workspaceId);
      for (const f of g.folders) {
        f.workspaceIds = f.workspaceIds.filter((id) => id !== workspaceId);
      }
    }

    if (opts.groupName) {
      let group = layout.groups.find((g) => g.name.toLowerCase() === opts.groupName!.toLowerCase());
      if (!group) {
        group = { id: newId(), name: opts.groupName, workspaceIds: [], folders: [] };
        layout.groups.push(group);
      }
      if (opts.folderName) {
        let folder = group.folders.find((f) => f.name.toLowerCase() === opts.folderName!.toLowerCase());
        if (!folder) {
          folder = { id: newId(), name: opts.folderName, workspaceIds: [] };
          group.folders.push(folder);
        }
        folder.workspaceIds.push(workspaceId);
      } else {
        group.workspaceIds.push(workspaceId);
      }
    } else if (opts.folderName) {
      let folder = layout.rootFolders.find(
        (f) => f.name.toLowerCase() === opts.folderName!.toLowerCase()
      );
      if (!folder) {
        folder = { id: newId(), name: opts.folderName, workspaceIds: [] };
        layout.rootFolders.push(folder);
      }
      folder.workspaceIds.push(workspaceId);
    } else {
      layout.rootWorkspaceIds.push(workspaceId);
    }

    await this.setSidebarLayout(layout);
  }

  async patchWorkspace(
    id: string,
    patch: Partial<
      Pick<
        Workspace,
        | 'name'
        | 'workingDirectory'
        | 'color'
        | 'icon'
        | 'isPinned'
        | 'canvasOrigin'
        | 'canvasZoom'
        | 'dockedNodeId'
        | 'liftedNodeId'
        | 'hooks'
      >
    >
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    if (patch.isPinned !== undefined && patch.isPinned !== ws.isPinned) {
      const layout = this.getSidebarLayout();
      if (patch.isPinned) {
        if (!layout.pinnedIds.includes(id)) layout.pinnedIds.push(id);
      } else {
        layout.pinnedIds = layout.pinnedIds.filter((x) => x !== id);
      }
      await this.setSidebarLayout(layout);
    }

    const activeFloor = ws.activeFloorId
      ? ws.floors.find((f) => idsEqual(f.id, ws.activeFloorId))
      : null;

    if (
      activeFloor &&
      (patch.canvasOrigin !== undefined ||
        patch.canvasZoom !== undefined ||
        patch.dockedNodeId !== undefined ||
        patch.liftedNodeId !== undefined)
    ) {
      const updatedFloors = ws.floors.map((f) =>
        idsEqual(f.id, activeFloor.id)
          ? {
              ...f,
              canvasOrigin: patch.canvasOrigin ?? f.canvasOrigin,
              canvasZoom: patch.canvasZoom ?? f.canvasZoom,
              dockedNodeId: patch.dockedNodeId !== undefined ? patch.dockedNodeId : f.dockedNodeId,
              liftedNodeId: patch.liftedNodeId !== undefined ? patch.liftedNodeId : f.liftedNodeId,
            }
          : f
      );
      const { canvasOrigin: _co, canvasZoom: _cz, dockedNodeId: _dn, liftedNodeId: _ln, ...rest } =
        patch;
      return this.commitWorkspace({ ...ws, ...rest, floors: updatedFloors });
    }

    return this.commitWorkspace({ ...ws, ...patch });
  }

  async deleteWorkspace(id: string): Promise<void> {
    if (!this.workspaces.has(id)) return;
    this.workspaces.delete(id);
    await fsp.rm(this.workspaceDir(id), { recursive: true, force: true }).catch(() => undefined);

    if (this.appState.activeWorkspaceId === id) {
      const next = [...this.workspaces.values()][0]?.id ?? null;
      this.appState.activeWorkspaceId = next;
      await this.persistAppState();
      for (const cb of this.activeListeners) cb(next);
    }

    this.syncSidebarOrder();
    await this.persistSidebarLayout();
    for (const cb of this.deletedListeners) cb(id);
  }

  // Level helpers
  getLevelContents(ws: Workspace, floorId: string | null | undefined): CanvasLevelContents {
    if (!floorId) return ws;
    return ws.floors.find((f) => idsEqual(f.id, floorId)) ?? ws;
  }

  getActiveLevelContents(ws: Workspace): CanvasLevelContents {
    return this.getLevelContents(ws, ws.activeFloorId);
  }

  private mapLevel(
    ws: Workspace,
    floorId: string | null | undefined,
    updater: (lvl: CanvasLevelContents) => CanvasLevelContents
  ): Workspace {
    if (!floorId) {
      const next = updater(ws);
      return { ...ws, ...next };
    }
    const floors = ws.floors.map((f) => {
      if (!idsEqual(f.id, floorId)) return f;
      return { ...f, ...updater(f) };
    });
    return { ...ws, floors };
  }

  private cloneLevelContents(current: CanvasLevelContents): CanvasLevelContents {
    return structuredClone({
      nodes: current.nodes,
      drawings: current.drawings,
      groups: current.groups,
      connections: current.connections,
      noteConnections: current.noteConnections,
      noteToNoteConnections: current.noteToNoteConnections,
      portalConnections: current.portalConnections,
      portalToPortalConnections: current.portalToPortalConnections,
      cableTies: current.cableTies,
    });
  }

  private pushUndo(
    ws: Workspace,
    floorId: string | null,
    extra?: {
      crossFloorConnections?: CrossFloorConnection[];
      secondaryLevel?: {
        levelFloorId: string | null;
        contents: CanvasLevelContents;
      };
    }
  ): void {
    if (this.undoGroupDepth > 0 && this.undoGroupPushed) return;
    if (this.undoGroupDepth > 0) this.undoGroupPushed = true;
    const key = `${ws.id}:${floorId ?? 'ground'}`;
    const stack = this.undoStacks.get(key) ?? [];
    const current = this.getLevelContents(ws, floorId);
    const snap: UndoSnapshot = {
      levelFloorId: floorId,
      contents: this.cloneLevelContents(current),
    };
    if (extra?.secondaryLevel) {
      snap.secondaryLevel = {
        levelFloorId: extra.secondaryLevel.levelFloorId,
        contents: this.cloneLevelContents(extra.secondaryLevel.contents),
      };
    }
    if (extra?.crossFloorConnections) {
      snap.crossFloorConnections = structuredClone(extra.crossFloorConnections);
    }
    stack.push(snap);
    if (stack.length > 40) stack.shift();
    this.undoStacks.set(key, stack);
    this.redoStacks.set(key, []);
  }

  beginUndoGroup(): void {
    this.undoGroupDepth += 1;
    if (this.undoGroupDepth === 1) this.undoGroupPushed = false;
  }

  endUndoGroup(): void {
    if (this.undoGroupDepth > 0) this.undoGroupDepth -= 1;
    if (this.undoGroupDepth === 0) this.undoGroupPushed = false;
  }

  async undo(workspaceId: string): Promise<boolean> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return false;
    const key = `${ws.id}:${ws.activeFloorId ?? 'ground'}`;
    const stack = this.undoStacks.get(key) ?? [];
    const snap = stack.pop();
    if (!snap) return false;

    const current = this.getLevelContents(ws, snap.levelFloorId);
    const redoStack = this.redoStacks.get(key) ?? [];
    const redoSnap: UndoSnapshot = {
      levelFloorId: snap.levelFloorId,
      contents: this.cloneLevelContents(current),
    };
    if (snap.secondaryLevel) {
      const currentSecondary = this.getLevelContents(ws, snap.secondaryLevel.levelFloorId);
      redoSnap.secondaryLevel = {
        levelFloorId: snap.secondaryLevel.levelFloorId,
        contents: this.cloneLevelContents(currentSecondary),
      };
    }
    if (snap.crossFloorConnections !== undefined) {
      redoSnap.crossFloorConnections = structuredClone(ws.crossFloorConnections);
    }
    redoStack.push(redoSnap);
    this.redoStacks.set(key, redoStack);

    let updated = this.mapLevel(ws, snap.levelFloorId, () => snap.contents);
    if (snap.secondaryLevel) {
      updated = this.mapLevel(updated, snap.secondaryLevel.levelFloorId, () => snap.secondaryLevel!.contents);
    }
    if (snap.crossFloorConnections !== undefined) {
      updated = {
        ...updated,
        crossFloorConnections: structuredClone(snap.crossFloorConnections),
      };
    }
    await this.commitWorkspace(updated);
    return true;
  }

  async redo(workspaceId: string): Promise<boolean> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return false;
    const key = `${ws.id}:${ws.activeFloorId ?? 'ground'}`;
    const redoStack = this.redoStacks.get(key) ?? [];
    const snap = redoStack.pop();
    if (!snap) return false;

    const current = this.getLevelContents(ws, snap.levelFloorId);
    const undoStack = this.undoStacks.get(key) ?? [];
    const undoSnap: UndoSnapshot = {
      levelFloorId: snap.levelFloorId,
      contents: this.cloneLevelContents(current),
    };
    if (snap.secondaryLevel) {
      const currentSecondary = this.getLevelContents(ws, snap.secondaryLevel.levelFloorId);
      undoSnap.secondaryLevel = {
        levelFloorId: snap.secondaryLevel.levelFloorId,
        contents: this.cloneLevelContents(currentSecondary),
      };
    }
    if (snap.crossFloorConnections !== undefined) {
      undoSnap.crossFloorConnections = structuredClone(ws.crossFloorConnections);
    }
    undoStack.push(undoSnap);
    this.undoStacks.set(key, undoStack);

    let updated = this.mapLevel(ws, snap.levelFloorId, () => snap.contents);
    if (snap.secondaryLevel) {
      updated = this.mapLevel(updated, snap.secondaryLevel.levelFloorId, () => snap.secondaryLevel!.contents);
    }
    if (snap.crossFloorConnections !== undefined) {
      updated = {
        ...updated,
        crossFloorConnections: structuredClone(snap.crossFloorConnections),
      };
    }
    await this.commitWorkspace(updated);
    return true;
  }

  // Floors & Git Worktrees
  async createFloor(
    workspaceId: string,
    input: {
      name: string;
      branchName?: string;
      existingBranch?: boolean;
      noGit?: boolean;
      copyGround?: boolean;
      workingDirOverride?: string;
    }
  ): Promise<{ ok: true; floor: Floor } | { ok: false; error: string }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { ok: false, error: 'Workspace not found' };

    const name = input.name.trim() || `Floor ${ws.floors.length + 1}`;
    const branchName = input.branchName?.trim() || slugifyBranch(name);
    let clonePath: string | null = null;
    let cloneKind: 'worktree' | 'copy' | 'none' = 'none';
    let groundBranch: string | null = null;

    if (!input.noGit && !input.workingDirOverride) {
      const isGit = await this.isGitRepo(ws.workingDirectory);
      if (isGit) {
        groundBranch = await this.getGitBranch(ws.workingDirectory);
        const floorsRoot = path.join(ws.workingDirectory, '.orkestrei', 'floors');
        await ensureDir(floorsRoot);
        const worktreeDir = path.join(floorsRoot, slugifyBranch(name));
        try {
          if (input.existingBranch) {
            await execFileAsync('git', ['worktree', 'add', worktreeDir, branchName], {
              cwd: ws.workingDirectory,
            });
          } else {
            await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreeDir], {
              cwd: ws.workingDirectory,
            });
          }
          clonePath = worktreeDir;
          cloneKind = 'worktree';
        } catch (err) {
          return {
            ok: false,
            error: `Failed to create git worktree: ${this.formatExecError(err)}`,
          };
        }
      }
    } else if (input.workingDirOverride) {
      clonePath = input.workingDirOverride;
    }

    const baseContents: CanvasLevelContents = input.copyGround
      ? structuredClone({
          nodes: ws.nodes.map((n) => ({
            ...n,
            id: newId(),
            content:
              n.content.kind === 'terminal'
                ? {
                    kind: 'terminal',
                    terminal: {
                      ...n.content.terminal,
                      id: newId(),
                      workingDirectory: clonePath ?? ws.workingDirectory,
                    },
                  }
                : structuredClone(n.content),
          })),
          drawings: ws.drawings,
          groups: ws.groups,
          connections: [],
          noteConnections: [],
          noteToNoteConnections: [],
          portalConnections: [],
          portalToPortalConnections: [],
          cableTies: [],
        })
      : {
          nodes: [],
          drawings: [],
          groups: [],
          connections: [],
          noteConnections: [],
          noteToNoteConnections: [],
          portalConnections: [],
          portalToPortalConnections: [],
          cableTies: [],
        };

    const floor: Floor = {
      id: newId(),
      name,
      branchName: cloneKind === 'worktree' ? branchName : null,
      clonePath,
      cloneKind,
      groundPath: ws.workingDirectory,
      groundBranch,
      color: null,
      canvasOrigin: { x: 0, y: 0 },
      canvasZoom: DEFAULT_ZOOM,
      dockedNodeId: null,
      liftedNodeId: null,
      createdAt: new Date().toISOString(),
      status: null,
      ...baseContents,
    };

    const updated = { ...ws, floors: [...ws.floors, floor] };
    await this.commitWorkspace(updated);
    return { ok: true, floor };
  }

  async switchFloor(
    workspaceId: string,
    floorId: string | null,
    outgoingCamera?: { origin: Point; zoom: number } | null
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    let next = ws;
    if (outgoingCamera) {
      if (ws.activeFloorId === null) {
        next = {
          ...next,
          canvasOrigin: outgoingCamera.origin,
          canvasZoom: outgoingCamera.zoom,
        };
      } else {
        next = {
          ...next,
          floors: next.floors.map((f) =>
            idsEqual(f.id, ws.activeFloorId)
              ? { ...f, canvasOrigin: outgoingCamera.origin, canvasZoom: outgoingCamera.zoom }
              : f
          ),
        };
      }
    }
    if (floorId !== null && !next.floors.some((f) => idsEqual(f.id, floorId))) {
      return next;
    }
    next = { ...next, activeFloorId: floorId };
    return this.commitWorkspace(next);
  }

  async setFloorStatus(
    workspaceId: string,
    floorId: string | null,
    status: FloorStatus | null
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    if (floorId === null) {
      return this.commitWorkspace({ ...ws, groundStatus: status });
    }
    return this.commitWorkspace({
      ...ws,
      floors: ws.floors.map((f) => (idsEqual(f.id, floorId) ? { ...f, status } : f)),
    });
  }

  async renameFloor(workspaceId: string, floorId: string, name: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    return this.commitWorkspace({
      ...ws,
      floors: ws.floors.map((f) => (idsEqual(f.id, floorId) ? { ...f, name } : f)),
    });
  }

  async getFloorLandingPreview(
    workspaceId: string,
    floorId: string,
    targetBranch?: string
  ): Promise<FloorLandingPreview | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const floor = ws.floors.find((f) => idsEqual(f.id, floorId));
    if (!floor) return null;

    const worktreePath = floor.clonePath || ws.workingDirectory;
    const resolvedTarget = targetBranch || floor.groundBranch || 'main';
    const branchName = floor.branchName || (await this.getGitBranch(worktreePath)) || '';
    const isGitRepo = await this.isGitRepo(worktreePath);

    if (!isGitRepo) {
      return {
        floorId: floor.id,
        floorName: floor.name,
        branchName,
        targetBranch: resolvedTarget,
        worktreePath,
        isGitRepo: false,
        dirtyFiles: [],
        commitLog: [],
        diffStat: '',
        diffText: '',
      };
    }

    const dirtyRes = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
    }).catch(() => ({ stdout: '' }));
    const dirtyFiles = dirtyRes.stdout
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean);

    let commitLog: string[] = [];
    let diffStat = '';
    let diffText = '';

    if (floor.cloneKind === 'worktree' && branchName) {
      const logRes = await execFileAsync(
        'git',
        ['log', `${resolvedTarget}..HEAD`, '--oneline', '-n', '25'],
        { cwd: worktreePath }
      ).catch(() => ({ stdout: '' }));
      commitLog = logRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      const statRes = await execFileAsync('git', ['diff', '--stat', `${resolvedTarget}...HEAD`], {
        cwd: worktreePath,
      }).catch(() => ({ stdout: '' }));
      diffStat = statRes.stdout.trim();

      const diffRes = await execFileAsync('git', ['diff', `${resolvedTarget}...HEAD`], {
        cwd: worktreePath,
      }).catch(() => ({ stdout: '' }));
      diffText = diffRes.stdout;
    }

    if (!diffText && dirtyFiles.length > 0) {
      const wtStat = await execFileAsync('git', ['diff', '--stat'], { cwd: worktreePath }).catch(
        () => ({ stdout: '' })
      );
      const wtDiff = await execFileAsync('git', ['diff'], { cwd: worktreePath }).catch(() => ({
        stdout: '',
      }));
      diffStat = wtStat.stdout.trim() || diffStat;
      diffText = wtDiff.stdout;
    }

    return {
      floorId: floor.id,
      floorName: floor.name,
      branchName,
      targetBranch: resolvedTarget,
      worktreePath,
      isGitRepo: true,
      dirtyFiles,
      commitLog,
      diffStat,
      diffText: truncate(diffText, 24000),
    };
  }

  async landFloor(
    workspaceId: string,
    floorId: string,
    options?: { intoBranch?: string; deleteBranch?: boolean; keepFloor?: boolean }
  ): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    const floor = ws.floors.find((f) => idsEqual(f.id, floorId));
    if (!floor) return { ok: false, error: 'Floor not found' };

    if (floor.cloneKind === 'worktree' && floor.clonePath && floor.branchName) {
      const targetBranch =
        options?.intoBranch?.trim() ||
        floor.groundBranch ||
        (await this.getGitBranch(ws.workingDirectory)) ||
        'main';
      let mergeStarted = false;
      try {
        if (await this.hasUncommittedChanges(floor.clonePath)) {
          return {
            ok: false,
            error: `Floor "${floor.name}" has uncommitted changes. Commit or stash them before landing.`,
          };
        }

        const shouldMerge = Boolean(
          targetBranch && targetBranch !== 'HEAD' && targetBranch !== floor.branchName
        );
        if (shouldMerge) {
          if (await this.hasUncommittedChanges(ws.workingDirectory)) {
            return {
              ok: false,
              error: 'Ground workspace has uncommitted changes. Commit or stash them before landing.',
            };
          }
          const groundBranch = await this.getGitBranch(ws.workingDirectory);
          if (groundBranch !== targetBranch) {
            await execFileAsync('git', ['checkout', targetBranch], { cwd: ws.workingDirectory });
          }
          mergeStarted = true;
          await execFileAsync('git', ['merge', '--no-edit', floor.branchName], {
            cwd: ws.workingDirectory,
          });
          mergeStarted = false;
        }

        if (!options?.keepFloor) {
          await execFileAsync('git', ['worktree', 'remove', floor.clonePath], {
            cwd: ws.workingDirectory,
          });
          if (options?.deleteBranch) {
            await execFileAsync('git', ['branch', '-d', floor.branchName], {
              cwd: ws.workingDirectory,
            }).catch(() => undefined);
          }
        }
      } catch (err) {
        if (mergeStarted) {
          await execFileAsync('git', ['merge', '--abort'], { cwd: ws.workingDirectory }).catch(
            () => undefined
          );
        }
        return { ok: false, error: this.formatExecError(err) };
      }
    }

    if (!options?.keepFloor) {
      await this.deleteFloor(workspaceId, floorId, false);
    }
    return {
      ok: true,
      message: options?.keepFloor
        ? `Landed floor "${floor.name}" (kept floor open).`
        : `Landed floor "${floor.name}".`,
    };
  }

  private formatExecError(err: unknown): string {
    if (err && typeof err === 'object' && 'stderr' in err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
      if (stderr) return stderr;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private async hasUncommittedChanges(dir: string): Promise<boolean> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
    return stdout.split(/\r?\n/).some((line) => {
      if (line.length < 4) return false;
      const status = line.slice(0, 2);
      const file = line.slice(3).trim().replace(/^"|"$/g, '');
      if (status === '??' && (file === '.orkestrei' || file.startsWith('.orkestrei/'))) {
        return false;
      }
      return true;
    });
  }

  async deleteFloor(
    workspaceId: string,
    floorId: string,
    removeWorktree = true
  ): Promise<{ removedNodeIds: string[]; removedTerminalIds: string[] }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { removedNodeIds: [], removedTerminalIds: [] };
    const floor = ws.floors.find((f) => idsEqual(f.id, floorId));
    if (!floor) return { removedNodeIds: [], removedTerminalIds: [] };

    if (removeWorktree && floor.cloneKind === 'worktree' && floor.clonePath) {
      await execFileAsync('git', ['worktree', 'remove', '--force', floor.clonePath], {
        cwd: ws.workingDirectory,
      }).catch(() => undefined);
    }

    const removedNodeIds = floor.nodes.map((n) => n.id);
    const removedTerminalIds = floor.nodes.flatMap((n) =>
      n.content.kind === 'terminal' ? [n.content.terminal.id] : []
    );

    const updated: Workspace = {
      ...ws,
      activeFloorId: idsEqual(ws.activeFloorId, floorId) ? null : ws.activeFloorId,
      floors: ws.floors.filter((f) => !idsEqual(f.id, floorId)),
      crossFloorConnections: ws.crossFloorConnections.filter(
        (c) => !idsEqual(c.floorIdA, floorId) && !idsEqual(c.floorIdB, floorId)
      ),
    };
    await this.commitWorkspace(updated);
    return { removedNodeIds, removedTerminalIds };
  }

  private async isGitRepo(dir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async getGitBranch(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: dir,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // Node placement (smart non-overlapping placement)
  placeNodeNear(
    ws: Workspace,
    floorId: string | null,
    anchorRect: Rect | null,
    size: { width: number; height: number },
    side: 'right' | 'left' | 'below' = 'right'
  ): Rect {
    const level = this.getLevelContents(ws, floorId);
    const gap = 56;
    let x = anchorRect ? anchorRect.x + anchorRect.width + gap : 120;
    let y = anchorRect ? anchorRect.y : 120;
    if (side === 'left' && anchorRect) {
      x = anchorRect.x - size.width - gap;
    } else if (side === 'below' && anchorRect) {
      x = anchorRect.x;
      y = anchorRect.y + anchorRect.height + gap;
    }

    const overlaps = (cand: Rect): boolean =>
      level.nodes.some(
        (n) =>
          cand.x < n.frame.x + n.frame.width + 20 &&
          cand.x + cand.width + 20 > n.frame.x &&
          cand.y < n.frame.y + n.frame.height + 20 &&
          cand.y + cand.height + 20 > n.frame.y
      );

    let attempts = 0;
    const candidate: Rect = { x, y, width: size.width, height: size.height };
    while (overlaps(candidate) && attempts < 24) {
      candidate.y += 140;
      if (attempts % 4 === 3) {
        candidate.x += side === 'left' ? -(size.width + 40) : size.width + 40;
        candidate.y = y;
      }
      attempts += 1;
    }
    return candidate;
  }

  // Node CRUD
  async createNode(
    workspaceId: string,
    node: CanvasNode,
    floorId?: string | null
  ): Promise<CanvasNode | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const targetFloorId = floorId === undefined ? ws.activeFloorId : floorId;
    this.pushUndo(ws, targetFloorId);

    if (node.content.kind === 'stickyNote') {
      await this.writeNoteFile(workspaceId, node.content.stickyNote.fileName, node.content.stickyNote.text);
    }

    const maxZ = this.getLevelContents(ws, targetFloorId).nodes.reduce(
      (max, n) => Math.max(max, n.zIndex),
      0
    );
    const placed: CanvasNode = { ...node, zIndex: Math.max(node.zIndex, maxZ + 1) };
    const updated = this.mapLevel(ws, targetFloorId, (lvl) => ({
      ...lvl,
      nodes: [...lvl.nodes, placed],
    }));
    await this.commitWorkspace(updated);
    return placed;
  }

  async patchNode(
    workspaceId: string,
    nodeId: string,
    patch: Partial<CanvasNode>
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, nodeId);
    if (!loc) return null;

    const updated = this.mapLevel(ws, loc.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) =>
        idsEqual(n.id, nodeId)
          ? {
              ...n,
              ...patch,
              frame: patch.frame ? { ...n.frame, ...patch.frame } : n.frame,
              lastModifiedAt: new Date().toISOString(),
            }
          : n
      ),
    }));
    return this.commitWorkspace(updated);
  }

  async patchFrames(
    workspaceId: string,
    patches: Array<{ nodeId: string; frame: Partial<Rect> }>
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws || patches.length === 0) return ws;
    const patchMap = new Map(patches.map((p) => [p.nodeId.toLowerCase(), p.frame]));
    const first = this.findNodeLocation(ws, patches[0].nodeId);
    const floorId = first?.floorId ?? ws.activeFloorId;
    this.pushUndo(ws, floorId);

    const updated = this.mapLevel(ws, floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) => {
        const pf = patchMap.get(n.id.toLowerCase());
        if (!pf) return n;
        return {
          ...n,
          frame: { ...n.frame, ...pf },
          lastModifiedAt: new Date().toISOString(),
        };
      }),
    }));
    return this.commitWorkspace(updated);
  }

  async updateTerminalData(
    workspaceId: string,
    terminalIdOrNodeId: string,
    patch: Partial<TerminalData>
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const found = this.findTerminal(ws, terminalIdOrNodeId);
    if (!found) return null;

    const updated = this.mapLevel(ws, found.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) =>
        idsEqual(n.id, found.node.id) && n.content.kind === 'terminal'
          ? {
              ...n,
              lastModifiedAt: new Date().toISOString(),
              content: {
                kind: 'terminal',
                terminal: { ...n.content.terminal, ...patch },
              },
            }
          : n
      ),
    }));
    return this.commitWorkspace(updated);
  }

  async deleteNodes(
    workspaceId: string,
    nodeIds: string[]
  ): Promise<{ workspace: Workspace | null; deletedTerminalIds: string[] }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws || nodeIds.length === 0) return { workspace: ws, deletedTerminalIds: [] };

    const targetSet = new Set(nodeIds.map((id) => id.toLowerCase()));
    const deletedTerminalIds: string[] = [];

    const cleanLevel = (lvl: CanvasLevelContents): CanvasLevelContents => {
      const removedNodes = lvl.nodes.filter((n) => targetSet.has(n.id.toLowerCase()));
      for (const rn of removedNodes) {
        if (rn.content.kind === 'terminal') {
          deletedTerminalIds.push(rn.content.terminal.id);
        }
      }
      const termSet = new Set(deletedTerminalIds.map((id) => id.toLowerCase()));

      // Also drop removed nodes from bands or noteStacks
      const survivingNodes = lvl.nodes
        .filter((n) => !targetSet.has(n.id.toLowerCase()))
        .map((n) => {
          if (n.content.kind === 'band') {
            const nextMembers = n.content.band.memberNodeIds.filter(
              (m) => !targetSet.has(m.toLowerCase())
            );
            return {
              ...n,
              content: {
                kind: 'band' as const,
                band: {
                  ...n.content.band,
                  memberNodeIds: nextMembers,
                  selectedMemberNodeId:
                    nextMembers.includes(n.content.band.selectedMemberNodeId ?? '')
                      ? n.content.band.selectedMemberNodeId
                      : (nextMembers[0] ?? null),
                },
              },
            };
          }
          if (n.content.kind === 'noteStack') {
            const nextMembers = n.content.noteStack.memberNodeIds.filter(
              (m) => !targetSet.has(m.toLowerCase())
            );
            return {
              ...n,
              content: {
                kind: 'noteStack' as const,
                noteStack: {
                  ...n.content.noteStack,
                  memberNodeIds: nextMembers,
                  frontNoteId:
                    nextMembers.includes(n.content.noteStack.frontNoteId ?? '')
                      ? n.content.noteStack.frontNoteId
                      : (nextMembers[0] ?? null),
                },
              },
            };
          }
          return n;
        });

      return {
        ...lvl,
        nodes: survivingNodes,
        connections: lvl.connections.filter(
          (c) =>
            !targetSet.has(c.terminalIdA.toLowerCase()) &&
            !targetSet.has(c.terminalIdB.toLowerCase()) &&
            !termSet.has(c.terminalIdA.toLowerCase()) &&
            !termSet.has(c.terminalIdB.toLowerCase())
        ),
        noteConnections: lvl.noteConnections.filter(
          (c) =>
            !targetSet.has(c.terminalId.toLowerCase()) &&
            !termSet.has(c.terminalId.toLowerCase()) &&
            !targetSet.has(c.noteNodeId.toLowerCase())
        ),
        noteToNoteConnections: lvl.noteToNoteConnections.filter(
          (c) =>
            !targetSet.has(c.noteNodeIdA.toLowerCase()) &&
            !targetSet.has(c.noteNodeIdB.toLowerCase())
        ),
        portalConnections: lvl.portalConnections.filter(
          (c) =>
            !targetSet.has(c.terminalId.toLowerCase()) &&
            !termSet.has(c.terminalId.toLowerCase()) &&
            !targetSet.has(c.portalNodeId.toLowerCase())
        ),
        portalToPortalConnections: lvl.portalToPortalConnections.filter(
          (c) =>
            !targetSet.has(c.portalNodeIdA.toLowerCase()) &&
            !targetSet.has(c.portalNodeIdB.toLowerCase())
        ),
      };
    };

    this.pushUndo(ws, ws.activeFloorId);
    const updated: Workspace = {
      ...ws,
      ...cleanLevel(ws),
      floors: ws.floors.map((f) => ({ ...f, ...cleanLevel(f) })),
      crossFloorConnections: ws.crossFloorConnections.filter(
        (c) =>
          !deletedTerminalIds.some((t) => idsEqual(t, c.terminalIdA) || idsEqual(t, c.terminalIdB))
      ),
      crossWorkspaceConnections: ws.crossWorkspaceConnections.filter(
        (c) =>
          !deletedTerminalIds.some((t) => idsEqual(t, c.localTerminalId)) &&
          !targetSet.has(c.connectorNodeId.toLowerCase())
      ),
    };
    await this.commitWorkspace(updated);
    return { workspace: updated, deletedTerminalIds };
  }

  async duplicateNode(workspaceId: string, nodeId: string): Promise<CanvasNode | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, nodeId);
    if (!loc) return null;

    const now = new Date().toISOString();
    const clonedNode: CanvasNode = structuredClone(loc.node);
    clonedNode.id = newId();
    clonedNode.frame = {
      ...loc.node.frame,
      x: loc.node.frame.x + 36,
      y: loc.node.frame.y + 36,
    };
    clonedNode.isDocked = false;
    clonedNode.groupId = null;
    clonedNode.createdAt = now;
    clonedNode.lastModifiedAt = now;

    if (clonedNode.content.kind === 'terminal') {
      clonedNode.content.terminal = {
        ...clonedNode.content.terminal,
        id: newId(),
        name: `${clonedNode.content.terminal.name} Copy`,
      };
    } else if (clonedNode.content.kind === 'stickyNote') {
      const baseName =
        clonedNode.content.stickyNote.customName ||
        displayNameForNoteFile(clonedNode.content.stickyNote.fileName);
      const copyTitle = `${baseName} Copy`;
      clonedNode.content.stickyNote = {
        ...clonedNode.content.stickyNote,
        customName: copyTitle,
        fileName: `${sanitizeFileName(copyTitle)}-${Date.now().toString(36).slice(-4)}.md`,
      };
    }

    return this.createNode(workspaceId, clonedNode, loc.floorId);
  }

  async moveNodeToFloor(
    workspaceId: string,
    nodeId: string,
    targetFloorId: string | null
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, nodeId);
    if (!loc || sameFloor(loc.floorId, targetFloorId)) return ws;
    if (targetFloorId && !ws.floors.some((f) => idsEqual(f.id, targetFloorId))) return null;

    this.pushUndo(ws, loc.floorId);

    const movedNode: CanvasNode = structuredClone(loc.node);
    movedNode.isDocked = false;
    movedNode.groupId = null;
    movedNode.lastModifiedAt = new Date().toISOString();

    const targetFloor = targetFloorId
      ? ws.floors.find((f) => idsEqual(f.id, targetFloorId)) ?? null
      : null;

    let movedTerminalId: string | null = null;
    if (movedNode.content.kind === 'terminal') {
      movedTerminalId = movedNode.content.terminal.id;
      movedNode.content.terminal = {
        ...movedNode.content.terminal,
        workingDirectory: targetFloor?.clonePath || ws.workingDirectory,
      };
    }

    const srcLevel = this.getLevelContents(ws, loc.floorId);
    const removedConnIds = new Set<string>();
    const newCrossFloor: CrossFloorConnection[] = [];
    const promotedConnections: Array<{ id: string; terminalIdA: string; terminalIdB: string }> = [];

    if (movedTerminalId) {
      for (const c of srcLevel.connections) {
        const touches =
          idsEqual(c.terminalIdA, movedTerminalId) || idsEqual(c.terminalIdB, movedTerminalId);
        if (!touches) continue;
        removedConnIds.add(c.id.toLowerCase());
        const peerId = idsEqual(c.terminalIdA, movedTerminalId) ? c.terminalIdB : c.terminalIdA;
        const peerTerm = this.findTerminal(ws, peerId);
        if (peerTerm) {
          newCrossFloor.push({
            id: c.id,
            floorIdA: targetFloorId,
            terminalIdA: movedTerminalId,
            connectorNodeIdA: movedNode.id,
            floorIdB: peerTerm.floorId,
            terminalIdB: peerTerm.terminal.id,
            connectorNodeIdB: peerTerm.node.id,
          });
        }
      }
    }

    const survivingCrossFloor: CrossFloorConnection[] = [];
    for (const cf of ws.crossFloorConnections) {
      if (!movedTerminalId) {
        survivingCrossFloor.push(cf);
        continue;
      }
      const isA = idsEqual(cf.terminalIdA, movedTerminalId);
      const isB = idsEqual(cf.terminalIdB, movedTerminalId);
      if (!isA && !isB) {
        survivingCrossFloor.push(cf);
        continue;
      }
      const peerFloorId = isA ? cf.floorIdB : cf.floorIdA;
      if (sameFloor(peerFloorId, targetFloorId)) {
        promotedConnections.push({
          id: cf.id,
          terminalIdA: cf.terminalIdA,
          terminalIdB: cf.terminalIdB,
        });
      } else {
        survivingCrossFloor.push({
          ...cf,
          floorIdA: isA ? targetFloorId : cf.floorIdA,
          floorIdB: isB ? targetFloorId : cf.floorIdB,
        });
      }
    }

    const isRemovedRef = (id: string): boolean =>
      idsEqual(id, nodeId) || (movedTerminalId !== null && idsEqual(id, movedTerminalId));

    const stripFromSrc = (lvl: CanvasLevelContents): CanvasLevelContents => {
      for (const nc of lvl.noteConnections) {
        if (isRemovedRef(nc.terminalId) || isRemovedRef(nc.noteNodeId)) {
          removedConnIds.add(nc.id.toLowerCase());
        }
      }
      for (const pc of lvl.portalConnections) {
        if (isRemovedRef(pc.terminalId) || isRemovedRef(pc.portalNodeId)) {
          removedConnIds.add(pc.id.toLowerCase());
        }
      }
      return {
        ...lvl,
        nodes: lvl.nodes.filter((n) => !idsEqual(n.id, nodeId)),
        connections: lvl.connections.filter(
          (c) => !isRemovedRef(c.terminalIdA) && !isRemovedRef(c.terminalIdB)
        ),
        noteConnections: lvl.noteConnections.filter(
          (c) => !isRemovedRef(c.terminalId) && !isRemovedRef(c.noteNodeId)
        ),
        noteToNoteConnections: lvl.noteToNoteConnections.filter(
          (c) => !isRemovedRef(c.noteNodeIdA) && !isRemovedRef(c.noteNodeIdB)
        ),
        portalConnections: lvl.portalConnections.filter(
          (c) => !isRemovedRef(c.terminalId) && !isRemovedRef(c.portalNodeId)
        ),
        portalToPortalConnections: lvl.portalToPortalConnections.filter(
          (c) => !isRemovedRef(c.portalNodeIdA) && !isRemovedRef(c.portalNodeIdB)
        ),
        cableTies: lvl.cableTies
          .map((t) => ({
            ...t,
            memberRopeIds: t.memberRopeIds.filter((rid) => !removedConnIds.has(rid.toLowerCase())),
          }))
          .filter((t) => t.memberRopeIds.length >= 2),
      };
    };

    const addToDest = (lvl: CanvasLevelContents): CanvasLevelContents => {
      const maxZ = lvl.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0);
      return {
        ...lvl,
        nodes: [...lvl.nodes, { ...movedNode, zIndex: maxZ + 1 }],
        connections: [...lvl.connections, ...promotedConnections],
      };
    };

    let updated = this.mapLevel(ws, loc.floorId, stripFromSrc);
    updated = this.mapLevel(updated, targetFloorId, addToDest);
    updated = {
      ...updated,
      dockedNodeId: idsEqual(updated.dockedNodeId, nodeId) ? null : updated.dockedNodeId,
      liftedNodeId: idsEqual(updated.liftedNodeId, nodeId) ? null : updated.liftedNodeId,
      floors: updated.floors.map((f) => ({
        ...f,
        dockedNodeId: idsEqual(f.dockedNodeId, nodeId) ? null : f.dockedNodeId,
        liftedNodeId: idsEqual(f.liftedNodeId, nodeId) ? null : f.liftedNodeId,
      })),
      crossFloorConnections: [...survivingCrossFloor, ...newCrossFloor],
      crossWorkspaceConnections: updated.crossWorkspaceConnections.map((cw) =>
        movedTerminalId && idsEqual(cw.localTerminalId, movedTerminalId)
          ? { ...cw, localFloorId: targetFloorId }
          : cw
      ),
    };

    return this.commitWorkspace(updated);
  }

  // Connections
  async connectNodes(
    workspaceId: string,
    fromId: string,
    toId: string
  ): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { ok: false, error: 'Workspace not found' };

    const locA = this.findNodeOrTerminal(ws, fromId);
    const locB = this.findNodeOrTerminal(ws, toId);
    if (!locA || !locB) return { ok: false, error: 'Source or target node not found' };
    if (idsEqual(locA.node.id, locB.node.id)) {
      return { ok: false, error: 'Cannot connect a node to itself' };
    }

    const kindA = locA.node.content.kind;
    const kindB = locB.node.content.kind;
    const isAgentA = kindA === 'terminal' || kindA === 'band';
    const isAgentB = kindB === 'terminal' || kindB === 'band';
    const isNoteA = kindA === 'stickyNote' || kindA === 'noteStack';
    const isNoteB = kindB === 'stickyNote' || kindB === 'noteStack';
    const isPortalA = kindA === 'portal';
    const isPortalB = kindB === 'portal';

    // Cross-floor agent connection?
    if (!sameFloor(locA.floorId, locB.floorId)) {
      if (!isAgentA || !isAgentB || kindA !== 'terminal' || kindB !== 'terminal') {
        return { ok: false, error: 'Only terminals can be connected across floors' };
      }
      const termA = (locA.node.content as { kind: 'terminal'; terminal: TerminalData }).terminal.id;
      const termB = (locB.node.content as { kind: 'terminal'; terminal: TerminalData }).terminal.id;
      const exists = ws.crossFloorConnections.find(
        (c) =>
          (idsEqual(c.terminalIdA, termA) && idsEqual(c.terminalIdB, termB)) ||
          (idsEqual(c.terminalIdA, termB) && idsEqual(c.terminalIdB, termA))
      );
      if (exists) return { ok: true, connectionId: exists.id };
      const connId = newId();
      const conn: CrossFloorConnection = {
        id: connId,
        floorIdA: locA.floorId,
        terminalIdA: termA,
        connectorNodeIdA: locA.node.id,
        floorIdB: locB.floorId,
        terminalIdB: termB,
        connectorNodeIdB: locB.node.id,
      };
      await this.commitWorkspace({
        ...ws,
        crossFloorConnections: [...ws.crossFloorConnections, conn],
      });
      return { ok: true, connectionId: connId };
    }

    const floorId = locA.floorId;
    this.pushUndo(ws, floorId);
    const idA =
      locA.node.content.kind === 'terminal' ? locA.node.content.terminal.id : locA.node.id;
    const idB =
      locB.node.content.kind === 'terminal' ? locB.node.content.terminal.id : locB.node.id;

    const connId = newId();
    if (isAgentA && isAgentB) {
      const level = this.getLevelContents(ws, floorId);
      const existing = level.connections.find(
        (c) =>
          (idsEqual(c.terminalIdA, idA) && idsEqual(c.terminalIdB, idB)) ||
          (idsEqual(c.terminalIdA, idB) && idsEqual(c.terminalIdB, idA))
      );
      if (existing) return { ok: true, connectionId: existing.id };
      const next = this.mapLevel(ws, floorId, (lvl) => ({
        ...lvl,
        connections: [...lvl.connections, { id: connId, terminalIdA: idA, terminalIdB: idB }],
      }));
      await this.commitWorkspace(next);
      return { ok: true, connectionId: connId };
    }

    if ((isAgentA && isNoteB) || (isNoteA && isAgentB)) {
      const termId = isAgentA ? idA : idB;
      const noteId = isNoteA ? locA.node.id : locB.node.id;
      const level = this.getLevelContents(ws, floorId);
      const existing = level.noteConnections.find(
        (c) => idsEqual(c.terminalId, termId) && idsEqual(c.noteNodeId, noteId)
      );
      if (existing) return { ok: true, connectionId: existing.id };
      const next = this.mapLevel(ws, floorId, (lvl) => ({
        ...lvl,
        noteConnections: [...lvl.noteConnections, { id: connId, terminalId: termId, noteNodeId: noteId }],
      }));
      await this.commitWorkspace(next);
      return { ok: true, connectionId: connId };
    }

    if (isNoteA && isNoteB) {
      const level = this.getLevelContents(ws, floorId);
      const existing = level.noteToNoteConnections.find(
        (c) =>
          (idsEqual(c.noteNodeIdA, locA.node.id) && idsEqual(c.noteNodeIdB, locB.node.id)) ||
          (idsEqual(c.noteNodeIdA, locB.node.id) && idsEqual(c.noteNodeIdB, locA.node.id))
      );
      if (existing) return { ok: true, connectionId: existing.id };
      const next = this.mapLevel(ws, floorId, (lvl) => ({
        ...lvl,
        noteToNoteConnections: [
          ...lvl.noteToNoteConnections,
          { id: connId, noteNodeIdA: locA.node.id, noteNodeIdB: locB.node.id },
        ],
      }));
      await this.commitWorkspace(next);
      return { ok: true, connectionId: connId };
    }

    if ((isAgentA && isPortalB) || (isPortalA && isAgentB)) {
      const termId = isAgentA ? idA : idB;
      const portalId = isPortalA ? locA.node.id : locB.node.id;
      const level = this.getLevelContents(ws, floorId);
      const existing = level.portalConnections.find(
        (c) => idsEqual(c.terminalId, termId) && idsEqual(c.portalNodeId, portalId)
      );
      if (existing) return { ok: true, connectionId: existing.id };
      const next = this.mapLevel(ws, floorId, (lvl) => ({
        ...lvl,
        portalConnections: [
          ...lvl.portalConnections,
          { id: connId, terminalId: termId, portalNodeId: portalId },
        ],
      }));
      await this.commitWorkspace(next);
      return { ok: true, connectionId: connId };
    }

    if (isPortalA && isPortalB) {
      const next = this.mapLevel(ws, floorId, (lvl) => ({
        ...lvl,
        portalToPortalConnections: [
          ...lvl.portalToPortalConnections,
          { id: connId, portalNodeIdA: locA.node.id, portalNodeIdB: locB.node.id },
        ],
      }));
      await this.commitWorkspace(next);
      return { ok: true, connectionId: connId };
    }

    return { ok: false, error: `Unsupported connection between ${kindA} and ${kindB}` };
  }

  async deleteConnection(workspaceId: string, connectionId: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    this.pushUndo(ws, ws.activeFloorId);
    const filterLvl = (lvl: CanvasLevelContents): CanvasLevelContents => ({
      ...lvl,
      connections: lvl.connections.filter((c) => !idsEqual(c.id, connectionId)),
      noteConnections: lvl.noteConnections.filter((c) => !idsEqual(c.id, connectionId)),
      noteToNoteConnections: lvl.noteToNoteConnections.filter((c) => !idsEqual(c.id, connectionId)),
      portalConnections: lvl.portalConnections.filter((c) => !idsEqual(c.id, connectionId)),
      portalToPortalConnections: lvl.portalToPortalConnections.filter(
        (c) => !idsEqual(c.id, connectionId)
      ),
      cableTies: lvl.cableTies
        .map((t) => ({
          ...t,
          memberRopeIds: t.memberRopeIds.filter((rid) => !idsEqual(rid, connectionId)),
        }))
        .filter((t) => t.memberRopeIds.length >= 2),
    });

    const updated: Workspace = {
      ...ws,
      ...filterLvl(ws),
      floors: ws.floors.map((f) => ({ ...f, ...filterLvl(f) })),
      crossFloorConnections: ws.crossFloorConnections.filter((c) => !idsEqual(c.id, connectionId)),
      crossWorkspaceConnections: ws.crossWorkspaceConnections.filter(
        (c) => !idsEqual(c.id, connectionId)
      ),
    };
    return this.commitWorkspace(updated);
  }

  async disconnectAllForNode(workspaceId: string, nodeIdOrTermId: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeOrTerminal(ws, nodeIdOrTermId);
    if (!loc) return ws;

    const targetIds = new Set<string>([loc.node.id.toLowerCase()]);
    if (loc.node.content.kind === 'terminal') {
      targetIds.add(loc.node.content.terminal.id.toLowerCase());
    }
    const matchesTarget = (id: string) => targetIds.has(id.toLowerCase());

    this.pushUndo(ws, loc.floorId);

    // Identify removed cross-floor connections to include their IDs in cableTies cleanup (B1)
    const removedCrossFloorIds = new Set<string>();
    for (const c of ws.crossFloorConnections) {
      if (matchesTarget(c.terminalIdA) || matchesTarget(c.terminalIdB)) {
        removedCrossFloorIds.add(c.id.toLowerCase());
      }
    }

    const filterLvl = (lvl: CanvasLevelContents): CanvasLevelContents => {
      const removedIds = new Set<string>(removedCrossFloorIds);
      for (const c of lvl.connections) {
        if (matchesTarget(c.terminalIdA) || matchesTarget(c.terminalIdB)) removedIds.add(c.id.toLowerCase());
      }
      for (const c of lvl.noteConnections) {
        if (matchesTarget(c.terminalId) || matchesTarget(c.noteNodeId)) removedIds.add(c.id.toLowerCase());
      }
      for (const c of lvl.noteToNoteConnections) {
        if (matchesTarget(c.noteNodeIdA) || matchesTarget(c.noteNodeIdB)) removedIds.add(c.id.toLowerCase());
      }
      for (const c of lvl.portalConnections) {
        if (matchesTarget(c.terminalId) || matchesTarget(c.portalNodeId)) removedIds.add(c.id.toLowerCase());
      }
      for (const c of lvl.portalToPortalConnections) {
        if (matchesTarget(c.portalNodeIdA) || matchesTarget(c.portalNodeIdB)) removedIds.add(c.id.toLowerCase());
      }
      return {
        ...lvl,
        connections: lvl.connections.filter(
          (c) => !matchesTarget(c.terminalIdA) && !matchesTarget(c.terminalIdB)
        ),
        noteConnections: lvl.noteConnections.filter(
          (c) => !matchesTarget(c.terminalId) && !matchesTarget(c.noteNodeId)
        ),
        noteToNoteConnections: lvl.noteToNoteConnections.filter(
          (c) => !matchesTarget(c.noteNodeIdA) && !matchesTarget(c.noteNodeIdB)
        ),
        portalConnections: lvl.portalConnections.filter(
          (c) => !matchesTarget(c.terminalId) && !matchesTarget(c.portalNodeId)
        ),
        portalToPortalConnections: lvl.portalToPortalConnections.filter(
          (c) => !matchesTarget(c.portalNodeIdA) && !matchesTarget(c.portalNodeIdB)
        ),
        cableTies: lvl.cableTies
          .map((t) => ({
            ...t,
            memberRopeIds: t.memberRopeIds.filter((rid) => !removedIds.has(rid.toLowerCase())),
          }))
          .filter((t) => t.memberRopeIds.length >= 2),
      };
    };

    // Remove mirror edges in remote workspaces (C1)
    const removedCrossWsConnections = ws.crossWorkspaceConnections.filter(
      (c) => matchesTarget(c.localTerminalId) || matchesTarget(c.connectorNodeId)
    );
    for (const conn of removedCrossWsConnections) {
      const remoteWs = this.getWorkspace(conn.remoteWorkspaceId);
      if (remoteWs) {
        const nextRemoteConns = remoteWs.crossWorkspaceConnections.filter(
          (rc) =>
            !idsEqual(rc.id, conn.id) &&
            !(
              idsEqual(rc.remoteWorkspaceId, ws.id) &&
              (matchesTarget(rc.remoteTerminalId) || idsEqual(rc.localTerminalId, conn.remoteTerminalId))
            )
        );
        if (nextRemoteConns.length !== remoteWs.crossWorkspaceConnections.length) {
          await this.commitWorkspace({
            ...remoteWs,
            crossWorkspaceConnections: nextRemoteConns,
          });
        }
      }
    }

    const updated: Workspace = {
      ...ws,
      ...filterLvl(ws),
      floors: ws.floors.map((f) => ({ ...f, ...filterLvl(f) })),
      crossFloorConnections: ws.crossFloorConnections.filter(
        (c) => !matchesTarget(c.terminalIdA) && !matchesTarget(c.terminalIdB)
      ),
      crossWorkspaceConnections: ws.crossWorkspaceConnections.filter(
        (c) => !matchesTarget(c.localTerminalId) && !matchesTarget(c.connectorNodeId)
      ),
    };
    return this.commitWorkspace(updated);
  }

  /**
   * Removes every connection (rope) between two specific nodes, in any level and across floors.
   * Accepts node ids or terminal ids for either end. Returns how many connections were removed.
   */
  async disconnectNodes(
    workspaceId: string,
    fromId: string,
    toId: string
  ): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    const locA = this.findNodeOrTerminal(ws, fromId);
    const locB = this.findNodeOrTerminal(ws, toId);
    if (!locA || !locB) return { ok: false, error: 'Source or target node not found' };

    const idSet = (loc: NonNullable<typeof locA>) => {
      const s = new Set<string>([loc.node.id.toLowerCase()]);
      if (loc.node.content.kind === 'terminal') s.add(loc.node.content.terminal.id.toLowerCase());
      return s;
    };
    const setA = idSet(locA);
    const setB = idSet(locB);
    const between = (x: string, y: string) =>
      (setA.has(x.toLowerCase()) && setB.has(y.toLowerCase())) ||
      (setA.has(y.toLowerCase()) && setB.has(x.toLowerCase()));

    const removedIds = new Set<string>();
    const collect = (lvl: CanvasLevelContents) => {
      for (const c of lvl.connections) if (between(c.terminalIdA, c.terminalIdB)) removedIds.add(c.id.toLowerCase());
      for (const c of lvl.noteConnections) if (between(c.terminalId, c.noteNodeId)) removedIds.add(c.id.toLowerCase());
      for (const c of lvl.noteToNoteConnections) if (between(c.noteNodeIdA, c.noteNodeIdB)) removedIds.add(c.id.toLowerCase());
      for (const c of lvl.portalConnections) if (between(c.terminalId, c.portalNodeId)) removedIds.add(c.id.toLowerCase());
      for (const c of lvl.portalToPortalConnections) if (between(c.portalNodeIdA, c.portalNodeIdB)) removedIds.add(c.id.toLowerCase());
    };
    collect(ws);
    for (const f of ws.floors) collect(f);
    for (const c of ws.crossFloorConnections) if (between(c.terminalIdA, c.terminalIdB)) removedIds.add(c.id.toLowerCase());

    if (removedIds.size === 0) return { ok: true, removed: 0 };

    const keep = (c: { id: string }) => !removedIds.has(c.id.toLowerCase());
    const hasCrossFloor = ws.crossFloorConnections.some((c) => removedIds.has(c.id.toLowerCase()));
    const differentFloors = !sameFloor(locA.floorId, locB.floorId);

    const targetFloorId =
      sameFloor(ws.activeFloorId, locA.floorId) || sameFloor(ws.activeFloorId, locB.floorId)
        ? ws.activeFloorId
        : locA.floorId;

    const extra: {
      crossFloorConnections?: CrossFloorConnection[];
      secondaryLevel?: {
        levelFloorId: string | null;
        contents: CanvasLevelContents;
      };
    } = {};

    if (hasCrossFloor) {
      extra.crossFloorConnections = ws.crossFloorConnections;
    }
    if (differentFloors) {
      const otherFloorId = sameFloor(targetFloorId, locA.floorId) ? locB.floorId : locA.floorId;
      extra.secondaryLevel = {
        levelFloorId: otherFloorId,
        contents: this.getLevelContents(ws, otherFloorId),
      };
    }

    this.pushUndo(
      ws,
      targetFloorId,
      hasCrossFloor || differentFloors ? extra : undefined
    );
    const filterLvl = (lvl: CanvasLevelContents): CanvasLevelContents => ({
      ...lvl,
      connections: lvl.connections.filter(keep),
      noteConnections: lvl.noteConnections.filter(keep),
      noteToNoteConnections: lvl.noteToNoteConnections.filter(keep),
      portalConnections: lvl.portalConnections.filter(keep),
      portalToPortalConnections: lvl.portalToPortalConnections.filter(keep),
      cableTies: lvl.cableTies
        .map((t) => ({
          ...t,
          memberRopeIds: t.memberRopeIds.filter((rid) => !removedIds.has(rid.toLowerCase())),
        }))
        .filter((t) => t.memberRopeIds.length >= 2),
    });
    await this.commitWorkspace({
      ...ws,
      ...filterLvl(ws),
      floors: ws.floors.map((f) => ({ ...f, ...filterLvl(f) })),
      crossFloorConnections: ws.crossFloorConnections.filter(keep),
    });
    return { ok: true, removed: removedIds.size };
  }

  /**
   * Removes the cross-workspace connection between two terminals from both workspaces.
   * Note (A3): Consistent with connectAcrossWorkspaces, cross-workspace operations do not create
   * undo snapshots because they mutate two distinct workspace files across persistence boundaries.
   */
  async disconnectAcrossWorkspaces(
    workspaceAId: string,
    terminalAId: string,
    workspaceBId: string,
    terminalBId: string
  ): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
    if (idsEqual(workspaceAId, workspaceBId)) {
      return this.disconnectNodes(workspaceAId, terminalAId, terminalBId);
    }
    const wsA = this.getWorkspace(workspaceAId);
    const wsB = this.getWorkspace(workspaceBId);
    if (!wsA || !wsB) return { ok: false, error: 'Workspace not found' };
    const foundA = this.findTerminal(wsA, terminalAId);
    const foundB = this.findTerminal(wsB, terminalBId);
    if (!foundA || !foundB) return { ok: false, error: 'Terminal not found' };

    let removed = 0;
    const strip = async (ws: Workspace, localTerm: string, remoteWs: string, remoteTerm: string) => {
      const fresh = this.getWorkspace(ws.id) ?? ws;
      const next = fresh.crossWorkspaceConnections.filter(
        (c) =>
          !(
            idsEqual(c.localTerminalId, localTerm) &&
            idsEqual(c.remoteWorkspaceId, remoteWs) &&
            idsEqual(c.remoteTerminalId, remoteTerm)
          )
      );
      if (next.length === fresh.crossWorkspaceConnections.length) return;
      removed += fresh.crossWorkspaceConnections.length - next.length;
      await this.commitWorkspace({ ...fresh, crossWorkspaceConnections: next });
    };
    await strip(wsA, foundA.terminal.id, wsB.id, foundB.terminal.id);
    await strip(wsB, foundB.terminal.id, wsA.id, foundA.terminal.id);
    return { ok: true, removed: removed > 0 ? 1 : 0 };
  }

  async connectAcrossWorkspaces(
    workspaceAId: string,
    terminalAId: string,
    workspaceBId: string,
    terminalBId: string
  ): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
    const wsA = this.getWorkspace(workspaceAId);
    const wsB = this.getWorkspace(workspaceBId);
    if (!wsA || !wsB) return { ok: false, error: 'Workspace not found' };
    if (idsEqual(wsA.id, wsB.id)) {
      return this.connectNodes(wsA.id, terminalAId, terminalBId);
    }

    const foundA = this.findTerminal(wsA, terminalAId);
    const foundB = this.findTerminal(wsB, terminalBId);
    if (!foundA || !foundB) return { ok: false, error: 'Terminal not found' };

    const existing = wsA.crossWorkspaceConnections.find(
      (c) =>
        idsEqual(c.localTerminalId, foundA.terminal.id) &&
        idsEqual(c.remoteWorkspaceId, wsB.id) &&
        idsEqual(c.remoteTerminalId, foundB.terminal.id)
    );
    if (existing) return { ok: true, connectionId: existing.id };

    const connId = newId();
    const edgeA: CrossWorkspaceConnection = {
      id: connId,
      localFloorId: foundA.floorId,
      localTerminalId: foundA.terminal.id,
      connectorNodeId: foundA.node.id,
      remoteWorkspaceId: wsB.id,
      remoteTerminalId: foundB.terminal.id,
    };
    const edgeB: CrossWorkspaceConnection = {
      id: connId,
      localFloorId: foundB.floorId,
      localTerminalId: foundB.terminal.id,
      connectorNodeId: foundB.node.id,
      remoteWorkspaceId: wsA.id,
      remoteTerminalId: foundA.terminal.id,
    };

    await this.commitWorkspace({
      ...wsA,
      crossWorkspaceConnections: [...wsA.crossWorkspaceConnections, edgeA],
    });
    const refreshedB = this.getWorkspace(wsB.id) ?? wsB;
    const alreadyB = refreshedB.crossWorkspaceConnections.some(
      (c) =>
        idsEqual(c.localTerminalId, foundB.terminal.id) &&
        idsEqual(c.remoteWorkspaceId, wsA.id) &&
        idsEqual(c.remoteTerminalId, foundA.terminal.id)
    );
    if (!alreadyB) {
      await this.commitWorkspace({
        ...refreshedB,
        crossWorkspaceConnections: [...refreshedB.crossWorkspaceConnections, edgeB],
      });
    }
    return { ok: true, connectionId: connId };
  }

  async createCableTie(workspaceId: string, tie: CableTie): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    this.pushUndo(ws, ws.activeFloorId);
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => ({
      ...lvl,
      cableTies: [...lvl.cableTies, tie],
    }));
    return this.commitWorkspace(updated);
  }

  async moveCableTie(
    workspaceId: string,
    tieId: string,
    position: Point
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => ({
      ...lvl,
      cableTies: lvl.cableTies.map((t) => (idsEqual(t.id, tieId) ? { ...t, position } : t)),
    }));
    return this.commitWorkspace(updated);
  }

  async deleteCableTie(workspaceId: string, tieId: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    this.pushUndo(ws, ws.activeFloorId);
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => ({
      ...lvl,
      cableTies: lvl.cableTies.filter((t) => !idsEqual(t.id, tieId)),
    }));
    return this.commitWorkspace(updated);
  }

  // Drawings & Groups
  async createDrawing(workspaceId: string, drawing: CanvasDrawing): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    this.pushUndo(ws, ws.activeFloorId);
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => ({
      ...lvl,
      drawings: [...lvl.drawings, drawing],
    }));
    return this.commitWorkspace(updated);
  }

  async deleteDrawing(workspaceId: string, drawingId: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    this.pushUndo(ws, ws.activeFloorId);
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => ({
      ...lvl,
      drawings: lvl.drawings.filter((d) => !idsEqual(d.id, drawingId)),
    }));
    return this.commitWorkspace(updated);
  }

  async groupNodes(workspaceId: string, nodeIds: string[]): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws || nodeIds.length < 2) return ws;
    this.pushUndo(ws, ws.activeFloorId);
    const groupId = newId();
    const set = new Set(nodeIds.map((id) => id.toLowerCase()));
    const group: NodeGroup = {
      id: groupId,
      name: 'Group',
      colorHex: null,
      createdAt: new Date().toISOString(),
    };
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => ({
      ...lvl,
      groups: [...lvl.groups, group],
      nodes: lvl.nodes.map((n) => (set.has(n.id.toLowerCase()) ? { ...n, groupId } : n)),
    }));
    return this.commitWorkspace(updated);
  }

  async ungroupNodes(workspaceId: string, nodeIds: string[]): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    this.pushUndo(ws, ws.activeFloorId);
    const set = new Set(nodeIds.map((id) => id.toLowerCase()));
    const updated = this.mapLevel(ws, ws.activeFloorId, (lvl) => {
      const nextNodes = lvl.nodes.map((n) =>
        set.has(n.id.toLowerCase()) ? { ...n, groupId: null } : n
      );
      const usedGroups = new Set(nextNodes.map((n) => n.groupId).filter(Boolean));
      return {
        ...lvl,
        nodes: nextNodes,
        groups: lvl.groups.filter((g) => usedGroups.has(g.id)),
      };
    });
    return this.commitWorkspace(updated);
  }

  // Bands (Agent Squads)
  async createBand(
    workspaceId: string,
    nodeIds: string[],
    name: string,
    floorId?: string | null,
    opts?: { icon?: string | null; color?: string | null }
  ): Promise<{ bandNode: CanvasNode; memberTerminalIds: string[] } | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws || nodeIds.length < 2) return null;
    const targetFloor = floorId === undefined ? ws.activeFloorId : floorId;
    const level = this.getLevelContents(ws, targetFloor);

    const terminalNodes = level.nodes.filter(
      (n) =>
        n.content.kind === 'terminal' &&
        (nodeIds.some((id) => idsEqual(id, n.id)) ||
          nodeIds.some((id) => idsEqual(id, (n.content as { kind: 'terminal'; terminal: TerminalData }).terminal.id)))
    );
    if (terminalNodes.length < 2) return null;

    this.pushUndo(ws, targetFloor);
    const minX = Math.min(...terminalNodes.map((n) => n.frame.x));
    const minY = Math.min(...terminalNodes.map((n) => n.frame.y));
    const now = new Date().toISOString();
    const bandId = newId();
    const memberNodeIds = terminalNodes.map((n) => n.id);
    const memberTerminalIds = terminalNodes.map(
      (n) => (n.content as { kind: 'terminal'; terminal: TerminalData }).terminal.id
    );

    const bandNode: CanvasNode = {
      id: bandId,
      frame: { x: minX, y: minY, width: DEFAULT_BAND_SIZE.width, height: DEFAULT_BAND_SIZE.height },
      zIndex: Math.max(...level.nodes.map((n) => n.zIndex), 0) + 1,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'band',
        band: {
          id: bandId,
          name: name.trim() || 'Squad',
          memberNodeIds,
          selectedMemberNodeId: memberNodeIds[0] ?? null,
          color: opts?.color ?? '#0a84ff',
          icon: opts?.icon ?? 'users',
          sidebarWidth: 190,
        },
      },
    };

    const updated = this.mapLevel(ws, targetFloor, (lvl) => ({
      ...lvl,
      nodes: [...lvl.nodes, bandNode],
    }));
    await this.commitWorkspace(updated);
    return { bandNode, memberTerminalIds };
  }

  async addTerminalToBand(
    workspaceId: string,
    bandNodeId: string,
    terminalNodeId: string
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, bandNodeId);
    if (!loc || loc.node.content.kind !== 'band') return null;

    this.pushUndo(ws, loc.floorId);
    const updated = this.mapLevel(ws, loc.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) => {
        if (!idsEqual(n.id, bandNodeId) || n.content.kind !== 'band') return n;
        const members = n.content.band.memberNodeIds.includes(terminalNodeId)
          ? n.content.band.memberNodeIds
          : [...n.content.band.memberNodeIds, terminalNodeId];
        return {
          ...n,
          content: {
            kind: 'band',
            band: {
              ...n.content.band,
              memberNodeIds: members,
              selectedMemberNodeId: n.content.band.selectedMemberNodeId ?? terminalNodeId,
            },
          },
        };
      }),
    }));
    return this.commitWorkspace(updated);
  }

  async selectBandMember(
    workspaceId: string,
    bandNodeId: string,
    memberNodeId: string
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, bandNodeId);
    if (!loc) return null;
    const updated = this.mapLevel(ws, loc.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) =>
        idsEqual(n.id, bandNodeId) && n.content.kind === 'band'
          ? {
              ...n,
              content: {
                kind: 'band',
                band: { ...n.content.band, selectedMemberNodeId: memberNodeId },
              },
            }
          : n
      ),
    }));
    return this.commitWorkspace(updated);
  }

  async removeBandMember(
    workspaceId: string,
    bandNodeId: string,
    memberNodeId: string
  ): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, bandNodeId);
    if (!loc || loc.node.content.kind !== 'band') return null;

    this.pushUndo(ws, loc.floorId);
    const nextMembers = loc.node.content.band.memberNodeIds.filter(
      (id) => !idsEqual(id, memberNodeId)
    );
    if (nextMembers.length <= 1) {
      return this.dissolveBand(workspaceId, bandNodeId);
    }
    const updated = this.mapLevel(ws, loc.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) =>
        idsEqual(n.id, bandNodeId) && n.content.kind === 'band'
          ? {
              ...n,
              content: {
                kind: 'band',
                band: {
                  ...n.content.band,
                  memberNodeIds: nextMembers,
                  selectedMemberNodeId:
                    idsEqual(n.content.band.selectedMemberNodeId, memberNodeId)
                      ? (nextMembers[0] ?? null)
                      : n.content.band.selectedMemberNodeId,
                },
              },
            }
          : n
      ),
    }));
    return this.commitWorkspace(updated);
  }

  async dissolveBand(workspaceId: string, bandNodeId: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, bandNodeId);
    if (!loc) return null;
    this.pushUndo(ws, loc.floorId);

    const updated = this.mapLevel(ws, loc.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.filter((n) => !idsEqual(n.id, bandNodeId)),
      connections: lvl.connections.filter(
        (c) => !idsEqual(c.terminalIdA, bandNodeId) && !idsEqual(c.terminalIdB, bandNodeId)
      ),
      noteConnections: lvl.noteConnections.filter((c) => !idsEqual(c.terminalId, bandNodeId)),
      portalConnections: lvl.portalConnections.filter((c) => !idsEqual(c.terminalId, bandNodeId)),
    }));
    return this.commitWorkspace(updated);
  }

  // Sticky Notes & Fichários
  availableNoteFileName(ws: Workspace, baseName: string): string {
    const clean = sanitizeFileName(baseName) || 'Untitled';
    const existing = new Set(
      this.allNodes(ws)
        .filter((n) => n.content.kind === 'stickyNote')
        .map((n) => (n.content as { kind: 'stickyNote'; stickyNote: StickyNoteData }).stickyNote.fileName.toLowerCase())
    );
    let candidate = `${clean}.md`;
    let idx = 2;
    while (existing.has(candidate.toLowerCase())) {
      candidate = `${clean} (${idx}).md`;
      idx += 1;
    }
    return candidate;
  }

  async createNoteAndConnect(
    workspaceId: string,
    callerTerminalId: string | null,
    content: string,
    explicitName: string | null,
    color?: NoteColor,
    stackName?: string | null
  ): Promise<{ node: CanvasNode; fileName: string; stackNode?: CanvasNode }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error('Workspace not found');

    const firstLine = content.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
    const derivedName = explicitName?.trim() || firstLine.replace(/^#+\s*/, '').slice(0, 48) || 'Untitled';
    const fileName = this.availableNoteFileName(ws, derivedName);
    const chosenColor = color ?? this.preferences.defaultNoteColor ?? 'yellow';

    const callerLoc = callerTerminalId ? this.findTerminal(ws, callerTerminalId) : null;
    const floorId = callerLoc?.floorId ?? ws.activeFloorId;
    const frame = this.placeNodeNear(
      ws,
      floorId,
      callerLoc?.node.frame ?? null,
      DEFAULT_NOTE_SIZE,
      'left'
    );

    const now = new Date().toISOString();
    const noteNode: CanvasNode = {
      id: newId(),
      frame,
      zIndex: 1,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'stickyNote',
        stickyNote: {
          fileName,
          customName: explicitName?.trim() || null,
          color: chosenColor,
          customColor: null,
          isContentLocked: false,
          fontFamily: null,
          text: content,
          storageMode: { kind: 'managed' },
        },
      },
    };

    await this.createNode(workspaceId, noteNode, floorId);
    if (callerTerminalId) {
      await this.connectNodes(workspaceId, callerTerminalId, noteNode.id);
    }

    let stackNode: CanvasNode | undefined;
    if (stackName) {
      stackNode = await this.fileNoteIntoStack(workspaceId, noteNode.id, stackName, floorId);
    }

    return { node: noteNode, fileName, stackNode };
  }

  async fileNoteIntoStack(
    workspaceId: string,
    noteNodeId: string,
    stackName?: string | null,
    floorId?: string | null
  ): Promise<CanvasNode> {
    const ws = this.getWorkspace(workspaceId)!;
    const loc = this.findNodeLocation(ws, noteNodeId)!;
    const targetFloor = floorId === undefined ? loc.floorId : floorId;
    const level = this.getLevelContents(ws, targetFloor);

    let stack = stackName
      ? level.nodes.find(
          (n) =>
            n.content.kind === 'noteStack' &&
            n.content.noteStack.name.toLowerCase() === stackName.toLowerCase()
        )
      : undefined;

    if (!stack) {
      const now = new Date().toISOString();
      const noteColor =
        loc.node.content.kind === 'stickyNote' ? loc.node.content.stickyNote.color : 'yellow';
      const newStack: CanvasNode = {
        id: newId(),
        frame: {
          x: loc.node.frame.x,
          y: loc.node.frame.y,
          width: DEFAULT_FICHARIO_SIZE.width,
          height: DEFAULT_FICHARIO_SIZE.height,
        },
        zIndex: loc.node.zIndex + 1,
        groupId: null,
        createdAt: now,
        lastModifiedAt: now,
        content: {
          kind: 'noteStack',
          noteStack: {
            id: newId(),
            name: stackName?.trim() || 'Fichário',
            hasCustomName: Boolean(stackName?.trim()),
            memberNodeIds: [noteNodeId],
            frontNoteId: noteNodeId,
            uniformColor: false,
            color: noteColor,
          },
        },
      };
      // Promote note connections onto the stack so connected agents see the fichário
      const updated = this.mapLevel(ws, targetFloor, (lvl) => ({
        ...lvl,
        nodes: [...lvl.nodes, newStack],
        noteConnections: lvl.noteConnections.map((c) =>
          idsEqual(c.noteNodeId, noteNodeId) ? { ...c, noteNodeId: newStack.id } : c
        ),
      }));
      await this.commitWorkspace(updated);
      return newStack;
    }

    const updated = this.mapLevel(ws, targetFloor, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) => {
        if (!idsEqual(n.id, stack!.id) || n.content.kind !== 'noteStack') return n;
        const members = n.content.noteStack.memberNodeIds.includes(noteNodeId)
          ? n.content.noteStack.memberNodeIds
          : [...n.content.noteStack.memberNodeIds, noteNodeId];
        return {
          ...n,
          content: {
            kind: 'noteStack',
            noteStack: {
              ...n.content.noteStack,
              memberNodeIds: members,
              frontNoteId: noteNodeId,
            },
          },
        };
      }),
    }));
    await this.commitWorkspace(updated);
    return this.findNodeLocation(updated, stack.id)!.node;
  }

  async unstackNote(workspaceId: string, noteNodeId: string): Promise<Workspace | null> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return null;
    const loc = this.findNodeLocation(ws, noteNodeId);
    if (!loc) return null;

    const updated = this.mapLevel(ws, loc.floorId, (lvl) => {
      const nextNodes: CanvasNode[] = [];
      for (const n of lvl.nodes) {
        if (n.content.kind === 'noteStack' && n.content.noteStack.memberNodeIds.includes(noteNodeId)) {
          const remaining = n.content.noteStack.memberNodeIds.filter(
            (id) => !idsEqual(id, noteNodeId)
          );
          if (remaining.length === 0) continue; // dissolve empty stack
          nextNodes.push({
            ...n,
            content: {
              kind: 'noteStack',
              noteStack: {
                ...n.content.noteStack,
                memberNodeIds: remaining,
                frontNoteId: idsEqual(n.content.noteStack.frontNoteId, noteNodeId)
                  ? (remaining[0] ?? null)
                  : n.content.noteStack.frontNoteId,
              },
            },
          });
        } else {
          nextNodes.push(n);
        }
      }
      return { ...lvl, nodes: nextNodes };
    });
    return this.commitWorkspace(updated);
  }

  async updateNoteText(
    workspaceId: string,
    nodeId: string,
    text: string
  ): Promise<{ workspace: Workspace | null; renamedTo?: string }> {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { workspace: null };
    const loc = this.findNodeLocation(ws, nodeId);
    if (!loc || loc.node.content.kind !== 'stickyNote') return { workspace: null };

    const sn = loc.node.content.stickyNote;
    if (sn.isContentLocked) throw new Error('Note is locked');

    let nextFileName = sn.fileName;
    let renamedTo: string | undefined;

    if (!sn.customName && sn.storageMode.kind === 'managed') {
      const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
      const candidateTitle = firstLine.replace(/^#+\s*/, '').slice(0, 48);
      if (candidateTitle && candidateTitle !== displayNameForNoteFile(sn.fileName)) {
        const nextName = this.availableNoteFileName(ws, candidateTitle);
        const oldPath = path.join(this.notesDir(workspaceId), sn.fileName);
        const newPath = path.join(this.notesDir(workspaceId), nextName);
        await fsp.rename(oldPath, newPath).catch(() => undefined);
        nextFileName = nextName;
        renamedTo = displayNameForNoteFile(nextName);
      }
    }

    if (sn.storageMode.kind === 'external' && sn.storageMode.originalPath) {
      await fsp.writeFile(sn.storageMode.originalPath, text, 'utf8');
    } else {
      await this.writeNoteFile(workspaceId, nextFileName, text);
    }

    const updated = this.mapLevel(ws, loc.floorId, (lvl) => ({
      ...lvl,
      nodes: lvl.nodes.map((n) =>
        idsEqual(n.id, nodeId) && n.content.kind === 'stickyNote'
          ? {
              ...n,
              lastModifiedAt: new Date().toISOString(),
              content: {
                kind: 'stickyNote',
                stickyNote: { ...n.content.stickyNote, fileName: nextFileName, text },
              },
            }
          : n
      ),
    }));
    await this.commitWorkspace(updated);
    return { workspace: updated, renamedTo };
  }

  // Roles & Partituras & Presets
  listRoles(workspaceId?: string | null): RolePreset[] {
    return this.roles.filter(
      (r) => r.scope === 'global' || (workspaceId && idsEqual(r.workspaceId, workspaceId))
    );
  }

  getRole(idOrName: string, workspaceId?: string | null): RolePreset | null {
    const visible = this.listRoles(workspaceId);
    return (
      visible.find((r) => idsEqual(r.id, idOrName)) ??
      visible.find((r) => r.name.toLowerCase() === idOrName.toLowerCase()) ??
      null
    );
  }

  async createRole(input: {
    name: string;
    prompt: string;
    scope: 'current' | 'global';
    workspaceId: string | null;
    icon?: string | null;
    color?: string | null;
  }): Promise<RolePreset> {
    const role: RolePreset = {
      id: newId(),
      name: input.name.trim(),
      prompt: input.prompt,
      scope: input.scope,
      workspaceId: input.scope === 'global' ? null : input.workspaceId,
      icon: input.icon ?? 'badge-check',
      color: input.color ?? '#0a84ff',
      createdAt: new Date().toISOString(),
    };
    this.roles.push(role);
    await this.persistRoles();
    for (const cb of this.roleListeners) cb();
    return role;
  }

  async updateRole(id: string, patch: Partial<RolePreset>): Promise<RolePreset | null> {
    const idx = this.roles.findIndex((r) => idsEqual(r.id, id));
    if (idx === -1) return null;
    this.roles[idx] = { ...this.roles[idx], ...patch };
    await this.persistRoles();
    for (const cb of this.roleListeners) cb();
    return this.roles[idx];
  }

  async deleteRole(id: string): Promise<boolean> {
    const before = this.roles.length;
    this.roles = this.roles.filter((r) => !idsEqual(r.id, id));
    if (this.roles.length === before) return false;
    await this.persistRoles();
    for (const cb of this.roleListeners) cb();
    return true;
  }

  listPartituras(workspaceId?: string | null): Partitura[] {
    return this.partituras.filter(
      (p) => !p.workspaceId || (workspaceId && idsEqual(p.workspaceId, workspaceId))
    );
  }

  async savePartitura(p: Omit<Partitura, 'id' | 'createdAt'> & { id?: string }): Promise<Partitura> {
    const now = new Date().toISOString();
    const existingIdx = p.id ? this.partituras.findIndex((x) => idsEqual(x.id, p.id)) : -1;
    const saved: Partitura = {
      ...structuredClone(p),
      id: p.id || newId(),
      createdAt: existingIdx >= 0 ? this.partituras[existingIdx].createdAt : now,
    };
    if (existingIdx >= 0) {
      this.partituras[existingIdx] = saved;
    } else {
      this.partituras.push(saved);
    }
    await this.persistPartituras();
    for (const cb of this.partituraListeners) cb();
    return saved;
  }

  async deletePartitura(id: string): Promise<boolean> {
    const before = this.partituras.length;
    this.partituras = this.partituras.filter((p) => !idsEqual(p.id, id));
    if (this.partituras.length === before) return false;
    await this.persistPartituras();
    for (const cb of this.partituraListeners) cb();
    return true;
  }

  listSavedPrompts(): SavedPrompt[] {
    return [...this.savedPrompts];
  }

  async savePrompt(input: {
    id?: string;
    title: string;
    prompt: string;
    tags?: string[];
  }): Promise<SavedPrompt> {
    const now = new Date().toISOString();
    const existingIdx = input.id ? this.savedPrompts.findIndex((p) => idsEqual(p.id, input.id)) : -1;
    const saved: SavedPrompt = {
      id: existingIdx >= 0 ? this.savedPrompts[existingIdx].id : newId(),
      title: input.title.trim() || 'Untitled Prompt',
      prompt: input.prompt,
      tags: input.tags ?? [],
      createdAt: existingIdx >= 0 ? this.savedPrompts[existingIdx].createdAt : now,
      updatedAt: now,
    };
    if (existingIdx >= 0) {
      this.savedPrompts[existingIdx] = saved;
    } else {
      this.savedPrompts.unshift(saved);
    }
    await this.persistSavedPrompts();
    for (const cb of this.savedPromptsListeners) cb();
    return saved;
  }

  async deleteSavedPrompt(id: string): Promise<boolean> {
    const before = this.savedPrompts.length;
    this.savedPrompts = this.savedPrompts.filter((p) => !idsEqual(p.id, id));
    if (this.savedPrompts.length === before) return false;
    await this.persistSavedPrompts();
    for (const cb of this.savedPromptsListeners) cb();
    return true;
  }

  // Node/Terminal Lookup Helpers
  allNodes(ws: Workspace): CanvasNode[] {
    return [...ws.nodes, ...ws.floors.flatMap((f) => f.nodes)];
  }

  findNodeLocation(
    ws: Workspace,
    nodeId: string
  ): { node: CanvasNode; floorId: string | null } | null {
    const groundNode = ws.nodes.find((n) => idsEqual(n.id, nodeId));
    if (groundNode) return { node: groundNode, floorId: null };
    for (const f of ws.floors) {
      const fn = f.nodes.find((n) => idsEqual(n.id, nodeId));
      if (fn) return { node: fn, floorId: f.id };
    }
    return null;
  }

  findTerminal(
    ws: Workspace,
    terminalIdOrNodeId: string
  ): { node: CanvasNode; terminal: TerminalData; floorId: string | null } | null {
    for (const n of ws.nodes) {
      if (
        n.content.kind === 'terminal' &&
        (idsEqual(n.id, terminalIdOrNodeId) || idsEqual(n.content.terminal.id, terminalIdOrNodeId))
      ) {
        return { node: n, terminal: n.content.terminal, floorId: null };
      }
    }
    for (const f of ws.floors) {
      for (const n of f.nodes) {
        if (
          n.content.kind === 'terminal' &&
          (idsEqual(n.id, terminalIdOrNodeId) ||
            idsEqual(n.content.terminal.id, terminalIdOrNodeId))
        ) {
          return { node: n, terminal: n.content.terminal, floorId: f.id };
        }
      }
    }
    return null;
  }

  findNodeOrTerminal(
    ws: Workspace,
    id: string
  ): { node: CanvasNode; floorId: string | null } | null {
    const byNode = this.findNodeLocation(ws, id);
    if (byNode) return byNode;
    const byTerm = this.findTerminal(ws, id);
    if (byTerm) return { node: byTerm.node, floorId: byTerm.floorId };
    return null;
  }

  findWorkspaceForTerminal(terminalId: string): { workspace: Workspace; terminal: TerminalData; node: CanvasNode; floorId: string | null } | null {
    for (const ws of this.workspaces.values()) {
      const found = this.findTerminal(ws, terminalId);
      if (found) return { workspace: ws, ...found };
    }
    return null;
  }

  // Team Graph & Reachability
  private buildBandExpansion(ws: Workspace): {
    bandsById: Map<string, { node: CanvasNode; band: BandData; memberTermIds: string[]; floorId: string | null }>;
    termToBands: Map<string, string[]>;
  } {
    const bandsById = new Map<
      string,
      { node: CanvasNode; band: BandData; memberTermIds: string[]; floorId: string | null }
    >();
    const termToBands = new Map<string, string[]>();

    const scan = (nodes: CanvasNode[], floorId: string | null) => {
      for (const n of nodes) {
        if (n.content.kind !== 'band') continue;
        const memberTermIds = n.content.band.memberNodeIds.flatMap((mid) => {
          const t = this.findTerminal(ws, mid);
          return t ? [t.terminal.id] : [];
        });
        bandsById.set(n.id, { node: n, band: n.content.band, memberTermIds, floorId });
        for (const tid of memberTermIds) {
          const list = termToBands.get(tid) ?? [];
          list.push(n.id);
          termToBands.set(tid, list);
        }
      }
    };

    scan(ws.nodes, null);
    for (const f of ws.floors) scan(f.nodes, f.id);
    return { bandsById, termToBands };
  }

  getConnectedTerminalIds(ws: Workspace, callerTerminalId: string): Set<string> {
    const { bandsById, termToBands } = this.buildBandExpansion(ws);
    const expandEndpoint = (id: string): string[] => {
      const band = bandsById.get(id);
      if (band) return band.memberTermIds;
      const t = this.findTerminal(ws, id);
      return t ? [t.terminal.id] : [id];
    };

    const peers = new Set<string>();
    const callerBands = termToBands.get(callerTerminalId) ?? [];
    for (const bid of callerBands) {
      const b = bandsById.get(bid);
      if (b) {
        for (const tid of b.memberTermIds) {
          if (!idsEqual(tid, callerTerminalId)) peers.add(tid);
        }
      }
    }

    const levels = [ws, ...ws.floors];
    for (const lvl of levels) {
      for (const conn of lvl.connections) {
        const sideA = expandEndpoint(conn.terminalIdA);
        const sideB = expandEndpoint(conn.terminalIdB);
        const callerInA = sideA.some((id) => idsEqual(id, callerTerminalId));
        const callerInB = sideB.some((id) => idsEqual(id, callerTerminalId));
        if (callerInA) {
          for (const tid of sideB) {
            if (!idsEqual(tid, callerTerminalId)) peers.add(tid);
          }
        }
        if (callerInB) {
          for (const tid of sideA) {
            if (!idsEqual(tid, callerTerminalId)) peers.add(tid);
          }
        }
      }
    }

    for (const cf of ws.crossFloorConnections) {
      if (idsEqual(cf.terminalIdA, callerTerminalId)) peers.add(cf.terminalIdB);
      if (idsEqual(cf.terminalIdB, callerTerminalId)) peers.add(cf.terminalIdA);
    }

    return peers;
  }

  getReachableNotes(ws: Workspace, terminalId: string): ReachableNoteInfo[] {
    const { termToBands } = this.buildBandExpansion(ws);
    const holderIds = new Set<string>([terminalId, ...(termToBands.get(terminalId) ?? [])]);
    const levels = [ws, ...ws.floors];
    const allNodes = this.allNodes(ws);
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));

    // BFS over noteConnections -> noteStacks -> noteToNoteConnections
    const visited = new Map<string, number>();
    const queue: Array<{ nodeId: string; depth: number }> = [];

    for (const lvl of levels) {
      for (const nc of lvl.noteConnections) {
        if (holderIds.has(nc.terminalId)) {
          if (!visited.has(nc.noteNodeId)) {
            visited.set(nc.noteNodeId, 0);
            queue.push({ nodeId: nc.noteNodeId, depth: 0 });
          }
        }
      }
    }

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curNode = nodeById.get(cur.nodeId);
      if (!curNode) continue;

      if (curNode.content.kind === 'noteStack') {
        for (const memberId of curNode.content.noteStack.memberNodeIds) {
          if (!visited.has(memberId)) {
            visited.set(memberId, cur.depth);
            queue.push({ nodeId: memberId, depth: cur.depth });
          }
        }
      }

      for (const lvl of levels) {
        for (const n2n of lvl.noteToNoteConnections) {
          if (idsEqual(n2n.noteNodeIdA, cur.nodeId) && !visited.has(n2n.noteNodeIdB)) {
            visited.set(n2n.noteNodeIdB, cur.depth + 1);
            queue.push({ nodeId: n2n.noteNodeIdB, depth: cur.depth + 1 });
          }
          if (idsEqual(n2n.noteNodeIdB, cur.nodeId) && !visited.has(n2n.noteNodeIdA)) {
            visited.set(n2n.noteNodeIdA, cur.depth + 1);
            queue.push({ nodeId: n2n.noteNodeIdA, depth: cur.depth + 1 });
          }
        }
      }
    }

    const result: ReachableNoteInfo[] = [];
    const stackByMember = new Map<string, string>();
    for (const n of allNodes) {
      if (n.content.kind === 'noteStack') {
        for (const m of n.content.noteStack.memberNodeIds) {
          stackByMember.set(m, n.content.noteStack.name);
        }
      }
    }

    for (const [nid, depth] of visited.entries()) {
      const node = nodeById.get(nid);
      if (node && node.content.kind === 'stickyNote') {
        result.push({
          id: node.id,
          name: node.content.stickyNote.customName || displayNameForNoteFile(node.content.stickyNote.fileName),
          locked: node.content.stickyNote.isContentLocked,
          depth,
          fichario: stackByMember.get(node.id) ?? null,
        });
      }
    }
    return result;
  }

  getReachablePortals(ws: Workspace, terminalId: string): ReachablePortalInfo[] {
    const { termToBands } = this.buildBandExpansion(ws);
    const holderIds = new Set<string>([terminalId, ...(termToBands.get(terminalId) ?? [])]);
    const levels = [ws, ...ws.floors];
    const allNodes = this.allNodes(ws);
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));
    const visited = new Set<string>();
    const queue: string[] = [];

    for (const lvl of levels) {
      for (const pc of lvl.portalConnections) {
        if (holderIds.has(pc.terminalId) && !visited.has(pc.portalNodeId)) {
          visited.add(pc.portalNodeId);
          queue.push(pc.portalNodeId);
        }
      }
    }

    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const lvl of levels) {
        for (const p2p of lvl.portalToPortalConnections) {
          if (idsEqual(p2p.portalNodeIdA, cur) && !visited.has(p2p.portalNodeIdB)) {
            visited.add(p2p.portalNodeIdB);
            queue.push(p2p.portalNodeIdB);
          }
          if (idsEqual(p2p.portalNodeIdB, cur) && !visited.has(p2p.portalNodeIdA)) {
            visited.add(p2p.portalNodeIdA);
            queue.push(p2p.portalNodeIdA);
          }
        }
      }
    }

    const res: ReachablePortalInfo[] = [];
    for (const pid of visited) {
      const node = nodeById.get(pid);
      if (node && node.content.kind === 'portal') {
        res.push({
          id: node.id,
          name: node.content.portal.name || 'Portal',
          summary: node.content.portal.url || 'about:blank',
        });
      }
    }
    return res;
  }

  buildReachableList(
    ws: Workspace,
    callerTerminalId: string,
    isRunningFn: (termId: string) => boolean
  ): ReachableListResponse {
    const caller = this.findTerminal(ws, callerTerminalId);
    const callerFloorName = caller?.floorId
      ? (ws.floors.find((f) => idsEqual(f.id, caller.floorId))?.name ?? null)
      : null;

    const peerIds = this.getConnectedTerminalIds(ws, callerTerminalId);
    const isManager = caller?.terminal.isManager ?? false;
    const { bandsById } = this.buildBandExpansion(ws);

    const terminals: ReachableTerminalInfo[] = [];
    for (const tid of peerIds) {
      const found = this.findTerminal(ws, tid);
      if (!found) continue;
      const floorName = found.floorId
        ? (ws.floors.find((f) => idsEqual(f.id, found.floorId))?.name ?? null)
        : null;
      const entry: ReachableTerminalInfo = {
        id: found.terminal.id,
        nodeId: found.node.id,
        name: found.terminal.name,
        agentType: found.terminal.agentType,
        role: found.terminal.roleName,
        isManager: found.terminal.isManager,
        running: isRunningFn(found.terminal.id),
        floorId: found.floorId,
        floorName,
        accountName: found.terminal.accountName,
      };
      if (isManager) {
        const subPeers = [...this.getConnectedTerminalIds(ws, found.terminal.id)]
          .map((pid) => this.findTerminal(ws, pid)?.terminal.name)
          .filter((x): x is string => Boolean(x));
        const subNotes = this.getReachableNotes(ws, found.terminal.id).map((n) => ({
          name: n.name,
          locked: n.locked,
          depth: n.depth,
          fichario: Boolean(n.fichario),
        }));
        const subPortals = this.getReachablePortals(ws, found.terminal.id).map((p) => ({
          name: p.name,
          summary: p.summary,
        }));
        entry.team = { peers: subPeers, portals: subPortals, notes: subNotes };
      }
      terminals.push(entry);
    }

    // Direct notes + Maestro reach into teammate notes
    const directNotes = this.getReachableNotes(ws, callerTerminalId);
    const noteMap = new Map(directNotes.map((n) => [n.id, n]));
    if (isManager) {
      for (const tid of peerIds) {
        for (const n of this.getReachableNotes(ws, tid)) {
          if (!noteMap.has(n.id)) noteMap.set(n.id, n);
        }
      }
    }

    const directPortals = this.getReachablePortals(ws, callerTerminalId);
    const portalMap = new Map(directPortals.map((p) => [p.id, p]));
    if (isManager) {
      for (const tid of peerIds) {
        for (const p of this.getReachablePortals(ws, tid)) {
          if (!portalMap.has(p.id)) portalMap.set(p.id, p);
        }
      }
    }

    const reachableNoteIds = new Set(noteMap.keys());
    const noteStacks: ReachableListResponse['noteStacks'] = [];
    for (const lvl of [
      { floorId: null as string | null, nodes: ws.nodes },
      ...ws.floors.map((f) => ({ floorId: f.id, nodes: f.nodes })),
    ]) {
      for (const n of lvl.nodes) {
        if (
          n.content.kind === 'noteStack' &&
          n.content.noteStack.memberNodeIds.some((mid) => reachableNoteIds.has(mid))
        ) {
          noteStacks.push({
            id: n.id,
            name: n.content.noteStack.name,
            memberNodeIds: [...n.content.noteStack.memberNodeIds],
            floorId: lvl.floorId,
          });
        }
      }
    }

    const bands: ReachableListResponse['bands'] = [];
    for (const [bid, b] of bandsById.entries()) {
      const withCaller = b.memberTermIds.some((id) => idsEqual(id, callerTerminalId));
      const connectedToCaller = b.memberTermIds.some((id) => peerIds.has(id));
      if (withCaller || connectedToCaller) {
        bands.push({
          id: bid,
          name: b.band.name,
          withCaller,
          memberIds: b.memberTermIds,
        });
      }
    }

    const farPeers: ReachableTerminalInfo[] = [];
    for (const cw of ws.crossWorkspaceConnections) {
      if (!idsEqual(cw.localTerminalId, callerTerminalId)) continue;
      const remoteWs = this.getWorkspace(cw.remoteWorkspaceId);
      if (!remoteWs) continue;
      const remoteFound = this.findTerminal(remoteWs, cw.remoteTerminalId);
      if (!remoteFound) continue;
      const remoteFloorName = remoteFound.floorId
        ? (remoteWs.floors.find((f) => idsEqual(f.id, remoteFound.floorId))?.name ?? null)
        : null;
      farPeers.push({
        id: remoteFound.terminal.id,
        nodeId: remoteFound.node.id,
        name: remoteFound.terminal.name,
        agentType: remoteFound.terminal.agentType,
        role: remoteFound.terminal.roleName,
        isManager: remoteFound.terminal.isManager,
        running: isRunningFn(remoteFound.terminal.id),
        floorId: remoteFound.floorId,
        floorName: remoteFloorName,
        workspaceId: remoteWs.id,
        workspaceName: remoteWs.name,
        farAddress: `${remoteFound.terminal.name} @ ${remoteWs.name}`,
        accountName: remoteFound.terminal.accountName,
      });
    }

    return {
      self: {
        id: callerTerminalId,
        name: caller?.terminal.name ?? 'Terminal',
        isManager,
        workspaceId: ws.id,
        workspaceName: ws.name,
        floorId: caller?.floorId ?? null,
        floorName: callerFloorName,
      },
      terminals,
      farPeers,
      notes: [...noteMap.values()],
      portals: [...portalMap.values()],
      noteStacks,
      bands,
    };
  }

  resolveTargetTerminal(
    ws: Workspace,
    callerTerminalId: string,
    targetName: string
  ): {
    terminalId: string;
    nodeId: string;
    terminal: TerminalData;
    workspaceId: string;
    workspaceName: string;
    reachable: boolean;
  } | null {
    const clean = targetName.trim();
    const atIdx = clean.lastIndexOf('@');
    if (atIdx > 0 && atIdx < clean.length - 1) {
      const leftName = clean.slice(0, atIdx).trim();
      const scopeName = clean.slice(atIdx + 1).trim();

      // Try matching another (or same) workspace by ID or name
      const remoteWs = [...this.workspaces.values()].find(
        (w) => idsEqual(w.id, scopeName) || w.name.toLowerCase() === scopeName.toLowerCase()
      );
      if (remoteWs) {
        const remoteMatches: Array<{ node: CanvasNode; terminal: TerminalData }> = [];
        for (const n of this.allNodes(remoteWs)) {
          if (n.content.kind === 'terminal') {
            const t = n.content.terminal;
            if (
              idsEqual(t.id, leftName) ||
              idsEqual(n.id, leftName) ||
              t.name.toLowerCase() === leftName.toLowerCase()
            ) {
              remoteMatches.push({ node: n, terminal: t });
            }
          }
        }
        if (remoteMatches.length > 0) {
          const picked = remoteMatches[0];
          const isSameWs = idsEqual(remoteWs.id, ws.id);
          const localPeers = isSameWs ? this.getConnectedTerminalIds(ws, callerTerminalId) : null;
          const reachable = isSameWs
            ? idsEqual(picked.terminal.id, callerTerminalId) || localPeers!.has(picked.terminal.id)
            : ws.crossWorkspaceConnections.some(
                (cw) =>
                  idsEqual(cw.localTerminalId, callerTerminalId) &&
                  idsEqual(cw.remoteWorkspaceId, remoteWs.id) &&
                  idsEqual(cw.remoteTerminalId, picked.terminal.id)
              );
          return {
            terminalId: picked.terminal.id,
            nodeId: picked.node.id,
            terminal: picked.terminal,
            workspaceId: remoteWs.id,
            workspaceName: remoteWs.name,
            reachable,
          };
        }
      }

      // Fallback: Name @ FloorName inside current workspace
      const peers = this.getConnectedTerminalIds(ws, callerTerminalId);
      const targetFloor =
        scopeName.toLowerCase() === 'ground'
          ? null
          : ws.floors.find(
              (f) => idsEqual(f.id, scopeName) || f.name.toLowerCase() === scopeName.toLowerCase()
            );
      if (targetFloor !== undefined) {
        const lvl = this.getLevelContents(ws, targetFloor ? targetFloor.id : null);
        const floorMatch = lvl.nodes.find(
          (n): n is CanvasNode & { content: { kind: 'terminal'; terminal: TerminalData } } =>
            n.content.kind === 'terminal' &&
            (idsEqual(n.content.terminal.id, leftName) ||
              idsEqual(n.id, leftName) ||
              n.content.terminal.name.toLowerCase() === leftName.toLowerCase())
        );
        if (floorMatch) {
          return {
            terminalId: floorMatch.content.terminal.id,
            nodeId: floorMatch.id,
            terminal: floorMatch.content.terminal,
            workspaceId: ws.id,
            workspaceName: ws.name,
            reachable:
              idsEqual(floorMatch.content.terminal.id, callerTerminalId) ||
              peers.has(floorMatch.content.terminal.id),
          };
        }
      }
    }

    const peers = this.getConnectedTerminalIds(ws, callerTerminalId);
    const allTerminals: Array<{ node: CanvasNode; terminal: TerminalData }> = [];

    for (const n of this.allNodes(ws)) {
      if (n.content.kind === 'terminal') {
        allTerminals.push({ node: n, terminal: n.content.terminal });
      }
    }

    const matches = allTerminals.filter(
      (t) =>
        idsEqual(t.terminal.id, clean) ||
        idsEqual(t.node.id, clean) ||
        t.terminal.name.toLowerCase() === clean.toLowerCase()
    );
    if (matches.length === 0) return null;

    const reachableMatch = matches.find(
      (m) => idsEqual(m.terminal.id, callerTerminalId) || peers.has(m.terminal.id)
    );
    const picked = reachableMatch ?? matches[0];
    return {
      terminalId: picked.terminal.id,
      nodeId: picked.node.id,
      terminal: picked.terminal,
      workspaceId: ws.id,
      workspaceName: ws.name,
      reachable: idsEqual(picked.terminal.id, callerTerminalId) || peers.has(picked.terminal.id),
    };
  }

  resolveTargetNote(
    ws: Workspace,
    callerTerminalId: string,
    noteName: string
  ): { node: CanvasNode; stickyNote: StickyNoteData; accessible: boolean } | null {
    const clean = noteName.trim().toLowerCase();
    const caller = this.findTerminal(ws, callerTerminalId);
    const isManager = caller?.terminal.isManager ?? false;
    const accessibleIds = new Set(
      this.getReachableNotes(ws, callerTerminalId).map((n) => n.id.toLowerCase())
    );
    if (isManager) {
      for (const peerId of this.getConnectedTerminalIds(ws, callerTerminalId)) {
        for (const n of this.getReachableNotes(ws, peerId)) {
          accessibleIds.add(n.id.toLowerCase());
        }
      }
    }

    const noteNodes = this.allNodes(ws).filter((n) => n.content.kind === 'stickyNote');
    const matched = noteNodes.find((n) => {
      const sn = (n.content as { kind: 'stickyNote'; stickyNote: StickyNoteData }).stickyNote;
      const disp = (sn.customName || displayNameForNoteFile(sn.fileName)).toLowerCase();
      return (
        idsEqual(n.id, noteName) ||
        disp === clean ||
        sn.fileName.toLowerCase() === clean ||
        sn.fileName.toLowerCase() === `${clean}.md`
      );
    });
    if (!matched || matched.content.kind !== 'stickyNote') return null;
    return {
      node: matched,
      stickyNote: matched.content.stickyNote,
      accessible: accessibleIds.has(matched.id.toLowerCase()),
    };
  }

  pickNextNodeColor(): NoteColor {
    return STICKY_COLORS[Math.floor(Math.random() * 6)] ?? 'yellow';
  }
}
