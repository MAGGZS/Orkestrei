import type {
  AgentUsageProviderId,
  AgentUsageSnapshot,
  AppState,
  AskInFlight,
  CableTie,
  CanvasDrawing,
  CanvasNode,
  ChatEntry,
  ChatThreadColor,
  ChatThreadsState,
  Floor,
  FloorLandingPreview,
  FloorStatus,
  NoteColor,
  Partitura,
  Point,
  Preferences,
  ReachableListResponse,
  Rect,
  RolePreset,
  Routine,
  RoutineHistoryEntry,
  RoutineSchedule,
  SavedPrompt,
  SidebarLayout,
  TerminalActivityState,
  TerminalData,
  TerminalInspectInfo,
  TokenUsageMap,
  TransferActiveEvent,
  Workspace,
} from '../shared/types';

export interface MaestriBridge {
  app: {
    info: () => Promise<{
      name: string;
      version: string;
      platform: string;
      orchestratorUrl: string;
      orchestratorPort: number;
      dataDir: string;
      homeDir: string;
    }>;
    pickDirectory: () => Promise<string | null>;
    openExternal: (url: string) => Promise<void>;
    openPath: (p: string) => Promise<string>;
    onNotification: (cb: (n: { title: string; body: string }) => void) => () => void;
  };
  windowControls: {
    state: () => Promise<{ maximized: boolean; minimized: boolean }>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    onChanged: (cb: (state: { maximized: boolean; minimized: boolean }) => void) => () => void;
  };
  appState: {
    get: () => Promise<AppState>;
    update: (patch: Partial<AppState>) => Promise<AppState>;
  };
  preferences: {
    get: () => Promise<Preferences>;
    set: (patch: Partial<Preferences>) => Promise<Preferences>;
    onChanged: (cb: (prefs: Preferences) => void) => () => void;
  };
  sidebarLayout: {
    get: () => Promise<SidebarLayout>;
    set: (layout: SidebarLayout) => Promise<SidebarLayout>;
    onChanged: (cb: (layout: SidebarLayout) => void) => () => void;
  };
  workspace: {
    list: () => Promise<Workspace[]>;
    getActiveId: () => Promise<string | null>;
    switch: (id: string) => Promise<Workspace | null>;
    create: (input: {
      name: string;
      workingDirectory: string;
      color?: string | null;
      icon?: string | null;
      fromWorkspaceId?: string | null;
    }) => Promise<Workspace>;
    patch: (id: string, patch: Partial<Workspace>) => Promise<Workspace | null>;
    delete: (id: string) => Promise<void>;
    undo: (id: string) => Promise<boolean>;
    redo: (id: string) => Promise<boolean>;
    beginUndoGroup: () => Promise<void>;
    endUndoGroup: () => Promise<void>;
    onChanged: (cb: (ws: Workspace) => void) => () => void;
    onDeleted: (cb: (id: string) => void) => () => void;
    onActiveChanged: (cb: (id: string | null) => void) => () => void;
  };
  floor: {
    create: (
      workspaceId: string,
      input: {
        name: string;
        branchName?: string;
        existingBranch?: boolean;
        noGit?: boolean;
        copyGround?: boolean;
      }
    ) => Promise<{ ok: true; floor: Floor } | { ok: false; error: string }>;
    switch: (
      workspaceId: string,
      floorId: string | null,
      cam?: { origin: Point; zoom: number } | null
    ) => Promise<Workspace | null>;
    setStatus: (
      workspaceId: string,
      floorId: string | null,
      status: FloorStatus | null
    ) => Promise<Workspace | null>;
    rename: (workspaceId: string, floorId: string, name: string) => Promise<Workspace | null>;
    landingPreview: (
      workspaceId: string,
      floorId: string,
      targetBranch?: string
    ) => Promise<FloorLandingPreview | null>;
    land: (
      workspaceId: string,
      floorId: string,
      opts?: { intoBranch?: string; deleteBranch?: boolean; keepFloor?: boolean }
    ) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
    delete: (
      workspaceId: string,
      floorId: string
    ) => Promise<{ removedNodeIds: string[]; removedTerminalIds: string[] }>;
  };
  floorHooks: {
    run: (
      workspaceId: string,
      floorId: string | null,
      phase: 'setup' | 'run' | 'teardown'
    ) => Promise<{
      ok: boolean;
      results: Array<{ id: string; label: string; command: string; ok: boolean; output: string }>;
    }>;
  };
  node: {
    create: (
      workspaceId: string,
      node: CanvasNode,
      floorId?: string | null
    ) => Promise<CanvasNode | null>;
    duplicate: (workspaceId: string, nodeId: string) => Promise<CanvasNode | null>;
    moveToFloor: (
      workspaceId: string,
      nodeId: string,
      targetFloorId: string | null
    ) => Promise<Workspace | null>;
    setRedacted: (
      workspaceId: string,
      nodeId: string,
      isRedacted: boolean
    ) => Promise<Workspace | null>;
    patch: (workspaceId: string, nodeId: string, patch: Partial<CanvasNode>) => Promise<Workspace | null>;
    patchFrames: (
      workspaceId: string,
      patches: Array<{ nodeId: string; frame: Partial<Rect> }>
    ) => Promise<Workspace | null>;
    deleteMany: (workspaceId: string, nodeIds: string[]) => Promise<Workspace | null>;
  };
  group: {
    create: (workspaceId: string, nodeIds: string[]) => Promise<Workspace | null>;
    ungroup: (workspaceId: string, nodeIds: string[]) => Promise<Workspace | null>;
  };
  drawing: {
    create: (workspaceId: string, drawing: CanvasDrawing) => Promise<Workspace | null>;
    delete: (workspaceId: string, drawingId: string) => Promise<Workspace | null>;
  };
  connection: {
    connectNodes: (
      workspaceId: string,
      fromId: string,
      toId: string
    ) => Promise<{ ok: true; connectionId: string } | { ok: false; error: string }>;
    delete: (workspaceId: string, connectionId: string) => Promise<Workspace | null>;
    removeAllFor: (workspaceId: string, nodeId: string) => Promise<Workspace | null>;
    onTransferActive: (cb: (ev: TransferActiveEvent) => void) => () => void;
  };
  cableTie: {
    create: (workspaceId: string, tie: CableTie) => Promise<Workspace | null>;
    move: (workspaceId: string, tieId: string, pos: Point) => Promise<Workspace | null>;
    delete: (workspaceId: string, tieId: string) => Promise<Workspace | null>;
  };
  noteStack: {
    fileNote: (
      workspaceId: string,
      noteNodeId: string,
      stackName?: string | null
    ) => Promise<CanvasNode>;
    unstack: (workspaceId: string, noteNodeId: string) => Promise<Workspace | null>;
  };
  note: {
    write: (
      workspaceId: string,
      nodeId: string,
      text: string
    ) => Promise<{ workspace: Workspace | null; renamedTo?: string }>;
    setColor: (workspaceId: string, nodeId: string, color: NoteColor) => Promise<Workspace | null>;
  };
  band: {
    create: (
      workspaceId: string,
      nodeIds: string[],
      name: string
    ) => Promise<{ bandNode: CanvasNode; memberTerminalIds: string[] } | null>;
    addTerminal: (
      workspaceId: string,
      bandNodeId: string,
      terminalNodeId: string
    ) => Promise<Workspace | null>;
    select: (
      workspaceId: string,
      bandNodeId: string,
      memberNodeId: string
    ) => Promise<Workspace | null>;
    removeMember: (
      workspaceId: string,
      bandNodeId: string,
      memberNodeId: string
    ) => Promise<Workspace | null>;
    dissolve: (workspaceId: string, bandNodeId: string) => Promise<Workspace | null>;
    onAsksInFlight: (cb: (asks: Record<string, AskInFlight>) => void) => () => void;
  };
  terminal: {
    spawn: (input: {
      workspaceId: string;
      terminalId: string;
      cols?: number;
      rows?: number;
    }) => Promise<{ ok: boolean; pid?: number; error?: string }>;
    write: (terminalId: string, data: string) => void;
    deliverPrompt: (terminalId: string, text: string) => Promise<boolean>;
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
    kill: (terminalId: string) => Promise<void>;
    restart: (
      workspaceId: string,
      terminalId: string
    ) => Promise<{ ok: boolean; pid?: number; error?: string }>;
    getScrollback: (terminalId: string) => Promise<string>;
    activityState: () => Promise<TerminalActivityState>;
    inspect: (terminalId: string) => Promise<TerminalInspectInfo>;
    updateData: (
      workspaceId: string,
      terminalId: string,
      patch: Partial<TerminalData>
    ) => Promise<Workspace | null>;
    savePastedImage: (input: {
      workspaceId: string;
      workspaceDir: string;
      terminalId: string;
      fileName: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
      base64Data: string;
    }) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
    onData: (cb: (ev: { terminalId: string; data: string }) => void) => () => void;
    onExit: (cb: (ev: { terminalId: string; exitCode: number }) => void) => () => void;
    onStatus: (
      cb: (ev: { terminalId: string; status: 'starting' | 'running' | 'exited' }) => void
    ) => () => void;
    onActivity: (cb: (state: TerminalActivityState) => void) => () => void;
    onFocusRequest: (
      cb: (ev: {
        terminalId: string;
        nodeId: string | null;
        workspaceId: string | null;
        floorId: string | null;
      }) => void
    ) => () => void;
  };
  tokens: {
    get: () => Promise<TokenUsageMap>;
    onChanged: (cb: (map: TokenUsageMap) => void) => () => void;
  };
  agentUsage: {
    get: () => Promise<AgentUsageSnapshot>;
    refresh: (providerId?: AgentUsageProviderId) => Promise<void>;
    onChanged: (cb: (snapshot: AgentUsageSnapshot) => void) => () => void;
  };
  interAgent: {
    listPeers: (workspaceId: string, terminalId: string) => Promise<ReachableListResponse | null>;
  };
  roles: {
    list: (workspaceId?: string | null) => Promise<RolePreset[]>;
    create: (input: {
      name: string;
      prompt: string;
      scope: 'current' | 'global';
      workspaceId: string | null;
      icon?: string | null;
      color?: string | null;
    }) => Promise<RolePreset>;
    update: (id: string, patch: Partial<RolePreset>) => Promise<RolePreset | null>;
    delete: (id: string) => Promise<boolean>;
    onChanged: (cb: () => void) => () => void;
  };
  partitura: {
    list: (workspaceId?: string | null) => Promise<Partitura[]>;
    save: (part: Omit<Partitura, 'id' | 'createdAt'> & { id?: string }) => Promise<Partitura>;
    delete: (id: string) => Promise<boolean>;
    insert: (workspaceId: string, partituraId: string) => Promise<string[]>;
    onChanged: (cb: () => void) => () => void;
  };
  savedPrompts: {
    list: () => Promise<SavedPrompt[]>;
    save: (input: {
      id?: string;
      title: string;
      prompt: string;
      tags?: string[];
    }) => Promise<SavedPrompt>;
    delete: (id: string) => Promise<boolean>;
    onChanged: (cb: () => void) => () => void;
  };
  routines: {
    list: (workspaceId?: string | null) => Promise<Routine[]>;
    create: (input: {
      workspaceId: string;
      name: string;
      command: string;
      schedule: RoutineSchedule;
      targetTerminalId: string | null;
      isReminder?: boolean;
      preRunScript?: string | null;
    }) => Promise<Routine>;
    setEnabled: (id: string, enabled: boolean) => Promise<Routine | null>;
    runNow: (id: string) => Promise<{ ok: boolean; status: string }>;
    delete: (id: string) => Promise<boolean>;
    history: (workspaceId?: string | null) => Promise<RoutineHistoryEntry[]>;
    onChanged: (cb: () => void) => () => void;
    onHistoryChanged: (cb: () => void) => () => void;
  };
  fileTree: {
    list: (
      rootPath: string,
      dirPath: string,
      showHidden?: boolean
    ) => Promise<
      Array<{
        name: string;
        path: string;
        relativePath: string;
        isDirectory: boolean;
        size: number;
        gitStatus?: string;
      }>
    >;
    watch: (nodeId: string, dirPath: string) => Promise<void>;
    unwatch: (nodeId: string) => Promise<void>;
    readFile: (filePath: string) => Promise<{ ok: true; content: string } | { ok: false; error: string }>;
    writeFile: (filePath: string, text: string) => Promise<{ ok: boolean; error?: string }>;
    gitInfo: (rootPath: string) => Promise<{
      isRepo: boolean;
      branch: string | null;
      changes: Array<{ path: string; status: string; staged: boolean }>;
    }>;
    gitDiff: (rootPath: string, filePath?: string) => Promise<string>;
    gitCommit: (rootPath: string, msg: string) => Promise<{ ok: boolean; output: string }>;
    onDidChange: (cb: (nodeId: string) => void) => () => void;
  };
  portal: {
    register: (portalId: string, wcId: number) => Promise<void>;
    unregister: (portalId: string) => Promise<void>;
    action: (
      portalId: string,
      action: string,
      params?: Record<string, unknown>
    ) => Promise<{ ok: boolean; result: string }>;
    onWakeRequested: (cb: (portalId: string) => void) => () => void;
  };
  chat: {
    getState: (terminalId: string) => Promise<ChatThreadsState>;
    switchThread: (terminalId: string, slot: ChatThreadColor) => Promise<ChatThreadsState>;
    clearThread: (terminalId: string, slot: ChatThreadColor) => Promise<void>;
    send: (terminalId: string, slot: ChatThreadColor, text: string) => Promise<ChatEntry>;
    onEvent: (
      cb: (ev: {
        terminalId: string;
        slot: ChatThreadColor;
        entry?: ChatEntry;
        kind: 'append' | 'clear' | 'switch';
      }) => void
    ) => () => void;
  };
  license: {
    get: () => Promise<{ status: { kind: 'licensed' }; machineName: string; canCreateWorkspace: boolean }>;
  };
}

declare global {
  interface Window {
    maestri: MaestriBridge;
  }
}
