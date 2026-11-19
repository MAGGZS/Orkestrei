import { contextBridge, ipcRenderer } from 'electron';

function subscribe<T = unknown>(channel: string, handler: (payload: T) => void): () => void {
  const wrapped = (_ev: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  app: {
    info: () => ipcRenderer.invoke('orkestrei:app:info'),
    pickDirectory: () => ipcRenderer.invoke('orkestrei:app:pickDirectory'),
    openExternal: (url: string) => ipcRenderer.invoke('orkestrei:app:openExternal', url),
    openPath: (p: string) => ipcRenderer.invoke('orkestrei:app:openPath', p),
    onNotification: (cb: (n: { title: string; body: string }) => void) =>
      subscribe('orkestrei:app:notification', cb),
  },
  windowControls: {
    state: () => ipcRenderer.invoke('orkestrei:windowControls:state'),
    minimize: () => ipcRenderer.invoke('orkestrei:windowControls:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('orkestrei:windowControls:toggleMaximize'),
    close: () => ipcRenderer.invoke('orkestrei:windowControls:close'),
    onChanged: (cb: (state: { maximized: boolean; minimized: boolean }) => void) =>
      subscribe('orkestrei:windowControls:onChanged', cb),
  },
  appState: {
    get: () => ipcRenderer.invoke('orkestrei:appState:get'),
    update: (patch: unknown) => ipcRenderer.invoke('orkestrei:appState:update', patch),
  },
  preferences: {
    get: () => ipcRenderer.invoke('orkestrei:preferences:get'),
    set: (patch: unknown) => ipcRenderer.invoke('orkestrei:preferences:set', patch),
    onChanged: (cb: (prefs: unknown) => void) => subscribe('orkestrei:preferences:onChanged', cb),
  },
  sidebarLayout: {
    get: () => ipcRenderer.invoke('orkestrei:sidebarLayout:get'),
    set: (layout: unknown) => ipcRenderer.invoke('orkestrei:sidebarLayout:set', layout),
    onChanged: (cb: (layout: unknown) => void) => subscribe('orkestrei:sidebarLayout:onChanged', cb),
  },
  workspace: {
    list: () => ipcRenderer.invoke('orkestrei:workspace:list'),
    getActiveId: () => ipcRenderer.invoke('orkestrei:workspace:getActiveId'),
    switch: (id: string) => ipcRenderer.invoke('orkestrei:workspace:switch', id),
    create: (input: unknown) => ipcRenderer.invoke('orkestrei:workspace:create', input),
    patch: (id: string, patch: unknown) => ipcRenderer.invoke('orkestrei:workspace:patch', id, patch),
    delete: (id: string) => ipcRenderer.invoke('orkestrei:workspace:delete', id),
    undo: (id: string) => ipcRenderer.invoke('orkestrei:workspace:undo', id),
    redo: (id: string) => ipcRenderer.invoke('orkestrei:workspace:redo', id),
    beginUndoGroup: () => ipcRenderer.invoke('orkestrei:workspace:beginUndoGroup'),
    endUndoGroup: () => ipcRenderer.invoke('orkestrei:workspace:endUndoGroup'),
    onChanged: (cb: (ws: unknown) => void) => subscribe('orkestrei:workspace:onChanged', cb),
    onDeleted: (cb: (id: string) => void) => subscribe('orkestrei:workspace:onDeleted', cb),
    onActiveChanged: (cb: (id: string | null) => void) =>
      subscribe('orkestrei:workspace:onActiveChanged', cb),
  },
  floor: {
    create: (workspaceId: string, input: unknown) =>
      ipcRenderer.invoke('orkestrei:floor:create', workspaceId, input),
    switch: (workspaceId: string, floorId: string | null, cam?: unknown) =>
      ipcRenderer.invoke('orkestrei:floor:switch', workspaceId, floorId, cam),
    setStatus: (workspaceId: string, floorId: string | null, status: unknown) =>
      ipcRenderer.invoke('orkestrei:floor:setStatus', workspaceId, floorId, status),
    rename: (workspaceId: string, floorId: string, name: string) =>
      ipcRenderer.invoke('orkestrei:floor:rename', workspaceId, floorId, name),
    landingPreview: (workspaceId: string, floorId: string, targetBranch?: string) =>
      ipcRenderer.invoke('orkestrei:floor:landingPreview', workspaceId, floorId, targetBranch),
    land: (workspaceId: string, floorId: string, opts?: unknown) =>
      ipcRenderer.invoke('orkestrei:floor:land', workspaceId, floorId, opts),
    delete: (workspaceId: string, floorId: string) =>
      ipcRenderer.invoke('orkestrei:floor:delete', workspaceId, floorId),
  },
  floorHooks: {
    run: (workspaceId: string, floorId: string | null, phase: 'setup' | 'run' | 'teardown') =>
      ipcRenderer.invoke('orkestrei:floorHooks:run', workspaceId, floorId, phase),
  },
  node: {
    create: (workspaceId: string, node: unknown, floorId?: string | null) =>
      ipcRenderer.invoke('orkestrei:node:create', workspaceId, node, floorId),
    duplicate: (workspaceId: string, nodeId: string) =>
      ipcRenderer.invoke('orkestrei:node:duplicate', workspaceId, nodeId),
    moveToFloor: (workspaceId: string, nodeId: string, targetFloorId: string | null) =>
      ipcRenderer.invoke('orkestrei:node:moveToFloor', workspaceId, nodeId, targetFloorId),
    setRedacted: (workspaceId: string, nodeId: string, isRedacted: boolean) =>
      ipcRenderer.invoke('orkestrei:node:setRedacted', workspaceId, nodeId, isRedacted),
    patch: (workspaceId: string, nodeId: string, patch: unknown) =>
      ipcRenderer.invoke('orkestrei:node:patch', workspaceId, nodeId, patch),
    patchFrames: (workspaceId: string, patches: unknown) =>
      ipcRenderer.invoke('orkestrei:node:patchFrames', workspaceId, patches),
    deleteMany: (workspaceId: string, nodeIds: string[]) =>
      ipcRenderer.invoke('orkestrei:node:deleteMany', workspaceId, nodeIds),
  },
  group: {
    create: (workspaceId: string, nodeIds: string[]) =>
      ipcRenderer.invoke('orkestrei:group:create', workspaceId, nodeIds),
    ungroup: (workspaceId: string, nodeIds: string[]) =>
      ipcRenderer.invoke('orkestrei:group:ungroup', workspaceId, nodeIds),
  },
  drawing: {
    create: (workspaceId: string, drawing: unknown) =>
      ipcRenderer.invoke('orkestrei:drawing:create', workspaceId, drawing),
    delete: (workspaceId: string, drawingId: string) =>
      ipcRenderer.invoke('orkestrei:drawing:delete', workspaceId, drawingId),
  },
  connection: {
    connectNodes: (workspaceId: string, fromId: string, toId: string) =>
      ipcRenderer.invoke('orkestrei:connection:connectNodes', workspaceId, fromId, toId),
    delete: (workspaceId: string, connectionId: string) =>
      ipcRenderer.invoke('orkestrei:connection:delete', workspaceId, connectionId),
    removeAllFor: (workspaceId: string, nodeId: string) =>
      ipcRenderer.invoke('orkestrei:connection:removeAllFor', workspaceId, nodeId),
    onTransferActive: (cb: (ev: unknown) => void) =>
      subscribe('orkestrei:connection:transferActive', cb),
  },
  cableTie: {
    create: (workspaceId: string, tie: unknown) =>
      ipcRenderer.invoke('orkestrei:cableTie:create', workspaceId, tie),
    move: (workspaceId: string, tieId: string, pos: unknown) =>
      ipcRenderer.invoke('orkestrei:cableTie:move', workspaceId, tieId, pos),
    delete: (workspaceId: string, tieId: string) =>
      ipcRenderer.invoke('orkestrei:cableTie:delete', workspaceId, tieId),
  },
  noteStack: {
    fileNote: (workspaceId: string, noteNodeId: string, stackName?: string | null) =>
      ipcRenderer.invoke('orkestrei:noteStack:fileNote', workspaceId, noteNodeId, stackName),
    unstack: (workspaceId: string, noteNodeId: string) =>
      ipcRenderer.invoke('orkestrei:noteStack:unstack', workspaceId, noteNodeId),
  },
  note: {
    write: (workspaceId: string, nodeId: string, text: string) =>
      ipcRenderer.invoke('orkestrei:note:write', workspaceId, nodeId, text),
    setColor: (workspaceId: string, nodeId: string, color: string) =>
      ipcRenderer.invoke('orkestrei:note:setColor', workspaceId, nodeId, color),
  },
  band: {
    create: (workspaceId: string, nodeIds: string[], name: string) =>
      ipcRenderer.invoke('orkestrei:band:create', workspaceId, nodeIds, name),
    addTerminal: (workspaceId: string, bandNodeId: string, terminalNodeId: string) =>
      ipcRenderer.invoke('orkestrei:band:addTerminal', workspaceId, bandNodeId, terminalNodeId),
    select: (workspaceId: string, bandNodeId: string, memberNodeId: string) =>
      ipcRenderer.invoke('orkestrei:band:select', workspaceId, bandNodeId, memberNodeId),
    removeMember: (workspaceId: string, bandNodeId: string, memberNodeId: string) =>
      ipcRenderer.invoke('orkestrei:band:removeMember', workspaceId, bandNodeId, memberNodeId),
    dissolve: (workspaceId: string, bandNodeId: string) =>
      ipcRenderer.invoke('orkestrei:band:dissolve', workspaceId, bandNodeId),
    onAsksInFlight: (cb: (asks: Record<string, unknown>) => void) =>
      subscribe('orkestrei:band:asksInFlight', cb),
  },
  terminal: {
    spawn: (input: { workspaceId: string; terminalId: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('orkestrei:terminal:spawn', input),
    write: (terminalId: string, data: string) =>
      ipcRenderer.send('orkestrei:terminal:write', terminalId, data),
    deliverPrompt: (terminalId: string, text: string) =>
      ipcRenderer.invoke('orkestrei:terminal:deliverPrompt', terminalId, text),
    resize: (terminalId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('orkestrei:terminal:resize', terminalId, cols, rows),
    kill: (terminalId: string) => ipcRenderer.invoke('orkestrei:terminal:kill', terminalId),
    restart: (workspaceId: string, terminalId: string) =>
      ipcRenderer.invoke('orkestrei:terminal:restart', workspaceId, terminalId),
    getScrollback: (terminalId: string) =>
      ipcRenderer.invoke('orkestrei:terminal:getScrollback', terminalId),
    activityState: () => ipcRenderer.invoke('orkestrei:terminal:activityState'),
    inspect: (terminalId: string) => ipcRenderer.invoke('orkestrei:terminal:inspect', terminalId),
    updateData: (workspaceId: string, terminalId: string, patch: unknown) =>
      ipcRenderer.invoke('orkestrei:terminal:updateData', workspaceId, terminalId, patch),
    savePastedImage: (input: unknown) =>
      ipcRenderer.invoke('orkestrei:terminal:savePastedImage', input),
    onData: (cb: (ev: { terminalId: string; data: string }) => void) =>
      subscribe('orkestrei:terminal:onData', cb),
    onExit: (cb: (ev: { terminalId: string; exitCode: number }) => void) =>
      subscribe('orkestrei:terminal:onExit', cb),
    onStatus: (cb: (ev: { terminalId: string; status: string }) => void) =>
      subscribe('orkestrei:terminal:onStatus', cb),
    onActivity: (cb: (state: unknown) => void) => subscribe('orkestrei:terminal:activity', cb),
    onFocusRequest: (
      cb: (ev: {
        terminalId: string;
        nodeId: string | null;
        workspaceId: string | null;
        floorId: string | null;
      }) => void
    ) => subscribe('orkestrei:terminal:focusRequest', cb),
  },
  tokens: {
    get: () => ipcRenderer.invoke('orkestrei:tokens:get'),
    onChanged: (cb: (map: unknown) => void) => subscribe('orkestrei:tokens:onChanged', cb),
  },
  agentUsage: {
    get: () => ipcRenderer.invoke('orkestrei:agentUsage:get'),
    refresh: (providerId?: string) => ipcRenderer.invoke('orkestrei:agentUsage:refresh', providerId),
    onChanged: (cb: (snapshot: unknown) => void) => subscribe('orkestrei:agentUsage:changed', cb),
  },
  interAgent: {
    listPeers: (workspaceId: string, terminalId: string) =>
      ipcRenderer.invoke('orkestrei:interAgent:listPeers', workspaceId, terminalId),
  },
  roles: {
    list: (workspaceId?: string | null) => ipcRenderer.invoke('orkestrei:roles:list', workspaceId),
    create: (input: unknown) => ipcRenderer.invoke('orkestrei:roles:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('orkestrei:roles:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('orkestrei:roles:delete', id),
    onChanged: (cb: () => void) => subscribe('orkestrei:roles:changed', cb),
  },
  partitura: {
    list: (workspaceId?: string | null) => ipcRenderer.invoke('orkestrei:partitura:list', workspaceId),
    save: (part: unknown) => ipcRenderer.invoke('orkestrei:partitura:save', part),
    delete: (id: string) => ipcRenderer.invoke('orkestrei:partitura:delete', id),
    insert: (workspaceId: string, partituraId: string) =>
      ipcRenderer.invoke('orkestrei:partitura:insert', workspaceId, partituraId),
    onChanged: (cb: () => void) => subscribe('orkestrei:partitura:changed', cb),
  },
  savedPrompts: {
    list: () => ipcRenderer.invoke('orkestrei:savedPrompts:list'),
    save: (input: unknown) => ipcRenderer.invoke('orkestrei:savedPrompts:save', input),
    delete: (id: string) => ipcRenderer.invoke('orkestrei:savedPrompts:delete', id),
    onChanged: (cb: () => void) => subscribe('orkestrei:savedPrompts:changed', cb),
  },
  routines: {
    list: (workspaceId?: string | null) => ipcRenderer.invoke('orkestrei:routine:list', workspaceId),
    create: (input: unknown) => ipcRenderer.invoke('orkestrei:routine:create', input),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('orkestrei:routine:setEnabled', id, enabled),
    runNow: (id: string) => ipcRenderer.invoke('orkestrei:routine:runNow', id),
    delete: (id: string) => ipcRenderer.invoke('orkestrei:routine:delete', id),
    history: (workspaceId?: string | null) =>
      ipcRenderer.invoke('orkestrei:routine:history', workspaceId),
    onChanged: (cb: () => void) => subscribe('orkestrei:routine:onChanged', cb),
    onHistoryChanged: (cb: () => void) => subscribe('orkestrei:routine:onHistoryChanged', cb),
  },
  fileTree: {
    list: (rootPath: string, dirPath: string, showHidden?: boolean) =>
      ipcRenderer.invoke('orkestrei:fileTree:list', rootPath, dirPath, showHidden),
    watch: (nodeId: string, dirPath: string) =>
      ipcRenderer.invoke('orkestrei:fileTree:watch', nodeId, dirPath),
    unwatch: (nodeId: string) => ipcRenderer.invoke('orkestrei:fileTree:unwatch', nodeId),
    readFile: (filePath: string) => ipcRenderer.invoke('orkestrei:fileTree:readFile', filePath),
    writeFile: (filePath: string, text: string) =>
      ipcRenderer.invoke('orkestrei:fileTree:writeFile', filePath, text),
    gitInfo: (rootPath: string) => ipcRenderer.invoke('orkestrei:fileTree:gitInfo', rootPath),
    gitDiff: (rootPath: string, filePath?: string) =>
      ipcRenderer.invoke('orkestrei:fileTree:gitDiff', rootPath, filePath),
    gitCommit: (rootPath: string, msg: string) =>
      ipcRenderer.invoke('orkestrei:fileTree:gitCommit', rootPath, msg),
    onDidChange: (cb: (nodeId: string) => void) => subscribe('orkestrei:fileTree:onDidChange', cb),
  },
  portal: {
    register: (portalId: string, wcId: number) =>
      ipcRenderer.invoke('orkestrei:portal:register', portalId, wcId),
    unregister: (portalId: string) => ipcRenderer.invoke('orkestrei:portal:unregister', portalId),
    action: (portalId: string, action: string, params?: unknown) =>
      ipcRenderer.invoke('orkestrei:portal:action', portalId, action, params),
    onWakeRequested: (cb: (portalId: string) => void) => subscribe('orkestrei:portal:wake', cb),
  },
  chat: {
    getState: (terminalId: string) => ipcRenderer.invoke('orkestrei:chat:getState', terminalId),
    switchThread: (terminalId: string, slot: string) =>
      ipcRenderer.invoke('orkestrei:chat:switchThread', terminalId, slot),
    clearThread: (terminalId: string, slot: string) =>
      ipcRenderer.invoke('orkestrei:chat:clearThread', terminalId, slot),
    send: (terminalId: string, slot: string, text: string) =>
      ipcRenderer.invoke('orkestrei:chat:send', terminalId, slot, text),
    onEvent: (cb: (ev: unknown) => void) => subscribe('orkestrei:chat:onConversationEvent', cb),
  },
  license: {
    get: () => ipcRenderer.invoke('orkestrei:license:get'),
  },
};

contextBridge.exposeInMainWorld('orkestrei', api);
export type OrkestreiAPI = typeof api;
