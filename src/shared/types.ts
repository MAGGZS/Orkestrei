export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NoteColor =
  | 'yellow'
  | 'pink'
  | 'blue'
  | 'green'
  | 'orange'
  | 'purple'
  | 'white'
  | 'charcoal'
  | 'slate'
  | 'midnight';

export type AgentType =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'shell'
  | 'custom';

export type ChatThreadColor =
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  attachments?: Array<{ id: string; name: string; path: string }>;
  progress?: boolean;
}

export interface ChatThreadsState {
  activeSlot: ChatThreadColor;
  threads: Record<ChatThreadColor, ChatEntry[]>;
}

export interface TerminalData {
  id: string;
  name: string;
  command: string | null;
  workingDirectory: string | null;
  agentType: AgentType;
  presetId: string | null;
  roleId: string | null;
  roleName: string | null;
  isManager: boolean; // Maestro Mode
  inChatMode: boolean;
  color: string | null;
  icon: string;
  accountName: string;
  isUnloaded: boolean;
  lastCommandExitCode?: number | null;
}

export interface NoteStorageMode {
  kind: 'managed' | 'external';
  originalPath?: string;
}

export interface StickyNoteData {
  fileName: string;
  customName: string | null;
  color: NoteColor;
  customColor: string | null;
  isContentLocked: boolean;
  fontFamily: string | null;
  text: string;
  storageMode: NoteStorageMode;
}

export interface NoteStackData {
  id: string;
  name: string;
  hasCustomName: boolean;
  memberNodeIds: string[];
  frontNoteId: string | null;
  uniformColor: boolean;
  color: NoteColor;
}

export interface BandData {
  id: string;
  name: string;
  memberNodeIds: string[];
  selectedMemberNodeId: string | null;
  color: string | null;
  icon: string | null;
  sidebarWidth: number;
}

export interface PortalData {
  id: string;
  name: string;
  url: string;
  userAgentPreset: string;
  viewportSize: { width: number; height: number } | null;
  lastTitle?: string;
}

export interface FileTreeData {
  id: string;
  rootPath: string;
  expandedPaths: string[];
  showHidden: boolean;
}

export interface CrossFloorConnectorData {
  targetFloorId: string | null;
  targetTerminalId: string;
  remoteWorkspaceId?: string;
  label?: string;
}

export type NodeContent =
  | { kind: 'terminal'; terminal: TerminalData }
  | { kind: 'stickyNote'; stickyNote: StickyNoteData }
  | { kind: 'noteStack'; noteStack: NoteStackData }
  | { kind: 'band'; band: BandData }
  | { kind: 'portal'; portal: PortalData }
  | { kind: 'fileTree'; fileTree: FileTreeData }
  | { kind: 'crossFloorConnector'; crossFloorConnector: CrossFloorConnectorData };

export interface CanvasNode {
  id: string;
  frame: Rect;
  zIndex: number;
  groupId: string | null;
  isDocked?: boolean;
  isRedacted?: boolean;
  createdAt: string;
  lastModifiedAt: string;
  content: NodeContent;
}

export interface TerminalConnection {
  id: string;
  terminalIdA: string;
  terminalIdB: string;
  ropePoints?: Point[];
}

export interface NoteConnection {
  id: string;
  terminalId: string;
  noteNodeId: string;
  ropePoints?: Point[];
}

export interface NoteToNoteConnection {
  id: string;
  noteNodeIdA: string;
  noteNodeIdB: string;
  ropePoints?: Point[];
}

export interface PortalConnection {
  id: string;
  terminalId: string;
  portalNodeId: string;
  ropePoints?: Point[];
}

export interface PortalToPortalConnection {
  id: string;
  portalNodeIdA: string;
  portalNodeIdB: string;
  ropePoints?: Point[];
}

export interface CrossFloorConnection {
  id: string;
  floorIdA: string | null;
  terminalIdA: string;
  connectorNodeIdA: string;
  floorIdB: string | null;
  terminalIdB: string;
  connectorNodeIdB: string;
}

export interface CrossWorkspaceConnection {
  id: string;
  localFloorId: string | null;
  localTerminalId: string;
  connectorNodeId: string;
  remoteWorkspaceId: string;
  remoteTerminalId: string;
}

export interface CableTie {
  id: string;
  position: Point;
  perp: Point;
  memberRopeIds: string[];
}

export interface NodeGroup {
  id: string;
  name: string;
  colorHex: string | null;
  createdAt: string;
}

export type DrawingToolKind = 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text';

export interface CanvasDrawing {
  id: string;
  tool: DrawingToolKind;
  points: Point[];
  color: string;
  fillColor?: string | null;
  lineWidth: number;
  text?: string;
  layer: 'background' | 'foreground';
  groupId?: string | null;
}

export type FloorStatusState = 'working' | 'blocked' | 'review' | 'done';

export interface FloorStatus {
  state: FloorStatusState;
  text: string;
  progress?: number; // 0..1
  author?: string;
}

export interface CanvasLevelContents {
  nodes: CanvasNode[];
  drawings: CanvasDrawing[];
  groups: NodeGroup[];
  connections: TerminalConnection[];
  noteConnections: NoteConnection[];
  noteToNoteConnections: NoteToNoteConnection[];
  portalConnections: PortalConnection[];
  portalToPortalConnections: PortalToPortalConnection[];
  cableTies: CableTie[];
}

export interface Floor extends CanvasLevelContents {
  id: string;
  name: string;
  branchName: string | null;
  clonePath: string | null;
  cloneKind: 'worktree' | 'copy' | 'none';
  groundPath: string | null;
  groundBranch: string | null;
  color: string | null;
  canvasOrigin: Point;
  canvasZoom: number;
  dockedNodeId: string | null;
  liftedNodeId: string | null;
  createdAt: string;
  status: FloorStatus | null;
}

export interface HookCommand {
  id: string;
  name: string;
  command: string;
}

export interface FloorHooks {
  isEnabled: boolean;
  autoRunSetup: boolean;
  setupCommands: HookCommand[];
  runCommands: HookCommand[];
  teardownCommands: HookCommand[];
}

export interface Workspace extends CanvasLevelContents {
  id: string;
  name: string;
  workingDirectory: string;
  color: string | null;
  icon: string | null;
  isPinned: boolean;
  canvasOrigin: Point;
  canvasZoom: number;
  activeFloorId: string | null;
  groundStatus: FloorStatus | null;
  dockedNodeId: string | null;
  liftedNodeId: string | null;
  floors: Floor[];
  crossFloorConnections: CrossFloorConnection[];
  crossWorkspaceConnections: CrossWorkspaceConnection[];
  hooks: FloorHooks;
  createdAt: string;
  lastOpenedAt: string;
}

export interface AgentPreset {
  id: string;
  name: string;
  command: string;
  agentType: AgentType;
  icon: string;
  color: string | null;
  isActive: boolean;
  maestroMode: boolean;
  startInChatMode: boolean;
  showInQuickStart: boolean;
  account: string;
}

export interface RolePreset {
  id: string;
  name: string;
  prompt: string;
  scope: 'current' | 'global';
  workspaceId: string | null;
  icon: string | null;
  color: string | null;
  createdAt: string;
}

export interface Partitura {
  id: string;
  name: string;
  summary: string;
  icon: string;
  color: string;
  workspaceId: string | null;
  nodes: CanvasNode[];
  connections: TerminalConnection[];
  noteConnections: NoteConnection[];
  noteToNoteConnections: NoteToNoteConnection[];
  portalConnections: PortalConnection[];
  portalToPortalConnections: PortalToPortalConnection[];
  drawings: CanvasDrawing[];
  roles: RolePreset[];
  createdAt: string;
}

export type RoutineSchedule =
  | { kind: 'every'; value: string }
  | { kind: 'daily'; value: string }
  | { kind: 'weekly'; value: string }
  | { kind: 'once'; value: string };

export interface Routine {
  id: string;
  workspaceId: string;
  name: string;
  command: string;
  schedule: RoutineSchedule;
  targetTerminalId: string | null;
  isReminder: boolean;
  preRunScript: string | null;
  skipIfBusy: boolean;
  notify: boolean;
  enabled: boolean;
  fireCount: number;
  maxCount: number | null;
  untilDate: string | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
}

export interface RoutineHistoryEntry {
  id: string;
  routineId: string;
  routineName: string;
  workspaceId: string;
  firedAt: string;
  status: 'fired' | 'skipped_busy' | 'skipped_prerun' | 'failed';
  detail?: string;
}

export interface SidebarFolder {
  id: string;
  name: string;
  workspaceIds: string[];
  collapsed?: boolean;
}

export interface SidebarGroup {
  id: string;
  name: string;
  workspaceIds: string[];
  folders: SidebarFolder[];
  collapsed?: boolean;
}

export interface SidebarLayout {
  pinnedIds: string[];
  rootWorkspaceIds: string[];
  rootFolders: SidebarFolder[];
  groups: SidebarGroup[];
}

export interface Preferences {
  theme: 'dark' | 'light' | 'system';
  canvasBackground: 'grid' | 'solid';
  fontFamily: string;
  fontSize: number;
  confirmBeforeQuitting: boolean;
  defaultNoteColor: NoteColor;
  agentPresets: AgentPreset[];
}

export interface AppState {
  activeWorkspaceId: string | null;
  hasCompletedOnboarding: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export interface TerminalActivityState {
  active: string[];
  attention: string[];
  attentionReasons?: Record<string, string>;
  working: string[];
  hasActiveWork: boolean;
}

export type TokenUsageProvider = 'claude' | 'codex' | 'gemini';

/**
 * Token usage of the agent session running inside a terminal, read from the agent CLI's
 * own local transcript files (Claude Code / Codex / Gemini CLI). Nothing is sent anywhere.
 */
export interface TerminalTokenUsage {
  terminalId: string;
  provider: TokenUsageProvider;
  model: string | null;
  /** Fresh (uncached) input tokens, summed over the session. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cacheRead + cacheWrite. */
  totalTokens: number;
  /** Tokens occupying the context window on the latest turn. */
  contextTokens: number;
  contextWindow: number;
  /** Number of model responses counted. */
  turns: number;
  sessionFile: string;
  updatedAt: number;
}

export type TokenUsageMap = Record<string, TerminalTokenUsage>;

export type AgentUsageProviderId = 'claude' | 'codex' | 'antigravity';

export type AgentUsageRing = 'session' | 'weekly' | 'special' | null;

export interface AgentUsageWindow {
  id: string;
  title: string;
  ring: AgentUsageRing;
  usedPercent: number | null;
  resetsAt: string | null;
  durationSeconds: number | null;
}

export interface AgentUsageMeter {
  id: string;
  label: string;
  windows: AgentUsageWindow[];
}

export type AgentUsageState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'executableNotFound'
  | 'timeout';

export interface AgentUsageProviderStatus {
  id: AgentUsageProviderId;
  name: string;
  state: AgentUsageState;
  error?: string;
  plan: string | null;
  limitReached: boolean;
  meters: AgentUsageMeter[];
  lastSuccessAt: string | null;
  executable: string | null;
}

export interface AgentUsageSnapshot {
  providers: Partial<Record<AgentUsageProviderId, AgentUsageProviderStatus>>;
  byTerminal: Record<string, AgentUsageProviderId>;
  updatedAt: string;
}

export interface AskInFlight {
  id: string;
  fromTerminalId: string;
  toTerminalId: string;
  startedAt: number;
}

export interface TransferActiveEvent {
  fromTerminalId: string;
  toTerminalId: string;
  connectionId?: string;
  timestamp: number;
}

export interface ReachableTerminalInfo {
  id: string;
  nodeId: string;
  name: string;
  agentType: AgentType;
  role: string | null;
  isManager: boolean;
  running: boolean;
  floorId: string | null;
  floorName: string | null;
  workspaceId?: string;
  workspaceName?: string;
  farAddress?: string;
  accountName: string;
  team?: {
    peers: string[];
    portals: Array<{ name: string; summary: string }>;
    notes: Array<{ name: string; locked: boolean; depth: number; fichario?: boolean }>;
  };
}

export interface ReachableNoteInfo {
  id: string;
  name: string;
  locked: boolean;
  depth: number;
  fichario?: string | null;
}

export interface ReachablePortalInfo {
  id: string;
  name: string;
  summary: string;
}

export interface ReachableListResponse {
  self: {
    id: string;
    name: string;
    isManager: boolean;
    workspaceId: string;
    workspaceName: string;
    floorId: string | null;
    floorName: string | null;
  };
  terminals: ReachableTerminalInfo[];
  farPeers?: ReachableTerminalInfo[];
  notes: ReachableNoteInfo[];
  portals: ReachablePortalInfo[];
  noteStacks: Array<{ id: string; name: string; memberNodeIds: string[]; floorId: string | null }>;
  bands: Array<{ id: string; name: string; withCaller: boolean; memberIds: string[] }>;
}

export interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FloorLandingPreview {
  floorId: string;
  floorName: string;
  branchName: string;
  targetBranch: string;
  worktreePath: string;
  isGitRepo: boolean;
  dirtyFiles: string[];
  commitLog: string[];
  diffStat: string;
  diffText: string;
}

export interface TerminalInspectInfo {
  terminalId: string;
  pid: number | null;
  running: boolean;
  working: boolean;
  cwd: string;
  cols: number;
  rows: number;
  pipeEnv: string;
}

export type CanvasMode =
  | 'select'
  | 'pan'
  | 'terminal'
  | 'note'
  | 'connect'
  | 'portal'
  | 'fileTree'
  | 'draw'
  | 'cableTie';
