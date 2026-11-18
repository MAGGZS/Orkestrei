import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import type {
  AgentPreset,
  AgentUsageProviderId,
  CableTie,
  CanvasDrawing,
  CanvasNode,
  ChatThreadColor,
  FloorStatus,
  NoteColor,
  Partitura,
  Point,
  Preferences,
  Rect,
  RolePreset,
  RoutineSchedule,
  SidebarLayout,
} from '../shared/types';
import { AgentUsageService } from './agent-usage-service';
import { ChatStore } from './chat-store';
import { FileTreeService } from './file-tree-service';
import { OrchestratorServer } from './orchestrator-server';
import { PortalBridge } from './portal-bridge';
import { PTYManager } from './pty-manager';
import { RoutineScheduler } from './routine-scheduler';
import { TokenUsageService } from './token-usage-service';
import { idsEqual } from './utils';
import { WorkspaceStore } from './workspace-store';

let mainWindow: BrowserWindow | null = null;

function resolveBinDir(): string {
  const candidates = [
    path.join(app.getAppPath(), 'bin'),
    path.resolve(__dirname, '../../bin'),
    path.join(process.resourcesPath || '', 'bin'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.orkestrei.desktop');
  await app.whenReady();

  const binDir = resolveBinDir();
  const store = new WorkspaceStore();
  await store.init();

  const ptyManager = new PTYManager(binDir);
  const tokenUsageService = new TokenUsageService(ptyManager);
  const agentUsageService = new AgentUsageService(ptyManager, {
    cacheDir: path.join(store.getDataDir(), 'usage-cache'),
  });
  const chatStore = new ChatStore(store.getDataDir());
  const fileTreeService = new FileTreeService();
  const portalBridge = new PortalBridge();

  const notifyUser = (title: string, body: string) => {
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    } catch {
      // ignore notification failure
    }
    broadcast('maestri:app:notification', { title, body });
  };

  const ensureTerminalSpawned = async (
    workspaceId: string,
    terminalId: string
  ): Promise<boolean> => {
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return false;
    const found = store.findTerminal(ws, terminalId);
    if (!found) return false;
    if (ptyManager.isRunning(found.terminal.id)) return true;

    const floor = found.floorId ? ws.floors.find((f) => idsEqual(f.id, found.floorId)) : null;
    const role = found.terminal.roleId ? store.getRole(found.terminal.roleId, ws.id) : null;
    const res = await ptyManager.spawn({
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceDir: floor?.clonePath || ws.workingDirectory,
      terminal: found.terminal,
      role,
    });
    return res.ok;
  };

  const routineScheduler = new RoutineScheduler({
    baseDir: store.getDataDir(),
    deliverToTerminal: (tid, cmd) => ptyManager.deliverPrompt(tid, cmd),
    isTerminalBusy: (tid) => Date.now() - ptyManager.getLastOutputAt(tid) < 1800,
    ensureTerminalRunning: ensureTerminalSpawned,
    getWorkspaceEnv: (wid, tid) => {
      const ws = store.getWorkspace(wid);
      const t = ws && tid ? store.findTerminal(ws, tid) : null;
      return {
        MAESTRI_WORKSPACE_NAME: ws?.name ?? '',
        MAESTRI_WORKSPACE_DIR: ws?.workingDirectory ?? '',
        MAESTRI_TERMINAL_NAME: t?.terminal.name ?? '',
      };
    },
    notifyUser,
  });
  await routineScheduler.init();

  const runFloorHooks = async (
    workspaceId: string,
    floorId: string | null,
    phase: 'setup' | 'run' | 'teardown'
  ): Promise<{
    ok: boolean;
    results: Array<{ id: string; label: string; command: string; ok: boolean; output: string }>;
  }> => {
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return { ok: false, results: [] };
    const cmds =
      phase === 'setup'
        ? ws.hooks.setupCommands
        : phase === 'run'
          ? ws.hooks.runCommands
          : ws.hooks.teardownCommands;
    if (cmds.length === 0) return { ok: true, results: [] };

    const floor = floorId ? ws.floors.find((f) => idsEqual(f.id, floorId)) : null;
    const cwd = floor?.clonePath || ws.workingDirectory;
    const results: Array<{ id: string; label: string; command: string; ok: boolean; output: string }> =
      [];
    let allOk = true;

    for (const item of cmds) {
      const cmdText = item.command.trim();
      if (!cmdText) continue;
      try {
        const { stdout, stderr } = await execAsync(cmdText, {
          cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
          timeout: 60_000,
          env: {
            ...process.env,
            MAESTRI_WORKSPACE_NAME: ws.name,
            MAESTRI_WORKSPACE_DIR: cwd,
            MAESTRI_FLOOR_NAME: floor?.name ?? 'Ground',
          },
        });
        results.push({
          id: item.id,
          label: item.name || cmdText,
          command: cmdText,
          ok: true,
          output: (stdout + (stderr ? `\n${stderr}` : '')).trim() || '(done)',
        });
      } catch (err) {
        allOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          id: item.id,
          label: item.name || cmdText,
          command: cmdText,
          ok: false,
          output: msg,
        });
      }
    }

    return { ok: allOk, results };
  };

  const orchestrator = new OrchestratorServer({
    store,
    ptyManager,
    chatStore,
    portalBridge,
    routineScheduler,
    ensureTerminalSpawned,
    notifyUser,
    onFloorCreated: async (wid, fid) => {
      const ws = store.getWorkspace(wid);
      if (ws?.hooks.isEnabled && ws.hooks.autoRunSetup && ws.hooks.setupCommands.length > 0) {
        await runFloorHooks(wid, fid, 'setup');
      }
    },
  });
  const port = await orchestrator.start(0);
  const pipeUrl = orchestrator.getUrl();
  ptyManager.setPipeUrl(pipeUrl);
  ptyManager.setAuthToken(orchestrator.getAuthToken());

  const getAllowedFileTreeRoots = (): string[] => {
    const roots = new Set<string>();
    const active = store.getActiveWorkspace();
    const targets = active ? [active] : store.listWorkspaces();
    for (const ws of targets) {
      if (ws.workingDirectory) roots.add(ws.workingDirectory);
      for (const floor of ws.floors) {
        if (floor.clonePath) roots.add(floor.clonePath);
        if (floor.groundPath) roots.add(floor.groundPath);
      }
    }
    return [...roots];
  };

  // Wire store/pty/orchestrator events to renderer
  store.onChanged((ws) => broadcast('maestri:workspace:onChanged', ws));
  store.onDeleted((id) => broadcast('maestri:workspace:onDeleted', id));
  store.onActiveChanged((id) => broadcast('maestri:workspace:onActiveChanged', id));
  store.onPreferencesChanged((prefs) => broadcast('maestri:preferences:onChanged', prefs));
  store.onSidebarLayoutChanged((layout) => broadcast('maestri:sidebarLayout:onChanged', layout));
  store.onPartiturasChanged(() => broadcast('maestri:partitura:changed'));
  store.onRolesChanged(() => broadcast('maestri:roles:changed'));
  store.onSavedPromptsChanged(() => broadcast('maestri:savedPrompts:changed'));

  ptyManager.onData((ev) => broadcast('maestri:terminal:onData', ev));
  ptyManager.onExit((ev) => broadcast('maestri:terminal:onExit', ev));
  ptyManager.onStatus((ev) => {
    broadcast('maestri:terminal:onStatus', ev);
    agentUsageService.syncTargets();
  });
  ptyManager.onActivity((state) => broadcast('maestri:terminal:activity', state));

  const activeAttentionNotifications = new Set<Notification>();
  ptyManager.onAttentionTransition((ev) => {
    if (
      ev.nextState !== 'approval' &&
      ev.nextState !== 'needs-input' &&
      ev.nextState !== 'error'
    ) {
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) {
      return;
    }

    let terminalName = 'Agent';
    let nodeId: string | null = null;
    let workspaceId: string | null = null;
    let floorId: string | null = null;
    for (const ws of store.listWorkspaces()) {
      const found = store.findTerminal(ws, ev.terminalId);
      if (found) {
        terminalName = found.terminal.name;
        nodeId = found.node.id;
        workspaceId = ws.id;
        floorId = found.floorId;
        break;
      }
    }

    const reason = ev.reason ?? ev.nextState;
    try {
      if (!Notification.isSupported()) return;
      const notif = new Notification({
        title: 'Orkestrei',
        body: `${terminalName} precisa de voce: ${reason}`,
      });
      activeAttentionNotifications.add(notif);
      notif.on('click', () => {
        activeAttentionNotifications.delete(notif);
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
        broadcast('maestri:terminal:focusRequest', {
          terminalId: ev.terminalId,
          nodeId,
          workspaceId,
          floorId,
        });
      });
      notif.on('close', () => {
        activeAttentionNotifications.delete(notif);
      });
      notif.show();
    } catch {
      // ignore notification failure
    }
  });
  tokenUsageService.onChanged((map) => broadcast('maestri:tokens:onChanged', map));
  tokenUsageService.start();

  agentUsageService.onChanged((snapshot) => broadcast('maestri:agentUsage:changed', snapshot));
  agentUsageService.start();

  orchestrator.onAsksInFlight((asks) => broadcast('maestri:band:asksInFlight', asks));
  orchestrator.onTransferActive((ev) => broadcast('maestri:connection:transferActive', ev));

  fileTreeService.onDidChange((nodeId) => broadcast('maestri:fileTree:onDidChange', nodeId));
  portalBridge.onWakeRequested((portalId) => broadcast('maestri:portal:wake', portalId));
  routineScheduler.onChanged(() => broadcast('maestri:routine:onChanged'));
  routineScheduler.onHistoryChanged(() => broadcast('maestri:routine:onHistoryChanged'));
  chatStore.onEvent((ev) => broadcast('maestri:chat:onConversationEvent', ev));

  // Register IPC Handlers
  ipcMain.handle('maestri:app:info', () => ({
    name: 'Orkestrei',
    version: app.getVersion(),
    platform: process.platform,
    orchestratorUrl: pipeUrl,
    orchestratorPort: port,
    dataDir: store.getDataDir(),
    homeDir: os.homedir(),
  }));

  ipcMain.handle('maestri:app:pickDirectory', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('maestri:app:openExternal', (_e, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(String(url ?? '').trim());
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle('maestri:app:openPath', (_e, p: string) => shell.openPath(p));

  ipcMain.handle('maestri:appState:get', () => store.getAppState());
  ipcMain.handle('maestri:appState:update', (_e, patch) => store.updateAppState(patch));

  ipcMain.handle('maestri:preferences:get', () => store.getPreferences());
  ipcMain.handle('maestri:preferences:set', (_e, patch: Partial<Preferences>) =>
    store.setPreferences(patch)
  );

  ipcMain.handle('maestri:sidebarLayout:get', () => store.getSidebarLayout());
  ipcMain.handle('maestri:sidebarLayout:set', (_e, layout: SidebarLayout) =>
    store.setSidebarLayout(layout)
  );

  // Window Controls
  ipcMain.handle('maestri:windowControls:state', () => ({
    maximized: mainWindow?.isMaximized() ?? false,
    minimized: mainWindow?.isMinimized() ?? false,
  }));
  ipcMain.handle('maestri:windowControls:minimize', () => mainWindow?.minimize());
  ipcMain.handle('maestri:windowControls:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('maestri:windowControls:close', () => mainWindow?.close());

  // Workspaces
  ipcMain.handle('maestri:workspace:list', () => store.listWorkspaces());
  ipcMain.handle('maestri:workspace:getActiveId', () => store.getActiveWorkspaceId());
  ipcMain.handle('maestri:workspace:switch', (_e, id: string) => store.switchWorkspace(id));
  ipcMain.handle('maestri:workspace:create', (_e, input) => store.createWorkspace(input));
  ipcMain.handle('maestri:workspace:patch', (_e, id: string, patch) =>
    store.patchWorkspace(id, patch)
  );
  ipcMain.handle('maestri:workspace:delete', async (_e, id: string) => {
    const ws = store.getWorkspace(id);
    if (ws) {
      for (const n of store.allNodes(ws)) {
        if (n.content.kind === 'terminal') ptyManager.kill(n.content.terminal.id);
      }
      agentUsageService.syncTargets();
    }
    await store.deleteWorkspace(id);
  });
  ipcMain.handle('maestri:workspace:undo', (_e, id: string) => store.undo(id));
  ipcMain.handle('maestri:workspace:redo', (_e, id: string) => store.redo(id));
  ipcMain.handle('maestri:workspace:beginUndoGroup', () => store.beginUndoGroup());
  ipcMain.handle('maestri:workspace:endUndoGroup', () => store.endUndoGroup());

  // Floors
  ipcMain.handle('maestri:floor:create', async (_e, workspaceId: string, input) => {
    const res = await store.createFloor(workspaceId, input);
    if (res.ok) {
      const ws = store.getWorkspace(workspaceId);
      if (ws?.hooks.isEnabled && ws.hooks.autoRunSetup && ws.hooks.setupCommands.length > 0) {
        void runFloorHooks(workspaceId, res.floor.id, 'setup');
      }
    }
    return res;
  });
  ipcMain.handle('maestri:floor:switch', (_e, workspaceId: string, floorId: string | null, cam) =>
    store.switchFloor(workspaceId, floorId, cam)
  );
  ipcMain.handle(
    'maestri:floor:setStatus',
    (_e, workspaceId: string, floorId: string | null, status: FloorStatus | null) =>
      store.setFloorStatus(workspaceId, floorId, status)
  );
  ipcMain.handle('maestri:floor:rename', (_e, workspaceId: string, floorId: string, name: string) =>
    store.renameFloor(workspaceId, floorId, name)
  );
  ipcMain.handle(
    'maestri:floor:landingPreview',
    (_e, workspaceId: string, floorId: string, targetBranch?: string) =>
      store.getFloorLandingPreview(workspaceId, floorId, targetBranch)
  );
  ipcMain.handle('maestri:floor:land', (_e, workspaceId: string, floorId: string, opts) =>
    store.landFloor(workspaceId, floorId, opts)
  );
  ipcMain.handle(
    'maestri:floorHooks:run',
    (_e, workspaceId: string, floorId: string | null, phase: 'setup' | 'run' | 'teardown') =>
      runFloorHooks(workspaceId, floorId, phase)
  );
  ipcMain.handle('maestri:floor:delete', async (_e, workspaceId: string, floorId: string) => {
    const res = await store.deleteFloor(workspaceId, floorId);
    for (const tid of res.removedTerminalIds) ptyManager.kill(tid);
    if (res.removedTerminalIds.length > 0) agentUsageService.syncTargets();
    return res;
  });

  // Nodes & Frames
  ipcMain.handle(
    'maestri:node:create',
    (_e, workspaceId: string, node: CanvasNode, floorId?: string | null) =>
      store.createNode(workspaceId, node, floorId)
  );
  ipcMain.handle('maestri:node:duplicate', (_e, workspaceId: string, nodeId: string) =>
    store.duplicateNode(workspaceId, nodeId)
  );
  ipcMain.handle(
    'maestri:node:moveToFloor',
    (_e, workspaceId: string, nodeId: string, targetFloorId: string | null) =>
      store.moveNodeToFloor(workspaceId, nodeId, targetFloorId)
  );
  ipcMain.handle(
    'maestri:node:setRedacted',
    (_e, workspaceId: string, nodeId: string, isRedacted: boolean) =>
      store.patchNode(workspaceId, nodeId, { isRedacted })
  );
  ipcMain.handle('maestri:node:patch', (_e, workspaceId: string, nodeId: string, patch) =>
    store.patchNode(workspaceId, nodeId, patch)
  );
  ipcMain.handle(
    'maestri:node:patchFrames',
    (_e, workspaceId: string, patches: Array<{ nodeId: string; frame: Partial<Rect> }>) =>
      store.patchFrames(workspaceId, patches)
  );
  ipcMain.handle('maestri:node:deleteMany', async (_e, workspaceId: string, nodeIds: string[]) => {
    const res = await store.deleteNodes(workspaceId, nodeIds);
    for (const tid of res.deletedTerminalIds) ptyManager.kill(tid);
    if (res.deletedTerminalIds.length > 0) agentUsageService.syncTargets();
    return res.workspace;
  });

  // Groups & Drawings
  ipcMain.handle('maestri:group:create', (_e, workspaceId: string, nodeIds: string[]) =>
    store.groupNodes(workspaceId, nodeIds)
  );
  ipcMain.handle('maestri:group:ungroup', (_e, workspaceId: string, nodeIds: string[]) =>
    store.ungroupNodes(workspaceId, nodeIds)
  );
  ipcMain.handle('maestri:drawing:create', (_e, workspaceId: string, drawing: CanvasDrawing) =>
    store.createDrawing(workspaceId, drawing)
  );
  ipcMain.handle('maestri:drawing:delete', (_e, workspaceId: string, drawingId: string) =>
    store.deleteDrawing(workspaceId, drawingId)
  );

  // Connections & Cable Ties
  ipcMain.handle('maestri:connection:connectNodes', (_e, workspaceId: string, a: string, b: string) =>
    store.connectNodes(workspaceId, a, b)
  );
  ipcMain.handle('maestri:connection:delete', (_e, workspaceId: string, connId: string) =>
    store.deleteConnection(workspaceId, connId)
  );
  ipcMain.handle('maestri:connection:removeAllFor', (_e, workspaceId: string, nodeId: string) =>
    store.disconnectAllForNode(workspaceId, nodeId)
  );
  ipcMain.handle('maestri:cableTie:create', (_e, workspaceId: string, tie: CableTie) =>
    store.createCableTie(workspaceId, tie)
  );
  ipcMain.handle('maestri:cableTie:move', (_e, workspaceId: string, tieId: string, pos: Point) =>
    store.moveCableTie(workspaceId, tieId, pos)
  );
  ipcMain.handle('maestri:cableTie:delete', (_e, workspaceId: string, tieId: string) =>
    store.deleteCableTie(workspaceId, tieId)
  );

  // Note Stacks (Fichários) & Notes
  ipcMain.handle(
    'maestri:noteStack:fileNote',
    (_e, workspaceId: string, noteNodeId: string, stackName?: string | null) =>
      store.fileNoteIntoStack(workspaceId, noteNodeId, stackName)
  );
  ipcMain.handle('maestri:noteStack:unstack', (_e, workspaceId: string, noteNodeId: string) =>
    store.unstackNote(workspaceId, noteNodeId)
  );
  ipcMain.handle('maestri:note:write', (_e, workspaceId: string, nodeId: string, text: string) =>
    store.updateNoteText(workspaceId, nodeId, text)
  );
  ipcMain.handle(
    'maestri:note:setColor',
    (_e, workspaceId: string, nodeId: string, color: NoteColor) => {
      const ws = store.getWorkspace(workspaceId);
      const loc = ws ? store.findNodeLocation(ws, nodeId) : null;
      if (!loc || loc.node.content.kind !== 'stickyNote') return null;
      return store.patchNode(workspaceId, nodeId, {
        content: { kind: 'stickyNote', stickyNote: { ...loc.node.content.stickyNote, color } },
      });
    }
  );

  // Bands
  ipcMain.handle(
    'maestri:band:create',
    (_e, workspaceId: string, nodeIds: string[], name: string) =>
      store.createBand(workspaceId, nodeIds, name)
  );
  ipcMain.handle(
    'maestri:band:addTerminal',
    (_e, workspaceId: string, bandNodeId: string, terminalNodeId: string) =>
      store.addTerminalToBand(workspaceId, bandNodeId, terminalNodeId)
  );
  ipcMain.handle(
    'maestri:band:select',
    (_e, workspaceId: string, bandNodeId: string, memberNodeId: string) =>
      store.selectBandMember(workspaceId, bandNodeId, memberNodeId)
  );
  ipcMain.handle(
    'maestri:band:removeMember',
    (_e, workspaceId: string, bandNodeId: string, memberNodeId: string) =>
      store.removeBandMember(workspaceId, bandNodeId, memberNodeId)
  );
  ipcMain.handle('maestri:band:dissolve', (_e, workspaceId: string, bandNodeId: string) =>
    store.dissolveBand(workspaceId, bandNodeId)
  );

  // Terminals & PTY
  ipcMain.handle(
    'maestri:terminal:spawn',
    async (_e, input: { workspaceId: string; terminalId: string; cols?: number; rows?: number }) => {
      const ws = store.getWorkspace(input.workspaceId);
      if (!ws) return { ok: false, error: 'Workspace not found' };
      const found = store.findTerminal(ws, input.terminalId);
      if (!found) return { ok: false, error: 'Terminal not found' };
      const floor = found.floorId ? ws.floors.find((f) => idsEqual(f.id, found.floorId)) : null;
      const role = found.terminal.roleId ? store.getRole(found.terminal.roleId, ws.id) : null;
      return ptyManager.spawn({
        workspaceId: ws.id,
        workspaceName: ws.name,
        workspaceDir: floor?.clonePath || ws.workingDirectory,
        terminal: found.terminal,
        role,
        cols: input.cols,
        rows: input.rows,
      });
    }
  );
  ipcMain.on('maestri:terminal:write', (_e, terminalId: string, data: string) =>
    ptyManager.write(terminalId, data)
  );
  ipcMain.handle('maestri:terminal:deliverPrompt', (_e, terminalId: string, text: string) =>
    ptyManager.deliverPrompt(terminalId, text)
  );
  ipcMain.handle(
    'maestri:terminal:resize',
    (_e, terminalId: string, cols: number, rows: number) => ptyManager.resize(terminalId, cols, rows)
  );
  ipcMain.handle('maestri:terminal:kill', (_e, terminalId: string) => {
    ptyManager.kill(terminalId);
    agentUsageService.syncTargets();
  });
  ipcMain.handle('maestri:terminal:restart', async (_e, workspaceId: string, terminalId: string) => {
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return { ok: false };
    const found = store.findTerminal(ws, terminalId);
    if (!found) return { ok: false };
    const floor = found.floorId ? ws.floors.find((f) => idsEqual(f.id, found.floorId)) : null;
    const role = found.terminal.roleId ? store.getRole(found.terminal.roleId, ws.id) : null;
    return ptyManager.restart({
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceDir: floor?.clonePath || ws.workingDirectory,
      terminal: found.terminal,
      role,
    });
  });
  ipcMain.handle('maestri:terminal:getScrollback', (_e, terminalId: string) =>
    ptyManager.getScrollback(terminalId)
  );
  ipcMain.handle('maestri:terminal:activityState', () => ptyManager.getActivityState());
  ipcMain.handle('maestri:tokens:get', () => tokenUsageService.getSnapshot());
  ipcMain.handle('maestri:agentUsage:get', () => agentUsageService.getSnapshot());
  ipcMain.handle('maestri:agentUsage:refresh', (_e, providerId?: AgentUsageProviderId) =>
    agentUsageService.refresh(providerId)
  );
  ipcMain.handle('maestri:terminal:inspect', (_e, terminalId: string) =>
    ptyManager.getEntryInfo(terminalId)
  );
  ipcMain.handle(
    'maestri:terminal:updateData',
    (_e, workspaceId: string, terminalId: string, patch) =>
      store.updateTerminalData(workspaceId, terminalId, patch)
  );
  ipcMain.handle(
    'maestri:terminal:savePastedImage',
    async (
      _e,
      input: {
        workspaceId: string;
        workspaceDir: string;
        terminalId: string;
        fileName: string;
        mimeType: string;
        base64Data: string;
      }
    ): Promise<{ ok: boolean; filePath?: string; error?: string }> => {
      if (!input || typeof input !== 'object') {
        return { ok: false, error: 'Invalid payload' };
      }

      const ws = store.getWorkspace(String(input.workspaceId ?? ''));
      if (!ws) {
        return { ok: false, error: 'Workspace not found' };
      }
      const termFound = store.findTerminal(ws, String(input.terminalId ?? ''));
      if (!termFound) {
        return { ok: false, error: 'Terminal not found in workspace' };
      }

      // Resolve allowed workspace/floor directories strictly from store (never trust renderer path).
      const candidateRoots = [
        ws.workingDirectory,
        ...ws.floors.flatMap((f) => [f.clonePath, f.groundPath]),
      ].filter((p): p is string => Boolean(p && p.trim()));

      const normalizeReal = async (p: string): Promise<string> => {
        const resolved = path.resolve(p);
        try {
          return await fsp.realpath(resolved);
        } catch {
          return resolved;
        }
      };

      const requestedDir = String(input.workspaceDir ?? '').trim();
      if (!requestedDir) {
        return { ok: false, error: 'Missing workspaceDir' };
      }
      const realRequested = await normalizeReal(requestedDir);
      const cmpRequested = process.platform === 'win32' ? realRequested.toLowerCase() : realRequested;

      let matchedRoot: string | null = null;
      for (const root of candidateRoots) {
        const realRoot = await normalizeReal(root);
        const cmpRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
        if (cmpRoot === cmpRequested) {
          matchedRoot = realRoot;
          break;
        }
      }
      if (!matchedRoot) {
        return { ok: false, error: 'Access denied: workspaceDir is not a valid workspace/floor root' };
      }

      const rawName = String(input.fileName ?? '').trim();
      if (
        !rawName ||
        rawName.length > 120 ||
        rawName === '.' ||
        rawName === '..' ||
        rawName.includes('..') ||
        /[\\/:*?"<>|\x00-\x1f]/.test(rawName) ||
        path.basename(rawName) !== rawName
      ) {
        return { ok: false, error: 'Invalid image fileName' };
      }

      const ext = path.extname(rawName).toLowerCase();
      const allowedExts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
      if (!allowedExts.has(ext)) {
        return { ok: false, error: 'Unsupported image extension (allowed: png, jpg, webp)' };
      }

      const mime = String(input.mimeType ?? '').trim().toLowerCase();
      const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp']);
      if (!allowedMimes.has(mime)) {
        return { ok: false, error: 'Unsupported image mimeType (allowed: image/png, image/jpeg, image/webp)' };
      }

      const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
      const rawBase64 = String(input.base64Data ?? '').replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '').trim();
      if (!rawBase64) {
        return { ok: false, error: 'Empty image data' };
      }
      const maxBase64Len = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16;
      if (rawBase64.length > maxBase64Len) {
        return { ok: false, error: 'Image exceeds 10 MiB limit' };
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rawBase64)) {
        return { ok: false, error: 'Invalid base64 image payload' };
      }

      const buf = Buffer.from(rawBase64, 'base64');
      if (buf.length === 0) {
        return { ok: false, error: 'Decoded image is empty' };
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        return { ok: false, error: 'Image exceeds 10 MiB limit' };
      }

      const tmpDir = path.join(matchedRoot, '.maestri', 'tmp');
      await fsp.mkdir(tmpDir, { recursive: true });
      const outPath = path.join(tmpDir, rawName);
      if (!(await fileTreeService.isPathWithinRoots(outPath, [tmpDir]))) {
        return { ok: false, error: 'Access denied: resolved image path escapes temp directory' };
      }

      await fsp.writeFile(outPath, buf);
      return { ok: true, filePath: outPath };
    }
  );

  // Saved Prompts
  ipcMain.handle('maestri:savedPrompts:list', () => store.listSavedPrompts());
  ipcMain.handle(
    'maestri:savedPrompts:save',
    (_e, input: { id?: string; title: string; prompt: string; tags?: string[] }) =>
      store.savePrompt(input)
  );
  ipcMain.handle('maestri:savedPrompts:delete', (_e, id: string) => store.deleteSavedPrompt(id));

  // Inter-agent peers for composer @mentions
  ipcMain.handle('maestri:interAgent:listPeers', (_e, workspaceId: string, terminalId: string) => {
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return null;
    return store.buildReachableList(ws, terminalId, (tid) => ptyManager.isRunning(tid));
  });

  // Roles, Presets, Partituras, Routines
  ipcMain.handle('maestri:roles:list', (_e, workspaceId?: string | null) =>
    store.listRoles(workspaceId)
  );
  ipcMain.handle('maestri:roles:create', (_e, input) => store.createRole(input));
  ipcMain.handle('maestri:roles:update', (_e, id: string, patch: Partial<RolePreset>) =>
    store.updateRole(id, patch)
  );
  ipcMain.handle('maestri:roles:delete', (_e, id: string) => store.deleteRole(id));

  ipcMain.handle('maestri:partitura:list', (_e, workspaceId?: string | null) =>
    store.listPartituras(workspaceId)
  );
  ipcMain.handle(
    'maestri:partitura:save',
    (_e, part: Omit<Partitura, 'id' | 'createdAt'> & { id?: string }) => store.savePartitura(part)
  );
  ipcMain.handle('maestri:partitura:delete', (_e, id: string) => store.deletePartitura(id));
  ipcMain.handle(
    'maestri:partitura:insert',
    (_e, workspaceId: string, partituraId: string) => {
      const part = store.listPartituras(workspaceId).find((p) => idsEqual(p.id, partituraId));
      if (!part) return [];
      return orchestrator.insertPartituraIntoWorkspace(workspaceId, null, part);
    }
  );

  ipcMain.handle('maestri:routine:list', (_e, workspaceId?: string | null) =>
    routineScheduler.list(workspaceId)
  );
  ipcMain.handle(
    'maestri:routine:create',
    (
      _e,
      input: {
        workspaceId: string;
        name: string;
        command: string;
        schedule: RoutineSchedule;
        targetTerminalId: string | null;
        isReminder?: boolean;
        preRunScript?: string | null;
      }
    ) => routineScheduler.create(input)
  );
  ipcMain.handle('maestri:routine:setEnabled', (_e, id: string, enabled: boolean) =>
    routineScheduler.setEnabled(id, enabled)
  );
  ipcMain.handle('maestri:routine:runNow', (_e, id: string) => routineScheduler.runNow(id));
  ipcMain.handle('maestri:routine:delete', (_e, id: string) => routineScheduler.delete(id));
  ipcMain.handle('maestri:routine:history', (_e, workspaceId?: string | null) =>
    routineScheduler.getHistory(workspaceId)
  );

  // FileTree & Git
  ipcMain.handle(
    'maestri:fileTree:list',
    (_e, rootPath: string, dirPath: string, showHidden?: boolean) =>
      fileTreeService.listDirectory(rootPath, dirPath, showHidden, getAllowedFileTreeRoots())
  );
  ipcMain.handle('maestri:fileTree:watch', async (_e, nodeId: string, dirPath: string) => {
    if (!(await fileTreeService.isPathWithinRoots(dirPath, getAllowedFileTreeRoots()))) return;
    fileTreeService.watchDirectory(nodeId, dirPath);
  });
  ipcMain.handle('maestri:fileTree:unwatch', (_e, nodeId: string) =>
    fileTreeService.unwatchDirectory(nodeId)
  );
  ipcMain.handle('maestri:fileTree:readFile', (_e, filePath: string) =>
    fileTreeService.readFile(filePath, getAllowedFileTreeRoots())
  );
  ipcMain.handle('maestri:fileTree:writeFile', (_e, filePath: string, text: string) =>
    fileTreeService.writeFile(filePath, text, getAllowedFileTreeRoots())
  );
  ipcMain.handle('maestri:fileTree:gitInfo', async (_e, rootPath: string) => {
    if (!(await fileTreeService.isPathWithinRoots(rootPath, getAllowedFileTreeRoots()))) {
      return { isRepo: false, branch: null, changes: [] };
    }
    return fileTreeService.getGitInfo(rootPath);
  });
  ipcMain.handle('maestri:fileTree:gitDiff', async (_e, rootPath: string, filePath?: string) => {
    const roots = getAllowedFileTreeRoots();
    if (!(await fileTreeService.isPathWithinRoots(rootPath, roots))) return '';
    if (filePath && !(await fileTreeService.isPathWithinRoots(path.resolve(rootPath, filePath), [rootPath]))) {
      return '';
    }
    return fileTreeService.getGitDiff(rootPath, filePath);
  });
  ipcMain.handle('maestri:fileTree:gitCommit', async (_e, rootPath: string, msg: string) => {
    if (!(await fileTreeService.isPathWithinRoots(rootPath, getAllowedFileTreeRoots()))) {
      return { ok: false, output: 'Access denied: path is outside workspace/floor root' };
    }
    return fileTreeService.gitCommit(rootPath, msg);
  });

  // Portal
  ipcMain.handle('maestri:portal:register', (_e, portalId: string, wcId: number) =>
    portalBridge.register(portalId, wcId)
  );
  ipcMain.handle('maestri:portal:unregister', (_e, portalId: string) =>
    portalBridge.unregister(portalId)
  );
  ipcMain.handle('maestri:portal:action', (_e, portalId: string, action: string, params) =>
    portalBridge.executeAction(portalId, action, params)
  );

  // Chat
  ipcMain.handle('maestri:chat:getState', (_e, terminalId: string) =>
    chatStore.getState(terminalId)
  );
  ipcMain.handle('maestri:chat:switchThread', (_e, terminalId: string, slot: ChatThreadColor) =>
    chatStore.switchThread(terminalId, slot)
  );
  ipcMain.handle('maestri:chat:clearThread', (_e, terminalId: string, slot: ChatThreadColor) =>
    chatStore.clearThread(terminalId, slot)
  );
  ipcMain.handle(
    'maestri:chat:send',
    async (_e, terminalId: string, slot: ChatThreadColor, text: string) => {
      const entry = await chatStore.appendEntry(terminalId, slot, { role: 'user', text });
      const header = `---\nBelow is a message from the user through Maestri Chat.\nReply via \`maestri say\`. Terminal text also runs normally.\nthread: ${slot}\n---\n${text}`;
      await ptyManager.deliverPrompt(terminalId, header);
      return entry;
    }
  );

  // Presets convenience
  ipcMain.handle('maestri:presets:save', async (_e, presets: AgentPreset[]) =>
    store.setPreferences({ agentPresets: presets })
  );

  // License (Always licensed locally)
  ipcMain.handle('maestri:license:get', () => ({
    status: { kind: 'licensed' },
    machineName: os.hostname(),
    canCreateWorkspace: true,
    lockedWorkspaceIds: [],
  }));

  const preloadCandidates = [
    path.join(__dirname, '../preload/index.cjs'),
    path.join(__dirname, '../preload/index.mjs'),
    path.join(__dirname, '../preload/index.js'),
  ];
  const preloadPath = preloadCandidates.find((p) => fs.existsSync(p)) ?? preloadCandidates[0];

  // Create BrowserWindow
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#1a1a1c',
    frame: false,
    titleBarStyle: 'hidden',
    title: 'Orkestrei',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  mainWindow.on('maximize', () =>
    broadcast('maestri:windowControls:onChanged', { maximized: true, minimized: false })
  );
  mainWindow.on('unmaximize', () =>
    broadcast('maestri:windowControls:onChanged', { maximized: false, minimized: false })
  );

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (process.env.ORKESTREI_VERIFY_SCREENSHOT) {
    const outPath = process.env.ORKESTREI_VERIFY_SCREENSHOT;
    setTimeout(async () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const domCheck = await mainWindow.webContents.executeJavaScript(
          `(() => ({
            title: document.title,
            nodes: document.querySelectorAll('[data-canvas-node-id]').length,
            hasViewport: !!document.querySelector('[data-canvas-viewport="true"]'),
            bodyLen: document.body.innerText.trim().length
          }))()`
        );
        const img = await mainWindow.webContents.capturePage();
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, img.toPNG());
        console.log('[ORKESTREI_VERIFY_SCREENSHOT]', JSON.stringify({ outPath, ...domCheck }));
      } catch (err) {
        console.error('[ORKESTREI_VERIFY_SCREENSHOT_ERROR]', err);
      } finally {
        app.quit();
      }
    }, 3500);
  }

  app.on('before-quit', () => {
    tokenUsageService.stop();
    agentUsageService.stop();
    routineScheduler.stop();
    void fileTreeService.stopAll();
    void orchestrator.stop();
    ptyManager.terminateAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

void bootstrap();
