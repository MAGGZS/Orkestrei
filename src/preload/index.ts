import { contextBridge, ipcRenderer } from 'electron';

function subscribe<T = unknown>(channel: string, handler: (payload: T) => void): () => void {
  const wrapped = (_ev: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  app: {
    info: () => ipcRenderer.invoke('maestri:app:info'),
    pickDirectory: () => ipcRenderer.invoke('maestri:app:pickDirectory'),
    openExternal: (url: string) => ipcRenderer.invoke('maestri:app:openExternal', url),
    openPath: (p: string) => ipcRenderer.invoke('maestri:app:openPath', p),
    onNotification: (cb: (n: { title: string; body: string }) => void) =>
      subscribe('maestri:app:notification', cb),
  },
  windowControls: {
    state: () => ipcRenderer.invoke('maestri:windowControls:state'),
    minimize: () => ipcRenderer.invoke('maestri:windowControls:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('maestri:windowControls:toggleMaximize'),
    close: () => ipcRenderer.invoke('maestri:windowControls:close'),
    onChanged: (cb: (state: { maximized: boolean; minimized: boolean }) => void) =>
      subscribe('maestri:windowControls:onChanged', cb),
  },
  appState: {
    get: () => ipcRenderer.invoke('maestri:appState:get'),
    update: (patch: unknown) => ipcRenderer.invoke('maestri:appState:update', patch),
  },
  preferences: {
    get: () => ipcRenderer.invoke('maestri:preferences:get'),
    set: (patch: unknown) => ipcRenderer.invoke('maestri:preferences:set', patch),
    onChanged: (cb: (prefs: unknown) => void) => subscribe('maestri:preferences:onChanged', cb),
  },
  sidebarLayout: {
    get: () => ipcRenderer.invoke('maestri:sidebarLayout:get'),
    set: (layout: unknown) => ipcRenderer.invoke('maestri:sidebarLayout:set', layout),
    onChanged: (cb: (layout: unknown) => void) => subscribe('maestri:sidebarLayout:onChanged', cb),
  },
  workspace: {
    list: () => ipcRenderer.invoke('maestri:workspace:list'),
    getActiveId: () => ipcRenderer.invoke('maestri:workspace:getActiveId'),
    switch: (id: string) => ipcRenderer.invoke('maestri:workspace:switch', id),
    create: (input: unknown) => ipcRenderer.invoke('maestri:workspace:create', input),
    patch: (id: string, patch: unknown) => ipcRenderer.invoke('maestri:workspace:patch', id, patch),
    delete: (id: string) => ipcRenderer.invoke('maestri:workspace:delete', id),
    undo: (id: string) => ipcRenderer.invoke('maestri:workspace:undo', id),
    redo: (id: string) => ipcRenderer.invoke('maestri:workspace:redo', id),
    beginUndoGroup: () => ipcRenderer.invoke('maestri:workspace:beginUndoGroup'),
    endUndoGroup: () => ipcRenderer.invoke('maestri:workspace:endUndoGroup'),
    onChanged: (cb: (ws: unknown) => void) => subscribe('maestri:workspace:onChanged', cb),
    onDeleted: (cb: (id: string) => void) => subscribe('maestri:workspace:onDeleted', cb),
    onActiveChanged: (cb: (id: string | null) => void) =>
      subscribe('maestri:workspace:onActiveChanged', cb),
  },
  floor: {
    create: (workspaceId: string, input: unknown) =>
      ipcRenderer.invoke('maestri:floor:create', workspaceId, input),
    switch: (workspaceId: string, floorId: string | null, cam?: unknown) =>
      ipcRenderer.invoke('maestri:floor:switch', workspaceId, floorId, cam),
    setStatus: (workspaceId: string, floorId: string | null, status: unknown) =>
      ipcRenderer.invoke('maestri:floor:setStatus', workspaceId, floorId, status),
    rename: (workspaceId: string, floorId: string, name: string) =>
      ipcRenderer.invoke('maestri:floor:rename', workspaceId, floorId, name),
    landingPreview: (workspaceId: string, floorId: string, targetBranch?: string) =>
      ipcRenderer.invoke('maestri:floor:landingPreview', workspaceId, floorId, targetBranch),
    land: (workspaceId: string, floorId: string, opts?: unknown) =>
      ipcRenderer.invoke('maestri:floor:land', workspaceId, floorId, opts),
    delete: (workspaceId: string, floorId: string) =>
      ipcRenderer.invoke('maestri:floor:delete', workspaceId, floorId),
  },
  floorHooks: {
    run: (workspaceId: string, floorId: string | null, phase: 'setup' | 'run' | 'teardown') =>
      ipcRenderer.invoke('maestri:floorHooks:run', workspaceId, floorId, phase),
  },
  node: {
    create: (workspaceId: string, node: unknown, floorId?: string | null) =>
      ipcRenderer.invoke('maestri:node:create', workspaceId, node, floorId),
    duplicate: (workspaceId: string, nodeId: string) =>
      ipcRenderer.invoke('maestri:node:duplicate', workspaceId, nodeId),
    moveToFloor: (workspaceId: string, nodeId: string, targetFloorId: string | null) =>
      ipcRenderer.invoke('maestri:node:moveToFloor', workspaceId, nodeId, targetFloorId),
    setRedacted: (workspaceId: string, nodeId: string, isRedacted: boolean) =>
      ipcRenderer.invoke('maestri:node:setRedacted', workspaceId, nodeId, isRedacted),
    patch: (workspaceId: string, nodeId: string, patch: unknown) =>
      ipcRenderer.invoke('maestri:node:patch', workspaceId, nodeId, patch),
    patchFrames: (workspaceId: string, patches: unknown) =>
      ipcRenderer.invoke('maestri:node:patchFrames', workspaceId, patches),
    deleteMany: (workspaceId: string, nodeIds: string[]) =>
      ipcRenderer.invoke('maestri:node:deleteMany', workspaceId, nodeIds),
  },
  group: {
    create: (workspaceId: string, nodeIds: string[]) =>
      ipcRenderer.invoke('maestri:group:create', workspaceId, nodeIds),
    ungroup: (workspaceId: string, nodeIds: string[]) =>
      ipcRenderer.invoke('maestri:group:ungroup', workspaceId, nodeIds),
  },
  drawing: {
    create: (workspaceId: string, drawing: unknown) =>
      ipcRenderer.invoke('maestri:drawing:create', workspaceId, drawing),
    delete: (workspaceId: string, drawingId: string) =>
      ipcRenderer.invoke('maestri:drawing:delete', workspaceId, drawingId),
  },
  connection: {
    connectNodes: (workspaceId: string, fromId: string, toId: string) =>
      ipcRenderer.invoke('maestri:connection:connectNodes', workspaceId, fromId, toId),
    delete: (workspaceId: string, connectionId: string) =>
      ipcRenderer.invoke('maestri:connection:delete', workspaceId, connectionId),
    removeAllFor: (workspaceId: string, nodeId: string) =>
      ipcRenderer.invoke('maestri:connection:removeAllFor', workspaceId, nodeId),
    onTransferActive: (cb: (ev: unknown) => void) =>
      subscribe('maestri:connection:transferActive', cb),
  },
  cableTie: {
    create: (workspaceId: string, tie: unknown) =>
      ipcRenderer.invoke('maestri:cableTie:create', workspaceId, tie),
    move: (workspaceId: string, tieId: string, pos: unknown) =>
      ipcRenderer.invoke('maestri:cableTie:move', workspaceId, tieId, pos),
    delete: (workspaceId: string, tieId: string) =>
      ipcRenderer.invoke('maestri:cableTie:delete', workspaceId, tieId),
  },
  noteStack: {
    fileNote: (workspaceId: string, noteNodeId: string, stackName?: string | null) =>
      ipcRenderer.invoke('maestri:noteStack:fileNote', workspaceId, noteNodeId, stackName),
    unstack: (workspaceId: string, noteNodeId: string) =>
      ipcRenderer.invoke('maestri:noteStack:unstack', workspaceId, noteNodeId),
  },
  note: {
    write: (workspaceId: string, nodeId: string, text: string) =>
      ipcRenderer.invoke('maestri:note:write', workspaceId, nodeId, text),
    setColor: (workspaceId: string, nodeId: string, color: string) =>
      ipcRenderer.invoke('maestri:note:setColor', workspaceId, nodeId, color),
  },
  band: {
    create: (workspaceId: string, nodeIds: string[], name: string) =>
      ipcRenderer.invoke('maestri:band:create', workspaceId, nodeIds, name),
    addTerminal: (workspaceId: string, bandNodeId: string, terminalNodeId: string) =>
      ipcRenderer.invoke('maestri:band:addTerminal', workspaceId, bandNodeId, terminalNodeId),
    select: (workspaceId: string, bandNodeId: string, memberNodeId: string) =>
      ipcRenderer.invoke('maestri:band:select', workspaceId, bandNodeId, memberNodeId),
    removeMember: (workspaceId: string, bandNodeId: string, memberNodeId: string) =>
      ipcRenderer.invoke('maestri:band:removeMember', workspaceId, bandNodeId, memberNodeId),
    dissolve: (workspaceId: string, bandNodeId: string) =>
      ipcRenderer.invoke('maestri:band:dissolve', workspaceId, bandNodeId),
    onAsksInFlight: (cb: (asks: Record<string, unknown>) => void) =>
      subscribe('maestri:band:asksInFlight', cb),
  },
  terminal: {
    spawn: (input: { workspaceId: string; terminalId: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('maestri:terminal:spawn', input),
    write: (terminalId: string, data: string) =>
      ipcRenderer.send('maestri:terminal:write', terminalId, data),
    deliverPrompt: (terminalId: string, text: string) =>
      ipcRenderer.invoke('maestri:terminal:deliverPrompt', terminalId, text),
    resize: (terminalId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('maestri:terminal:resize', terminalId, cols, rows),
    kill: (terminalId: string) => ipcRenderer.invoke('maestri:terminal:kill', terminalId),
    restart: (workspaceId: string, terminalId: string) =>
      ipcRenderer.invoke('maestri:terminal:restart', workspaceId, terminalId),
    getScrollback: (terminalId: string) =>
      ipcRenderer.invoke('maestri:terminal:getScrollback', terminalId),
    activityState: () => ipcRenderer.invoke('maestri:terminal:activityState'),
    inspect: (terminalId: string) => ipcRenderer.invoke('maestri:terminal:inspect', terminalId),
    updateData: (workspaceId: string, terminalId: string, patch: unknown) =>
      ipcRenderer.invoke('maestri:terminal:updateData', workspaceId, terminalId, patch),
    savePastedImage: (input: unknown) =>
      ipcRenderer.invoke('maestri:terminal:savePastedImage', input),
    onData: (cb: (ev: { terminalId: string; data: string }) => void) =>
      subscribe('maestri:terminal:onData', cb),
    onExit: (cb: (ev: { terminalId: string; exitCode: number }) => void) =>
      subscribe('maestri:terminal:onExit', cb),
    onStatus: (cb: (ev: { terminalId: string; status: string }) => void) =>
      subscribe('maestri:terminal:onStatus', cb),
    onActivity: (cb: (state: unknown) => void) => subscribe('maestri:terminal:activity', cb),
    onFocusRequest: (
      cb: (ev: {
        terminalId: string;
        nodeId: string | null;
        workspaceId: string | null;
        floorId: string | null;
      }) => void
    ) => subscribe('maestri:terminal:focusRequest', cb),
  },
  tokens: {
    get: () => ipcRenderer.invoke('maestri:tokens:get'),
    onChanged: (cb: (map: unknown) => void) => subscribe('maestri:tokens:onChanged', cb),
  },
  agentUsage: {
    get: () => ipcRenderer.invoke('maestri:agentUsage:get'),
    refresh: (providerId?: string) => ipcRenderer.invoke('maestri:agentUsage:refresh', providerId),
    onChanged: (cb: (snapshot: unknown) => void) => subscribe('maestri:agentUsage:changed', cb),
  },
  interAgent: {
    listPeers: (workspaceId: string, terminalId: string) =>
      ipcRenderer.invoke('maestri:interAgent:listPeers', workspaceId, terminalId),
  },
  roles: {
    list: (workspaceId?: string | null) => ipcRenderer.invoke('maestri:roles:list', workspaceId),
    create: (input: unknown) => ipcRenderer.invoke('maestri:roles:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('maestri:roles:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('maestri:roles:delete', id),
    onChanged: (cb: () => void) => subscribe('maestri:roles:changed', cb),
  },
  partitura: {
    list: (workspaceId?: string | null) => ipcRenderer.invoke('maestri:partitura:list', workspaceId),
    save: (part: unknown) => ipcRenderer.invoke('maestri:partitura:save', part),
    delete: (id: string) => ipcRenderer.invoke('maestri:partitura:delete', id),
    insert: (workspaceId: string, partituraId: string) =>
      ipcRenderer.invoke('maestri:partitura:insert', workspaceId, partituraId),
    onChanged: (cb: () => void) => subscribe('maestri:partitura:changed', cb),
  },
  savedPrompts: {
    list: () => ipcRenderer.invoke('maestri:savedPrompts:list'),
    save: (input: unknown) => ipcRenderer.invoke('maestri:savedPrompts:save', input),
    delete: (id: string) => ipcRenderer.invoke('maestri:savedPrompts:delete', id),
    onChanged: (cb: () => void) => subscribe('maestri:savedPrompts:changed', cb),
  },
  routines: {
    list: (workspaceId?: string | null) => ipcRenderer.invoke('maestri:routine:list', workspaceId),
    create: (input: unknown) => ipcRenderer.invoke('maestri:routine:create', input),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('maestri:routine:setEnabled', id, enabled),
    runNow: (id: string) => ipcRenderer.invoke('maestri:routine:runNow', id),
    delete: (id: string) => ipcRenderer.invoke('maestri:routine:delete', id),
    history: (workspaceId?: string | null) =>
      ipcRenderer.invoke('maestri:routine:history', workspaceId),
    onChanged: (cb: () => void) => subscribe('maestri:routine:onChanged', cb),
    onHistoryChanged: (cb: () => void) => subscribe('maestri:routine:onHistoryChanged', cb),
  },
  fileTree: {
    list: (rootPath: string, dirPath: string, showHidden?: boolean) =>
      ipcRenderer.invoke('maestri:fileTree:list', rootPath, dirPath, showHidden),
    watch: (nodeId: string, dirPath: string) =>
      ipcRenderer.invoke('maestri:fileTree:watch', nodeId, dirPath),
    unwatch: (nodeId: string) => ipcRenderer.invoke('maestri:fileTree:unwatch', nodeId),
    readFile: (filePath: string) => ipcRenderer.invoke('maestri:fileTree:readFile', filePath),
    writeFile: (filePath: string, text: string) =>
      ipcRenderer.invoke('maestri:fileTree:writeFile', filePath, text),
    gitInfo: (rootPath: string) => ipcRenderer.invoke('maestri:fileTree:gitInfo', rootPath),
    gitDiff: (rootPath: string, filePath?: string) =>
      ipcRenderer.invoke('maestri:fileTree:gitDiff', rootPath, filePath),
    gitCommit: (rootPath: string, msg: string) =>
      ipcRenderer.invoke('maestri:fileTree:gitCommit', rootPath, msg),
    onDidChange: (cb: (nodeId: string) => void) => subscribe('maestri:fileTree:onDidChange', cb),
  },
  portal: {
    register: (portalId: string, wcId: number) =>
      ipcRenderer.invoke('maestri:portal:register', portalId, wcId),
    unregister: (portalId: string) => ipcRenderer.invoke('maestri:portal:unregister', portalId),
    action: (portalId: string, action: string, params?: unknown) =>
      ipcRenderer.invoke('maestri:portal:action', portalId, action, params),
    onWakeRequested: (cb: (portalId: string) => void) => subscribe('maestri:portal:wake', cb),
  },
  chat: {
    getState: (terminalId: string) => ipcRenderer.invoke('maestri:chat:getState', terminalId),
    switchThread: (terminalId: string, slot: string) =>
      ipcRenderer.invoke('maestri:chat:switchThread', terminalId, slot),
    clearThread: (terminalId: string, slot: string) =>
      ipcRenderer.invoke('maestri:chat:clearThread', terminalId, slot),
    send: (terminalId: string, slot: string, text: string) =>
      ipcRenderer.invoke('maestri:chat:send', terminalId, slot, text),
    onEvent: (cb: (ev: unknown) => void) => subscribe('maestri:chat:onConversationEvent', cb),
  },
  license: {
    get: () => ipcRenderer.invoke('maestri:license:get'),
  },
};

contextBridge.exposeInMainWorld('maestri', api);
export type MaestriAPI = typeof api;
