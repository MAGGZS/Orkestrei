import { atom } from 'jotai';
import { DEFAULT_PREFERENCES, DEFAULT_ZOOM } from '../../../shared/constants';
import type {
  AgentUsageSnapshot,
  AppState,
  AskInFlight,
  CanvasLevelContents,
  CanvasMode,
  CanvasNode,
  DrawingToolKind,
  Partitura,
  Point,
  Preferences,
  RolePreset,
  Routine,
  RoutineHistoryEntry,
  SavedPrompt,
  SidebarLayout,
  TerminalActivityState,
  TokenUsageMap,
  TransferActiveEvent,
  Workspace,
} from '../../../shared/types';

export const workspacesAtom = atom<Workspace[]>([]);
export const activeWorkspaceIdAtom = atom<string | null>(null);

export const activeWorkspaceAtom = atom<Workspace | null>((get) => {
  const list = get(workspacesAtom);
  const id = get(activeWorkspaceIdAtom);
  if (!id) return list[0] ?? null;
  return list.find((w) => w.id === id) ?? list[0] ?? null;
});

export const activeLevelAtom = atom<CanvasLevelContents>((get) => {
  const ws = get(activeWorkspaceAtom);
  if (!ws) {
    return {
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
  }
  if (!ws.activeFloorId) return ws;
  return ws.floors.find((f) => f.id === ws.activeFloorId) ?? ws;
});

export const appStateAtom = atom<AppState>({
  activeWorkspaceId: null,
  hasCompletedOnboarding: true,
  sidebarOpen: true,
  sidebarWidth: 260,
});

export const preferencesAtom = atom<Preferences>(DEFAULT_PREFERENCES);

export const sidebarLayoutAtom = atom<SidebarLayout>({
  pinnedIds: [],
  rootWorkspaceIds: [],
  rootFolders: [],
  groups: [],
});

export const rolesAtom = atom<RolePreset[]>([]);
export const partiturasAtom = atom<Partitura[]>([]);
export const savedPromptsAtom = atom<SavedPrompt[]>([]);
export const routinesAtom = atom<Routine[]>([]);
export const routineHistoryAtom = atom<RoutineHistoryEntry[]>([]);

// Camera & Canvas interaction atoms
export const canvasOffsetAtom = atom<Point>({ x: 0, y: 0 });
export const zoomAtom = atom<number>(DEFAULT_ZOOM);
export const canvasModeAtom = atom<CanvasMode>('select');
export const drawingToolAtom = atom<DrawingToolKind>('pen');
export const drawingColorAtom = atom<string>('#0a84ff');

export const selectedNodeIdsAtom = atom<Set<string>>(new Set<string>());
export const draggingNodeIdsAtom = atom<Set<string>>(new Set<string>());
export const liftedNodeIdAtom = atom<string | null>(null);
/** Pixel size of the canvas viewport element (used to place lifted/focused nodes). */
export const canvasViewportSizeAtom = atom<{ width: number; height: number }>({
  width: 1200,
  height: 800,
});

// Connection creation state
export const connectingFromNodeIdAtom = atom<string | null>(null);
export const connectingCursorAtom = atom<Point | null>(null);

// Cable-tie lasso state
export const tieLassoAtom = atom<{ start: Point; end: Point } | null>(null);

// Marquee & Snap guides
export const marqueeAtom = atom<{ start: Point; end: Point } | null>(null);
export const snapGuidesAtom = atom<{ x: number | null; y: number | null }>({ x: null, y: null });

// Live node frame overrides during drag/resize before IPC commit
export const liveFramesAtom = atom<Map<string, CanvasNode['frame']>>(new Map());

// Terminal activity & Inter-agent traffic pulses
export const activityStateAtom = atom<TerminalActivityState>({
  active: [],
  attention: [],
  working: [],
  hasActiveWork: false,
});
export const asksInFlightAtom = atom<Record<string, AskInFlight>>({});
export const recentTransfersAtom = atom<TransferActiveEvent[]>([]);
export const tokenUsageAtom = atom<TokenUsageMap>({});
export const EMPTY_AGENT_USAGE_SNAPSHOT: AgentUsageSnapshot = {
  providers: {},
  byTerminal: {},
  updatedAt: '',
};
export const agentUsageAtom = atom<AgentUsageSnapshot>(EMPTY_AGENT_USAGE_SNAPSHOT);

// Rope & Context menu popovers
export const ropePopoverAtom = atom<{
  connectionId: string;
  x: number;
  y: number;
  labelA: string;
  labelB: string;
} | null>(null);

export const canvasContextMenuAtom = atom<{
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
} | null>(null);

export const nodeContextMenuAtom = atom<{
  nodeId: string;
  x: number;
  y: number;
} | null>(null);

// Active modal/sheet
export type ActiveSheet =
  | null
  | { kind: 'newWorkspace' }
  | { kind: 'newFloor' }
  | { kind: 'landFloor'; floorId: string }
  | { kind: 'floorHooks' }
  | { kind: 'partituras' }
  | { kind: 'routines' }
  | { kind: 'rolesAndPresets' }
  | { kind: 'preferences' }
  | { kind: 'commandPalette' }
  | { kind: 'bandCreate'; nodeIds: string[] }
  | { kind: 'fileEditor'; filePath: string; title: string };

export const activeSheetAtom = atom<ActiveSheet>(null);
export const pendingPresetIdAtom = atom<string | null>(null);

export interface PromptImageAttachment {
  id: string;
  name: string;
  mimeType: 'image/png';
  previewUrl: string;
  width: number;
  height: number;
  filePath: string | null;
  pendingMainIpc: boolean;
  error?: string;
}

const PROMPT_DRAFTS_STORAGE_KEY = 'orkestrei:prompt-drafts:v1';

function loadPromptDrafts(): Record<string, string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = window.localStorage.getItem(PROMPT_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) next[k] = v;
    }
    return next;
  } catch {
    return {};
  }
}

function persistPromptDrafts(drafts: Record<string, string>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(PROMPT_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // ignore storage quota / restricted context errors
  }
}

const basePromptDraftsAtom = atom<Record<string, string>>(loadPromptDrafts());

export const promptDraftsAtom = atom(
  (get) => get(basePromptDraftsAtom),
  (
    get,
    set,
    update:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>)
  ) => {
    const prev = get(basePromptDraftsAtom);
    const next = typeof update === 'function' ? update(prev) : update;
    set(basePromptDraftsAtom, next);
    persistPromptDrafts(next);
  }
);

export const promptAttachmentsAtom = atom<Record<string, PromptImageAttachment[]>>({});
