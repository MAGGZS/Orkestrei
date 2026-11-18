import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_PORTAL_SIZE,
  DEFAULT_TERMINAL_SIZE,
  PORTAL_UA_PRESETS,
  STICKY_COLORS,
} from '../shared/constants';
import type {
  AgentPreset,
  AskInFlight,
  CanvasNode,
  ChatThreadColor,
  FloorStatusState,
  NoteColor,
  Partitura,
  RoutineSchedule,
  TransferActiveEvent,
} from '../shared/types';
import type { ChatStore } from './chat-store';
import type { PortalBridge } from './portal-bridge';
import type { PTYManager } from './pty-manager';
import type { RoutineScheduler } from './routine-scheduler';
import { displayNameForNoteFile, idsEqual, newId, sameFloor, truncate } from './utils';
import type { WorkspaceStore } from './workspace-store';

export interface OrchestratorDeps {
  store: WorkspaceStore;
  ptyManager: PTYManager;
  chatStore: ChatStore;
  portalBridge: PortalBridge;
  routineScheduler: RoutineScheduler;
  ensureTerminalSpawned: (workspaceId: string, terminalId: string) => Promise<boolean>;
  notifyUser: (title: string, body: string) => void;
  onFloorCreated?: (workspaceId: string, floorId: string) => Promise<void> | void;
  authToken?: string;
}

interface PendingAskWaiter {
  id: string;
  fromTerminalId: string;
  toTerminalId: string;
  resolve: (answer: string) => void;
}

export class OrchestratorServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly authToken: string;
  private asksInFlight = new Map<string, AskInFlight>();
  private askWaiters = new Map<string, PendingAskWaiter>();
  private asksListeners = new Set<(asks: Record<string, AskInFlight>) => void>();
  private transferListeners = new Set<(ev: TransferActiveEvent) => void>();

  constructor(private deps: OrchestratorDeps) {
    this.authToken = deps.authToken?.trim() || randomBytes(32).toString('hex');
  }

  getAuthToken(): string {
    return this.authToken;
  }

  async start(preferredPort = 0): Promise<number> {
    if (this.server) return this.port;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(preferredPort, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        resolve();
      });
    });
    return this.port;
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const waiter of this.askWaiters.values()) {
      waiter.resolve('');
    }
    this.askWaiters.clear();
    this.asksInFlight.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  onAsksInFlight(cb: (asks: Record<string, AskInFlight>) => void): () => void {
    this.asksListeners.add(cb);
    return () => this.asksListeners.delete(cb);
  }

  onTransferActive(cb: (ev: TransferActiveEvent) => void): () => void {
    this.transferListeners.add(cb);
    return () => this.transferListeners.delete(cb);
  }

  private emitAsksInFlight(): void {
    const obj: Record<string, AskInFlight> = {};
    for (const [k, v] of this.asksInFlight.entries()) {
      obj[k] = v;
    }
    for (const cb of this.asksListeners) cb(obj);
  }

  private emitTransfer(fromTerminalId: string, toTerminalId: string): void {
    const ev: TransferActiveEvent = {
      fromTerminalId,
      toTerminalId,
      timestamp: Date.now(),
    };
    for (const cb of this.transferListeners) cb(ev);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private parseJson<T = Record<string, unknown>>(raw: string): T | null {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private send(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    isJson = typeof body !== 'string'
  ): void {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    });
    res.end(payload);
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const rawHeaderToken = req.headers['x-maestri-token'];
    let candidate = Array.isArray(rawHeaderToken) ? rawHeaderToken[0] : rawHeaderToken;
    if (!candidate) {
      const rawAuth = req.headers.authorization;
      const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      if (auth && auth.toLowerCase().startsWith('bearer ')) {
        candidate = auth.slice(7).trim();
      }
    }
    if (!candidate) return false;
    const expectedBuf = Buffer.from(this.authToken, 'utf8');
    const actualBuf = Buffer.from(candidate, 'utf8');
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  private resolveCaller(req: http.IncomingMessage) {
    const rawId = req.headers['x-terminal-id'];
    const fromTerminalId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!fromTerminalId) return null;
    const found = this.deps.store.findWorkspaceForTerminal(fromTerminalId);
    if (!found) return null;
    return { fromTerminalId, ...found };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const method = (req.method || 'GET').toUpperCase();
    const pathname = reqUrl.pathname;

    if (method === 'GET' && pathname === '/health') {
      this.send(res, 200, { ok: true, service: 'orkestrei' });
      return;
    }

    if (!this.isAuthorized(req)) {
      this.send(res, 401, 'Unauthorized: missing or invalid MAESTRI_TOKEN.');
      return;
    }

    const caller = this.resolveCaller(req);
    if (!caller) {
      this.send(res, 401, 'Missing or unknown X-Terminal-ID header (run inside an Orkestrei terminal).');
      return;
    }

    const { fromTerminalId, workspace } = caller;
    const rawBody = method === 'POST' || method === 'PUT' ? await this.readBody(req) : '';
    const json = this.parseJson<Record<string, unknown>>(rawBody) ?? {};

    try {
      // LIST
      if (method === 'GET' && pathname === '/list') {
        const list = this.deps.store.buildReachableList(workspace, fromTerminalId, (tid) =>
          this.deps.ptyManager.isRunning(tid)
        );
        this.send(res, 200, list, true);
        return;
      }

      // CHECK
      if (method === 'GET' && pathname === '/check') {
        const name = (reqUrl.searchParams.get('name') || String(req.headers['x-agent-name'] || '')).trim();
        if (!name) {
          this.send(res, 400, 'Missing target agent name');
          return;
        }
        const resolved = this.deps.store.resolveTargetTerminal(workspace, fromTerminalId, name);
        if (!resolved) {
          this.send(res, 404, `Terminal "${name}" not found`);
          return;
        }
        if (!resolved.reachable) {
          this.send(res, 403, `No connection to "${name}". Connect them on the canvas first.`);
          return;
        }
        const text = await this.deps.ptyManager.getVisibleText(resolved.terminalId);
        this.send(res, 200, text);
        return;
      }

      // ASK (single)
      if (method === 'POST' && pathname === '/ask') {
        const targetName = String(json.target ?? '').trim();
        const prompt = String(json.prompt ?? '');
        const isRaw = json.raw === true;
        const timeoutMs = Number(json.timeoutMs ?? 60_000);
        if (!targetName) {
          this.send(res, 400, 'Missing target name');
          return;
        }
        const result = await this.executeAsk(workspace.id, fromTerminalId, targetName, prompt, {
          isRaw,
          timeoutMs,
        });
        this.send(res, result.status, result.body);
        return;
      }

      // ASK (batch)
      if (method === 'POST' && pathname === '/ask/batch') {
        const targets = json.targets as Record<string, string> | undefined;
        const timeoutMs = Number(json.timeoutMs ?? 120_000);
        if (!targets || typeof targets !== 'object') {
          this.send(res, 400, 'Missing targets JSON map');
          return;
        }
        const results = await Promise.all(
          Object.entries(targets).map(async ([name, prompt]) => {
            const r = await this.executeAsk(workspace.id, fromTerminalId, name, String(prompt), {
              isRaw: false,
              timeoutMs,
            });
            return r.status >= 400 ? { name, error: r.body } : { name, output: r.body };
          })
        );
        this.send(res, 200, results, true);
        return;
      }

      // NOTIFY
      if (method === 'POST' && pathname === '/notify') {
        const message = String(json.message ?? '').trim();
        const title = caller.terminal ? `Orkestrei — ${caller.terminal.name}` : 'Orkestrei';
        this.deps.notifyUser(title, message || 'Notification');
        this.send(res, 200, 'Notification sent.');
        return;
      }

      // CONNECT
      if (method === 'POST' && pathname === '/connect') {
        const fromName = String(json.from ?? '').trim();
        const toName = String(json.to ?? '').trim();
        if (fromName.includes('@') || toName.includes('@')) {
          const resA =
            fromName.toLowerCase() === 'me' || fromName.toLowerCase() === 'self'
              ? {
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                  terminalId: fromTerminalId,
                }
              : this.deps.store.resolveTargetTerminal(workspace, fromTerminalId, fromName);
          const resB =
            toName.toLowerCase() === 'me' || toName.toLowerCase() === 'self'
              ? {
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                  terminalId: fromTerminalId,
                }
              : this.deps.store.resolveTargetTerminal(workspace, fromTerminalId, toName);

          if (resA && resB && !idsEqual(resA.workspaceId, resB.workspaceId)) {
            const crossRes = await this.deps.store.connectAcrossWorkspaces(
              resA.workspaceId,
              resA.terminalId,
              resB.workspaceId,
              resB.terminalId
            );
            if (!crossRes.ok) {
              this.send(res, 400, crossRes.error);
              return;
            }
            this.send(
              res,
              200,
              `Connected "${fromName}" (${resA.workspaceName}) ↔ "${toName}" (${resB.workspaceName}).`
            );
            return;
          }
        }

        const idA = this.resolveEntityId(workspace.id, fromTerminalId, fromName);
        const idB = this.resolveEntityId(workspace.id, fromTerminalId, toName);
        if (!idA || !idB) {
          this.send(
            res,
            404,
            `Could not find "${!idA ? fromName : toName}" inside this workspace.`
          );
          return;
        }
        const resConn = await this.deps.store.connectNodes(workspace.id, idA, idB);
        if (!resConn.ok) {
          this.send(res, 400, resConn.error);
          return;
        }
        this.send(res, 200, `Connected "${fromName}" ↔ "${toName}".`);
        return;
      }

      // RECRUIT
      if (method === 'POST' && pathname === '/team/recruit') {
        const result = await this.handleRecruit(workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // DISMISS
      if (method === 'POST' && pathname === '/team/dismiss') {
        const name = String(json.name ?? '').trim();
        const target = this.deps.store.resolveTargetTerminal(workspace, fromTerminalId, name);
        if (!target) {
          this.send(res, 404, `Terminal "${name}" not found`);
          return;
        }
        if (!target.reachable || idsEqual(target.terminalId, fromTerminalId)) {
          this.send(res, 403, `Cannot dismiss "${name}"`);
          return;
        }
        this.deps.ptyManager.kill(target.terminalId);
        await this.deps.store.deleteNodes(target.workspaceId, [target.nodeId]);
        this.send(res, 200, `Dismissed "${target.terminal.name}".`);
        return;
      }

      // BAND
      if (method === 'POST' && pathname === '/team/band') {
        const result = await this.handleBand(workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body);
        return;
      }

      // PARTITURA
      if (method === 'POST' && pathname === '/team/partitura') {
        const result = await this.handlePartitura(workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // ARRANGE
      if (method === 'POST' && pathname === '/team/arrange') {
        const result = await this.handleArrange(workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body);
        return;
      }

      // NOTES
      if (pathname.startsWith('/note/')) {
        const result = await this.handleNotes(method, pathname, reqUrl, workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body);
        return;
      }

      // ROLES
      if (pathname.startsWith('/role/')) {
        const result = await this.handleRoles(method, pathname, reqUrl, workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // PRESETS
      if (pathname.startsWith('/preset/')) {
        const result = await this.handlePresets(method, pathname, reqUrl, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // FLOORS
      if (pathname.startsWith('/floor/')) {
        const result = await this.handleFloors(method, pathname, workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // WORKSPACES
      if (pathname.startsWith('/workspace/')) {
        const result = await this.handleWorkspaces(method, pathname, workspace.id, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // PORTALS
      if (pathname.startsWith('/portal/')) {
        const result = await this.handlePortals(method, pathname, workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // ROUTINES
      if (pathname.startsWith('/routine/')) {
        const result = await this.handleRoutines(method, pathname, reqUrl, workspace.id, fromTerminalId, json);
        this.send(res, result.status, result.body, typeof result.body !== 'string');
        return;
      }

      // CHAT
      if (method === 'POST' && pathname === '/chat/say') {
        const text = String(json.text ?? '');
        const slot = (json.thread as ChatThreadColor | undefined) ?? undefined;
        const isProgress = json.progress === true;
        await this.deps.chatStore.appendEntry(fromTerminalId, slot ?? null, {
          role: 'assistant',
          text,
          progress: isProgress,
        });
        this.send(res, 200, 'ok');
        return;
      }

      if (method === 'GET' && pathname === '/chat/recall') {
        const slot = (reqUrl.searchParams.get('thread') as ChatThreadColor | null) ?? undefined;
        const limit = Number(reqUrl.searchParams.get('turns') ?? 10);
        const recalled = await this.deps.chatStore.recall(fromTerminalId, slot, limit);
        this.send(res, 200, recalled, true);
        return;
      }

      this.send(res, 404, `No route for ${method} ${pathname}`);
    } catch (err) {
      this.send(res, 500, `Server error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private resolveEntityId(workspaceId: string, callerTerminalId: string, name: string): string | null {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return null;
    if (name.toLowerCase() === 'me' || name.toLowerCase() === 'self') return callerTerminalId;
    const clean = name.trim().toLowerCase();

    for (const n of this.deps.store.allNodes(ws)) {
      if (n.content.kind === 'terminal') {
        if (idsEqual(n.id, name) || idsEqual(n.content.terminal.id, name) || n.content.terminal.name.toLowerCase() === clean) {
          return n.content.terminal.id;
        }
      } else if (n.content.kind === 'stickyNote') {
        const disp = (n.content.stickyNote.customName || displayNameForNoteFile(n.content.stickyNote.fileName)).toLowerCase();
        if (idsEqual(n.id, name) || disp === clean || n.content.stickyNote.fileName.toLowerCase() === clean) {
          return n.id;
        }
      } else if (n.content.kind === 'noteStack') {
        if (idsEqual(n.id, name) || n.content.noteStack.name.toLowerCase() === clean) return n.id;
      } else if (n.content.kind === 'band') {
        if (idsEqual(n.id, name) || n.content.band.name.toLowerCase() === clean) return n.id;
      } else if (n.content.kind === 'portal') {
        if (idsEqual(n.id, name) || (n.content.portal.name || 'portal').toLowerCase() === clean) return n.id;
      }
    }
    return null;
  }

  private unescapeRaw(input: string): string {
    return input
      .replace(/\\n/g, '\r')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\e/g, '\x1b')
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  private findLastSubsequence(haystack: string[], needle: string[]): number {
    if (needle.length === 0 || haystack.length < needle.length) return -1;
    for (let i = haystack.length - needle.length; i >= 0; i--) {
      let matched = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return i;
    }
    return -1;
  }

  private extractAskOutput(beforeText: string, afterText: string, visibleText: string): string {
    if (!afterText) return visibleText;
    if (!beforeText) return afterText.trim() || visibleText;
    if (afterText === beforeText) return visibleText;

    if (afterText.startsWith(beforeText) && afterText.length > beforeText.length) {
      return afterText.slice(beforeText.length).trim() || visibleText;
    }

    const beforeLines = beforeText.split('\n');
    const afterLines = afterText.split('\n');
    // Try matching a suffix of beforeLines (both full suffix and excluding the last prompt line
    // which may have been modified in-place when the ask prompt was echoed onto it).
    const endOffsets = beforeLines.length > 1 ? [0, 1] : [0];
    for (const trimEnd of endOffsets) {
      const end = beforeLines.length - trimEnd;
      const maxAnchor = Math.min(12, end);
      for (let anchorLen = maxAnchor; anchorLen >= 2; anchorLen--) {
        const anchor = beforeLines.slice(end - anchorLen, end);
        const matchStart = this.findLastSubsequence(afterLines, anchor);
        if (matchStart !== -1) {
          const extracted = afterLines
            .slice(matchStart + anchorLen)
            .join('\n')
            .trim();
          if (extracted) return extracted;
        }
      }
    }

    if (beforeLines.length <= 2) {
      const lastBefore = beforeLines[beforeLines.length - 1].trimEnd();
      const idx = afterLines.findIndex((l) => l.startsWith(lastBefore));
      if (idx !== -1) {
        const tail = [afterLines[idx].slice(lastBefore.length), ...afterLines.slice(idx + 1)]
          .join('\n')
          .trim();
        if (tail) return tail;
      }
    }

    // When scrollback rolled past 5000 lines or a TUI redrew the screen, return the full
    // available scrollback instead of clipping to the visible viewport.
    return afterText.trim() || visibleText;
  }

  private async executeAsk(
    workspaceId: string,
    fromTerminalId: string,
    targetName: string,
    prompt: string,
    opts: { isRaw: boolean; timeoutMs: number }
  ): Promise<{ status: number; body: string }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };

    const target = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, targetName);
    if (!target) return { status: 404, body: `Agent "${targetName}" not found` };
    if (!target.reachable) {
      return { status: 403, body: `No connection to "${targetName}". Run maestri connect first.` };
    }

    // Wake / spawn target terminal if unloaded or not yet running, then wait for shell boot readiness.
    if (!this.deps.ptyManager.isRunning(target.terminalId)) {
      await this.deps.ensureTerminalSpawned(target.workspaceId, target.terminalId);
    }
    await this.deps.ptyManager.waitForReady(target.terminalId);

    this.emitTransfer(fromTerminalId, target.terminalId);

    if (opts.isRaw) {
      this.deps.ptyManager.write(target.terminalId, this.unescapeRaw(prompt));
      return { status: 200, body: 'ok' };
    }

    // Check if target is currently waiting on an ask from us (ask-back completion!)
    for (const [wid, waiter] of this.askWaiters.entries()) {
      if (
        idsEqual(waiter.fromTerminalId, target.terminalId) &&
        idsEqual(waiter.toTerminalId, fromTerminalId)
      ) {
        this.askWaiters.delete(wid);
        waiter.resolve(prompt);
        return { status: 200, body: `Delivered answer to ${target.terminal.name}.` };
      }
    }

    const askId = newId();
    this.asksInFlight.set(askId, {
      id: askId,
      fromTerminalId,
      toTerminalId: target.terminalId,
      startedAt: Date.now(),
    });
    this.emitAsksInFlight();

    const beforeText = await this.deps.ptyManager.getPlainText(target.terminalId);
    const beforeLastOut = this.deps.ptyManager.getLastOutputAt(target.terminalId);

    let resolvedByAskBack = false;
    const askBackPromise = new Promise<string>((resolve) => {
      this.askWaiters.set(askId, {
        id: askId,
        fromTerminalId,
        toTerminalId: target.terminalId,
        resolve: (ans) => {
          resolvedByAskBack = true;
          resolve(ans);
        },
      });
    });

    await this.deps.ptyManager.deliverPrompt(target.terminalId, prompt);
    const deliveredAt = Date.now();
    const isPlainShell = target.terminal.agentType === 'shell' && !target.terminal.command;
    const shellPromptRegex = /(?:^PS\s+[^>]+>|^[A-Za-z]:\\[^>]*>|[\w.@:-]+.*[#$%❯➜])\s*$/;
    const trimmedPrompt = prompt.trim();

    let pollTimer: NodeJS.Timeout | null = null;
    let finished = false;
    const stopPoll = () => {
      finished = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const idlePromise = new Promise<string>((resolve) => {
      const check = async () => {
        if (finished || resolvedByAskBack) {
          stopPoll();
          return;
        }
        const elapsed = Date.now() - deliveredAt;
        const lastOut = this.deps.ptyManager.getLastOutputAt(target.terminalId);
        const sawBytes = lastOut > beforeLastOut;
        const quietFor = Date.now() - Math.max(lastOut, deliveredAt);
        const stillRunning = this.deps.ptyManager.isRunning(target.terminalId);

        let settled = elapsed >= opts.timeoutMs || (!stillRunning && elapsed >= 150);

        if (!settled && sawBytes && quietFor >= 1000) {
          const curPlain = await this.deps.ptyManager.getPlainText(target.terminalId);
          const curVisible = await this.deps.ptyManager.getVisibleText(target.terminalId);
          if (finished || resolvedByAskBack) {
            stopPoll();
            return;
          }
          const visibleLines = curVisible
            .split('\n')
            .map((l) => l.trimEnd())
            .filter(Boolean);
          const lastVisibleLine = visibleLines[visibleLines.length - 1] ?? '';

          if (isPlainShell && curPlain !== beforeText && shellPromptRegex.test(lastVisibleLine)) {
            settled = true;
          } else if (quietFor >= 8000) {
            const delta = this.extractAskOutput(beforeText, curPlain, '');
            const normDelta = delta.replace(/\s+/g, '');
            const normPrompt = trimmedPrompt.replace(/\s+/g, '');
            const nonEcho =
              normPrompt && normDelta.includes(normPrompt)
                ? normDelta.replace(normPrompt, '')
                : normDelta;
            const sawRealOutput = nonEcho.length > 0 || lastOut > deliveredAt + 1200;
            if (sawRealOutput) {
              settled = true;
            }
          }
        }

        if (settled) {
          stopPoll();
          const afterText = await this.deps.ptyManager.getPlainText(target.terminalId);
          const visibleText = await this.deps.ptyManager.getVisibleText(target.terminalId);
          resolve(this.extractAskOutput(beforeText, afterText, visibleText));
          return;
        }

        if (!finished && !resolvedByAskBack) {
          pollTimer = setTimeout(() => void check(), 200);
        }
      };

      pollTimer = setTimeout(() => void check(), 200);
    });

    let output = '';
    try {
      output = await Promise.race([askBackPromise, idlePromise]);
    } finally {
      stopPoll();
      this.askWaiters.delete(askId);
      this.asksInFlight.delete(askId);
      this.emitAsksInFlight();
    }

    return { status: 200, body: output };
  }

  private async handleRecruit(
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };

    const callerLoc = this.deps.store.findTerminal(ws, fromTerminalId);
    if (!callerLoc) {
      return { status: 401, body: 'Unknown caller terminal.' };
    }
    if (!callerLoc.terminal.isManager) {
      return { status: 403, body: 'This terminal is not the Maestro. Toggle Maestro mode on it first.' };
    }

    const replaceName = json.replace ? String(json.replace).trim() : null;
    const rawName = json.name ? String(json.name).trim() : '';
    const presetName = json.preset ? String(json.preset).trim() : null;
    const roleName = json.role ? String(json.role).trim() : null;
    const floorName = json.floor ? String(json.floor).trim() : null;
    const targetWorkspaceName = json.workspace ? String(json.workspace).trim() : null;
    const commandOverride = json.command !== undefined ? String(json.command) : null;
    const dirOverride = json.dir ? String(json.dir).trim() : null;
    const iconOverride = json.icon ? String(json.icon).trim() : null;
    const colorOverride = json.color ? String(json.color).trim() : null;
    const bandName = json.band ? String(json.band).trim() : null;

    const targetWs = targetWorkspaceName
      ? this.deps.store
          .listWorkspaces()
          .find(
            (w) =>
              idsEqual(w.id, targetWorkspaceName) ||
              w.name.toLowerCase() === targetWorkspaceName.toLowerCase()
          ) ?? null
      : ws;
    if (!targetWs) {
      return { status: 404, body: `Workspace "${targetWorkspaceName}" not found.` };
    }
    const isCrossWorkspace = !idsEqual(targetWs.id, ws.id);

    const prefs = this.deps.store.getPreferences();
    const matchedPreset = presetName
      ? prefs.agentPresets.find((p) => p.name.toLowerCase() === presetName.toLowerCase())
      : callerLoc?.terminal.presetId
        ? prefs.agentPresets.find((p) => idsEqual(p.id, callerLoc.terminal.presetId))
        : prefs.agentPresets.find((p) => p.agentType === 'shell');

    if (presetName && !matchedPreset) {
      return {
        status: 404,
        body: `Preset "${presetName}" not found. Available: ${prefs.agentPresets.map((p) => p.name).join(', ')}`,
      };
    }

    const matchedRole = roleName
      ? (this.deps.store.getRole(roleName, targetWs.id) ?? this.deps.store.getRole(roleName, workspaceId))
      : null;
    if (roleName && !matchedRole) {
      return { status: 404, body: `Role "${roleName}" not found.` };
    }

    // Replace in place
    if (replaceName) {
      const target = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, replaceName);
      if (!target) return { status: 404, body: `Teammate "${replaceName}" not found` };
      await this.deps.store.updateTerminalData(target.workspaceId, target.terminalId, {
        name: rawName || target.terminal.name,
        command: commandOverride ?? matchedPreset?.command ?? target.terminal.command,
        presetId: matchedPreset?.id ?? target.terminal.presetId,
        agentType: matchedPreset?.agentType ?? target.terminal.agentType,
        roleId: matchedRole ? matchedRole.id : target.terminal.roleId,
        roleName: matchedRole ? matchedRole.name : target.terminal.roleName,
        workingDirectory: dirOverride ?? target.terminal.workingDirectory,
        icon: iconOverride ?? matchedPreset?.icon ?? target.terminal.icon,
        color: colorOverride ?? matchedPreset?.color ?? target.terminal.color,
      });
      this.deps.ptyManager.kill(target.terminalId);
      await this.deps.ensureTerminalSpawned(target.workspaceId, target.terminalId);
      return {
        status: 200,
        body: `Replaced "${replaceName}" in place as "${rawName || target.terminal.name}".`,
      };
    }

    // Target floor
    let targetFloorId: string | null = isCrossWorkspace
      ? targetWs.activeFloorId
      : (callerLoc?.floorId ?? targetWs.activeFloorId);
    let floorDir = targetWs.workingDirectory;
    if (floorName) {
      if (floorName.toLowerCase() === 'ground') {
        targetFloorId = null;
      } else {
        const f = targetWs.floors.find((x) => x.name.toLowerCase() === floorName.toLowerCase());
        if (!f) return { status: 404, body: `Floor "${floorName}" not found` };
        targetFloorId = f.id;
        if (f.clonePath) floorDir = f.clonePath;
      }
    } else if (targetFloorId) {
      const f = targetWs.floors.find((x) => idsEqual(x.id, targetFloorId));
      if (f?.clonePath) floorDir = f.clonePath;
    }

    // Unique name
    const existingNames = new Set(
      this.deps.store
        .allNodes(targetWs)
        .filter((n) => n.content.kind === 'terminal')
        .map((n) => (n.content as { kind: 'terminal'; terminal: { name: string } }).terminal.name)
    );
    let finalName = rawName || matchedRole?.name || matchedPreset?.name || 'Agent';
    if (existingNames.has(finalName)) {
      let suffix = 2;
      while (existingNames.has(`${finalName} (${suffix})`)) suffix += 1;
      finalName = `${finalName} (${suffix})`;
    }

    const frame = this.deps.store.placeNodeNear(
      targetWs,
      targetFloorId,
      isCrossWorkspace ? null : (callerLoc?.node.frame ?? null),
      DEFAULT_TERMINAL_SIZE,
      'right'
    );
    const now = new Date().toISOString();
    const newTermId = newId();
    const newNode: CanvasNode = {
      id: newId(),
      frame,
      zIndex: 1,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: {
        kind: 'terminal',
        terminal: {
          id: newTermId,
          name: finalName,
          command: commandOverride ?? matchedPreset?.command ?? null,
          workingDirectory: dirOverride ?? floorDir,
          agentType: matchedPreset?.agentType ?? 'shell',
          presetId: matchedPreset?.id ?? null,
          roleId: matchedRole?.id ?? null,
          roleName: matchedRole?.name ?? null,
          isManager: false,
          inChatMode: matchedPreset?.startInChatMode ?? false,
          color: colorOverride ?? matchedRole?.color ?? matchedPreset?.color ?? '#30d158',
          icon: iconOverride ?? matchedRole?.icon ?? matchedPreset?.icon ?? 'terminal',
          accountName: 'Default',
          isUnloaded: false,
        },
      },
    };

    await this.deps.store.createNode(targetWs.id, newNode, targetFloorId);
    if (isCrossWorkspace) {
      await this.deps.store.connectAcrossWorkspaces(workspaceId, fromTerminalId, targetWs.id, newTermId);
    } else {
      await this.deps.store.connectNodes(workspaceId, fromTerminalId, newTermId);
    }

    // Band placement if requested or caller is inside a band on same floor
    const updatedWs = this.deps.store.getWorkspace(targetWs.id)!;
    const lvl = this.deps.store.getLevelContents(updatedWs, targetFloorId);
    if (bandName) {
      const targetBand = lvl.nodes.find(
        (n) => n.content.kind === 'band' && n.content.band.name.toLowerCase() === bandName.toLowerCase()
      );
      if (targetBand) {
        await this.deps.store.addTerminalToBand(targetWs.id, targetBand.id, newNode.id);
      }
    } else if (!isCrossWorkspace && callerLoc && sameFloor(callerLoc.floorId, targetFloorId)) {
      const callerBand = lvl.nodes.find(
        (n) => n.content.kind === 'band' && n.content.band.memberNodeIds.includes(callerLoc.node.id)
      );
      if (callerBand) {
        await this.deps.store.addTerminalToBand(workspaceId, callerBand.id, newNode.id);
      }
    }

    await this.deps.ensureTerminalSpawned(targetWs.id, newTermId);
    return {
      status: 200,
      body: isCrossWorkspace
        ? `Recruited "${finalName}" in workspace "${targetWs.name}" (address: ${finalName} @ ${targetWs.name}).`
        : `Recruited "${finalName}"${matchedRole ? ` with role "${matchedRole.name}"` : ''}.`,
    };
  }

  private async handleBand(
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };
    const action = String(json.action ?? '');
    const bandName = String(json.name ?? '').trim();

    if (action === 'create') {
      const agentNames = Array.isArray(json.agents) ? json.agents.map(String) : [];
      const withoutMe = json.withoutMe === true;
      const callerLoc = this.deps.store.findTerminal(ws, fromTerminalId);
      const floorId = callerLoc?.floorId ?? ws.activeFloorId;
      const nodeIds: string[] = [];

      if (agentNames.length === 0) {
        if (!withoutMe && callerLoc) nodeIds.push(callerLoc.node.id);
        for (const tid of this.deps.store.getConnectedTerminalIds(ws, fromTerminalId)) {
          const found = this.deps.store.findTerminal(ws, tid);
          if (found && sameFloor(found.floorId, floorId)) nodeIds.push(found.node.id);
        }
      } else {
        if (!withoutMe && callerLoc) nodeIds.push(callerLoc.node.id);
        for (const an of agentNames) {
          const t = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, an);
          if (t) nodeIds.push(t.nodeId);
        }
      }

      if (nodeIds.length < 2) {
        return { status: 400, body: 'A band requires at least two terminals.' };
      }
      const created = await this.deps.store.createBand(workspaceId, nodeIds, bandName || 'Squad', floorId, {
        icon: json.icon ? String(json.icon) : undefined,
        color: json.color ? String(json.color) : undefined,
      });
      if (!created) return { status: 400, body: 'Could not create band.' };
      return { status: 200, body: `Created band "${bandName || 'Squad'}" with ${nodeIds.length} members.` };
    }

    const lvl = this.deps.store.getActiveLevelContents(ws);
    const bandNode = lvl.nodes.find(
      (n) => n.content.kind === 'band' && n.content.band.name.toLowerCase() === bandName.toLowerCase()
    );
    if (!bandNode) return { status: 404, body: `Band "${bandName}" not found` };

    if (action === 'add') {
      const agentName = String(json.agent ?? '');
      const t = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, agentName);
      if (!t) return { status: 404, body: `Agent "${agentName}" not found` };
      await this.deps.store.addTerminalToBand(workspaceId, bandNode.id, t.nodeId);
      return { status: 200, body: `Added "${t.terminal.name}" to band "${bandName}".` };
    }

    if (action === 'remove') {
      const agentName = String(json.agent ?? '');
      const t = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, agentName);
      if (!t) return { status: 404, body: `Agent "${agentName}" not found` };
      await this.deps.store.removeBandMember(workspaceId, bandNode.id, t.nodeId);
      return { status: 200, body: `Removed "${t.terminal.name}" from band "${bandName}".` };
    }

    if (action === 'dissolve') {
      await this.deps.store.dissolveBand(workspaceId, bandNode.id);
      return { status: 200, body: `Dissolved band "${bandName}".` };
    }

    return { status: 400, body: `Unknown band action: ${action}` };
  }

  private async handlePartitura(
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const command = String(json.command ?? 'list');
    const list = this.deps.store.listPartituras(workspaceId);
    if (command === 'list') {
      return { status: 200, body: list.map((p) => ({ id: p.id, name: p.name, summary: p.summary, nodes: p.nodes.length })) };
    }

    const name = String(json.name ?? '').trim();
    if (command === 'insert') {
      const part = list.find((p) => p.name.toLowerCase() === name.toLowerCase() || idsEqual(p.id, name));
      if (!part) return { status: 404, body: `Partitura "${name}" not found` };
      const spawned = await this.insertPartituraIntoWorkspace(workspaceId, fromTerminalId, part);
      return {
        status: 200,
        body: `Inserted partitura "${part.name}" (${spawned.length} agents: ${spawned.join(', ')}).`,
      };
    }

    if (command === 'create') {
      const ws = this.deps.store.getWorkspace(workspaceId);
      if (!ws) return { status: 404, body: 'Workspace not found' };
      const lvl = this.deps.store.getActiveLevelContents(ws);
      const saved = await this.deps.store.savePartitura({
        name: name || `${ws.name} Team`,
        summary: String(json.summary ?? `${lvl.nodes.length} nodes`),
        icon: String(json.icon ?? 'sparkles'),
        color: String(json.color ?? '#0a84ff'),
        workspaceId: json.global ? null : workspaceId,
        nodes: structuredClone(lvl.nodes),
        connections: structuredClone(lvl.connections),
        noteConnections: structuredClone(lvl.noteConnections),
        noteToNoteConnections: structuredClone(lvl.noteToNoteConnections),
        portalConnections: structuredClone(lvl.portalConnections),
        portalToPortalConnections: structuredClone(lvl.portalToPortalConnections),
        drawings: structuredClone(lvl.drawings),
        roles: this.deps.store.listRoles(workspaceId),
      });
      return { status: 200, body: `Saved partitura "${saved.name}".` };
    }

    if (command === 'delete') {
      const part = list.find((p) => p.name.toLowerCase() === name.toLowerCase() || idsEqual(p.id, name));
      if (!part) return { status: 404, body: `Partitura "${name}" not found` };
      await this.deps.store.deletePartitura(part.id);
      return { status: 200, body: `Deleted partitura "${part.name}".` };
    }

    return { status: 400, body: `Unknown partitura command: ${command}` };
  }

  async insertPartituraIntoWorkspace(
    workspaceId: string,
    callerTerminalId: string | null,
    partitura: Partitura
  ): Promise<string[]> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return [];
    const floorId = ws.activeFloorId;
    const level = this.deps.store.getLevelContents(ws, floorId);
    const maxX = level.nodes.reduce((m, n) => Math.max(m, n.frame.x + n.frame.width), 0);
    const offsetX = level.nodes.length > 0 ? maxX + 100 : 80;
    const minPartX = Math.min(...partitura.nodes.map((n) => n.frame.x), 0);
    const dx = offsetX - minPartX;

    const nodeIdMap = new Map<string, string>();
    const termIdMap = new Map<string, string>();
    const spawnedAgents: string[] = [];
    const managerIds: string[] = [];
    const allTermIds: string[] = [];
    const now = new Date().toISOString();

    for (const orig of partitura.nodes) {
      const nextNodeId = newId();
      nodeIdMap.set(orig.id, nextNodeId);
      const clone: CanvasNode = {
        ...structuredClone(orig),
        id: nextNodeId,
        frame: { ...orig.frame, x: orig.frame.x + dx },
        createdAt: now,
        lastModifiedAt: now,
      };
      if (clone.content.kind === 'terminal') {
        const nextTermId = newId();
        termIdMap.set(clone.content.terminal.id, nextTermId);
        clone.content.terminal.id = nextTermId;
        clone.content.terminal.workingDirectory = ws.workingDirectory;
        spawnedAgents.push(clone.content.terminal.name);
        allTermIds.push(nextTermId);
        if (clone.content.terminal.isManager) managerIds.push(nextTermId);
      }
      await this.deps.store.createNode(workspaceId, clone, floorId);
    }

    for (const c of partitura.connections) {
      const a = termIdMap.get(c.terminalIdA) ?? nodeIdMap.get(c.terminalIdA);
      const b = termIdMap.get(c.terminalIdB) ?? nodeIdMap.get(c.terminalIdB);
      if (a && b) await this.deps.store.connectNodes(workspaceId, a, b);
    }
    for (const c of partitura.noteConnections) {
      const t = termIdMap.get(c.terminalId);
      const n = nodeIdMap.get(c.noteNodeId);
      if (t && n) await this.deps.store.connectNodes(workspaceId, t, n);
    }
    for (const c of partitura.noteToNoteConnections) {
      const a = nodeIdMap.get(c.noteNodeIdA);
      const b = nodeIdMap.get(c.noteNodeIdB);
      if (a && b) await this.deps.store.connectNodes(workspaceId, a, b);
    }

    if (callerTerminalId) {
      const connectTargets = managerIds.length > 0 ? managerIds : allTermIds;
      for (const tid of connectTargets) {
        await this.deps.store.connectNodes(workspaceId, callerTerminalId, tid);
      }
    }

    for (const tid of allTermIds) {
      await this.deps.ensureTerminalSpawned(workspaceId, tid);
    }
    return spawnedAgents;
  }

  private async handleArrange(
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };
    const targetName = json.target ? String(json.target).trim() : '';
    const newName = json.newName ? String(json.newName).trim() : undefined;
    const icon = json.icon ? String(json.icon).trim() : undefined;
    const color = json.color ? String(json.color).trim() : undefined;

    if (!targetName) {
      const caller = this.deps.store.findTerminal(ws, fromTerminalId);
      return {
        status: 200,
        body: `Current terminal: ${caller?.terminal.name ?? 'Unknown'} (icon=${caller?.terminal.icon}, color=${caller?.terminal.color})`,
      };
    }

    const t = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, targetName);
    if (t) {
      await this.deps.store.updateTerminalData(workspaceId, t.terminalId, {
        ...(newName ? { name: newName } : {}),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
      });
      return { status: 200, body: `Updated "${newName || t.terminal.name}".` };
    }

    const note = this.deps.store.resolveTargetNote(ws, fromTerminalId, targetName);
    if (note) {
      const chosenColor = STICKY_COLORS.find((c) => c === color) ?? note.stickyNote.color;
      await this.deps.store.patchNode(workspaceId, note.node.id, {
        content: {
          kind: 'stickyNote',
          stickyNote: {
            ...note.stickyNote,
            customName: newName ?? note.stickyNote.customName,
            color: chosenColor,
          },
        },
      });
      return { status: 200, body: `Updated note "${newName || targetName}".` };
    }

    return { status: 404, body: `Target "${targetName}" not found` };
  }

  private async handleNotes(
    method: string,
    pathname: string,
    reqUrl: URL,
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };

    if (method === 'GET' && pathname === '/note/read') {
      const name = (reqUrl.searchParams.get('name') || '').trim();
      const offset = reqUrl.searchParams.get('offset');
      const limit = reqUrl.searchParams.get('limit');
      const resolved = this.deps.store.resolveTargetNote(ws, fromTerminalId, name);
      if (!resolved) return { status: 404, body: `Note "${name}" not found` };
      if (!resolved.accessible) return { status: 403, body: `No connection to note "${name}"` };
      const lines = resolved.stickyNote.text.split(/\r?\n/);
      if (!offset && !limit) {
        return {
          status: 200,
          body: `[${lines.length} lines total]\n${lines.map((l, i) => `${i + 1}\t${l}`).join('\n')}`,
        };
      }
      const start = Math.max(0, (Number(offset ?? 1) || 1) - 1);
      const count = Number(limit ?? lines.length) || lines.length;
      const slice = lines.slice(start, start + count);
      return {
        status: 200,
        body: `[lines ${start + 1}-${start + slice.length} of ${lines.length}]\n${slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n')}`,
      };
    }

    if (method === 'POST' && pathname === '/note/create') {
      const content = String(json.content ?? '');
      const name = json.name ? String(json.name) : null;
      const color = STICKY_COLORS.find((c) => c === json.color) as NoteColor | undefined;
      const stackName = typeof json.stackName === 'string' ? json.stackName : json.stack === true ? 'Fichário' : null;
      const created = await this.deps.store.createNoteAndConnect(
        workspaceId,
        fromTerminalId,
        content,
        name,
        color,
        stackName
      );
      const base = displayNameForNoteFile(created.fileName);
      return { status: 200, body: `Created note "${base}"${created.stackNode ? ` in fichário "${stackName}"` : ''}.` };
    }

    if (method === 'POST' && pathname === '/note/write') {
      const name = String(json.name ?? '');
      const content = String(json.content ?? '');
      const resolved = this.deps.store.resolveTargetNote(ws, fromTerminalId, name);
      if (!resolved) return { status: 404, body: `Note "${name}" not found` };
      if (!resolved.accessible) return { status: 403, body: `No connection to note "${name}"` };
      const res = await this.deps.store.updateNoteText(workspaceId, resolved.node.id, content);
      return {
        status: 200,
        body: res.renamedTo ? `Updated note (renamed to "${res.renamedTo}").` : `Updated note "${name}".`,
      };
    }

    if (method === 'POST' && pathname === '/note/edit') {
      const name = String(json.name ?? '');
      const oldText = String(json.oldText ?? '');
      const newText = String(json.newText ?? '');
      const resolved = this.deps.store.resolveTargetNote(ws, fromTerminalId, name);
      if (!resolved) return { status: 404, body: `Note "${name}" not found` };
      if (!resolved.accessible) return { status: 403, body: `No connection to note "${name}"` };
      if (!resolved.stickyNote.text.includes(oldText)) {
        return { status: 400, body: `Target text not found in note "${name}".` };
      }
      const next = resolved.stickyNote.text.replace(oldText, newText);
      const res = await this.deps.store.updateNoteText(workspaceId, resolved.node.id, next);
      return {
        status: 200,
        body: res.renamedTo ? `Edited note (renamed to "${res.renamedTo}").` : `Edited note "${name}".`,
      };
    }

    if (method === 'POST' && pathname === '/note/stack') {
      const name = String(json.name ?? '');
      const stackName = json.stackName ? String(json.stackName) : 'Fichário';
      const resolved = this.deps.store.resolveTargetNote(ws, fromTerminalId, name);
      if (!resolved) return { status: 404, body: `Note "${name}" not found` };
      await this.deps.store.fileNoteIntoStack(workspaceId, resolved.node.id, stackName);
      return { status: 200, body: `Filed "${name}" into "${stackName}".` };
    }

    if (method === 'POST' && pathname === '/note/unstack') {
      const name = String(json.name ?? '');
      const resolved = this.deps.store.resolveTargetNote(ws, fromTerminalId, name);
      if (!resolved) return { status: 404, body: `Note "${name}" not found` };
      await this.deps.store.unstackNote(workspaceId, resolved.node.id);
      return { status: 200, body: `Unstacked "${name}".` };
    }

    if (method === 'POST' && pathname === '/note/delete') {
      const name = String(json.name ?? '');
      const resolved = this.deps.store.resolveTargetNote(ws, fromTerminalId, name);
      if (!resolved) return { status: 404, body: `Note "${name}" not found` };
      await this.deps.store.deleteNodes(workspaceId, [resolved.node.id]);
      return { status: 200, body: `Deleted note "${name}".` };
    }

    return { status: 404, body: `Unknown note route: ${pathname}` };
  }

  private async handleRoles(
    method: string,
    pathname: string,
    reqUrl: URL,
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    if (method === 'GET' && pathname === '/role/list') {
      const roles = this.deps.store.listRoles(workspaceId);
      return {
        status: 200,
        body: roles.map((r) => ({
          id: r.id,
          name: r.name,
          scope: r.scope,
          preview: truncate(r.prompt.replace(/\s+/g, ' '), 90),
        })),
      };
    }

    if (method === 'GET' && pathname === '/role/show') {
      const name = (reqUrl.searchParams.get('name') || '').trim();
      const role = this.deps.store.getRole(name, workspaceId);
      if (!role) return { status: 404, body: `Role "${name}" not found` };
      return { status: 200, body: role };
    }

    if (method === 'POST' && pathname === '/role/create') {
      const name = String(json.name ?? '').trim();
      const prompt = String(json.prompt ?? '');
      const scope = json.scope === 'global' ? 'global' : 'current';
      if (!name) return { status: 400, body: 'Missing role name' };
      const role = await this.deps.store.createRole({ name, prompt, scope, workspaceId });
      return { status: 200, body: `Created ${role.scope} role "${role.name}".` };
    }

    if (method === 'POST' && pathname === '/role/write') {
      const name = String(json.name ?? '').trim();
      const role = this.deps.store.getRole(name, workspaceId);
      if (!role) return { status: 404, body: `Role "${name}" not found` };
      await this.deps.store.updateRole(role.id, { prompt: String(json.prompt ?? '') });
      return { status: 200, body: `Updated role "${role.name}".` };
    }

    if (method === 'POST' && pathname === '/role/edit') {
      const name = String(json.name ?? '').trim();
      const role = this.deps.store.getRole(name, workspaceId);
      if (!role) return { status: 404, body: `Role "${name}" not found` };
      const patch: Partial<typeof role> = {};
      if (json.oldText !== undefined && json.newText !== undefined) {
        patch.prompt = role.prompt.replace(String(json.oldText), String(json.newText));
      }
      if (json.scope === 'global' || json.scope === 'current') {
        patch.scope = json.scope;
        patch.workspaceId = json.scope === 'global' ? null : workspaceId;
      }
      await this.deps.store.updateRole(role.id, patch);
      return { status: 200, body: `Updated role "${role.name}".` };
    }

    if (method === 'POST' && pathname === '/role/assign') {
      const recruitName = String(json.recruit ?? '').trim();
      const roleName = json.role ? String(json.role).trim() : null;
      const ws = this.deps.store.getWorkspace(workspaceId)!;
      const target = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, recruitName);
      if (!target) return { status: 404, body: `Teammate "${recruitName}" not found` };
      const role = roleName ? this.deps.store.getRole(roleName, workspaceId) : null;
      if (roleName && !role) return { status: 404, body: `Role "${roleName}" not found` };
      await this.deps.store.updateTerminalData(workspaceId, target.terminalId, {
        roleId: role?.id ?? null,
        roleName: role?.name ?? null,
      });
      this.deps.ptyManager.kill(target.terminalId);
      await this.deps.ensureTerminalSpawned(workspaceId, target.terminalId);
      return {
        status: 200,
        body: role
          ? `Assigned role "${role.name}" to "${target.terminal.name}".`
          : `Cleared role on "${target.terminal.name}".`,
      };
    }

    return { status: 404, body: `Unknown role route: ${pathname}` };
  }

  private async handlePresets(
    method: string,
    pathname: string,
    reqUrl: URL,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const prefs = this.deps.store.getPreferences();
    if (method === 'GET' && pathname === '/preset/list') {
      return {
        status: 200,
        body: prefs.agentPresets.map((p) => ({
          id: p.id,
          name: p.name,
          command: p.command,
          maestroMode: p.maestroMode,
          startInChatMode: p.startInChatMode,
          showInQuickStart: p.showInQuickStart,
        })),
      };
    }

    if (method === 'GET' && pathname === '/preset/show') {
      const name = (reqUrl.searchParams.get('name') || '').trim();
      const found = prefs.agentPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!found) return { status: 404, body: `Preset "${name}" not found` };
      return { status: 200, body: found };
    }

    if (method === 'POST' && pathname === '/preset/edit') {
      const action = String(json.action ?? 'create');
      const name = String(json.name ?? '').trim();
      if (action === 'create') {
        const preset: AgentPreset = {
          id: newId(),
          name,
          command: String(json.command ?? ''),
          agentType: 'custom',
          icon: String(json.icon ?? 'terminal'),
          color: String(json.color ?? '#0a84ff'),
          isActive: true,
          maestroMode: json.maestro === true,
          startInChatMode: json.chat === true,
          showInQuickStart: json.quickStart !== false,
          account: String(json.account ?? 'Default'),
        };
        await this.deps.store.setPreferences({ agentPresets: [...prefs.agentPresets, preset] });
        return { status: 200, body: preset };
      }
      if (action === 'delete') {
        await this.deps.store.setPreferences({
          agentPresets: prefs.agentPresets.filter((p) => p.name.toLowerCase() !== name.toLowerCase()),
        });
        return { status: 200, body: `Deleted preset "${name}".` };
      }
      const next = prefs.agentPresets.map((p) => {
        if (p.name.toLowerCase() !== name.toLowerCase()) return p;
        return {
          ...p,
          ...(json.newName ? { name: String(json.newName) } : {}),
          ...(json.command !== undefined ? { command: String(json.command) } : {}),
          ...(json.maestro !== undefined ? { maestroMode: Boolean(json.maestro) } : {}),
          ...(json.chat !== undefined ? { startInChatMode: Boolean(json.chat) } : {}),
          ...(json.quickStart !== undefined ? { showInQuickStart: Boolean(json.quickStart) } : {}),
        };
      });
      await this.deps.store.setPreferences({ agentPresets: next });
      return { status: 200, body: `Updated preset "${name}".` };
    }

    return { status: 404, body: `Unknown preset route: ${pathname}` };
  }

  private async handleFloors(
    method: string,
    pathname: string,
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };

    if (method === 'GET' && pathname === '/floor/list') {
      return {
        status: 200,
        body: [
          {
            id: null,
            name: 'Ground',
            branch: null,
            path: ws.workingDirectory,
            nodeCount: ws.nodes.length,
            status: ws.groundStatus,
            active: ws.activeFloorId === null,
          },
          ...ws.floors.map((f) => ({
            id: f.id,
            name: f.name,
            branch: f.branchName,
            path: f.clonePath || ws.workingDirectory,
            nodeCount: f.nodes.length,
            status: f.status,
            active: idsEqual(ws.activeFloorId, f.id),
          })),
        ],
      };
    }

    if (method === 'POST' && pathname === '/floor/create') {
      const res = await this.deps.store.createFloor(workspaceId, {
        name: String(json.name ?? 'New Floor'),
        branchName: json.branch ? String(json.branch) : undefined,
        existingBranch: json.existingBranch === true,
        noGit: json.noGit === true,
        copyGround: json.copyGround === true,
        workingDirOverride: json.dir ? String(json.dir) : undefined,
      });
      if (!res.ok) return { status: 400, body: res.error };
      if (this.deps.onFloorCreated) {
        await this.deps.onFloorCreated(workspaceId, res.floor.id);
      }
      return {
        status: 200,
        body: `Created floor "${res.floor.name}"${res.floor.branchName ? ` (branch: ${res.floor.branchName})` : ''}.`,
      };
    }

    if (method === 'POST' && pathname === '/floor/status') {
      const caller = this.deps.store.findTerminal(ws, fromTerminalId);
      const floorName = json.floor ? String(json.floor).trim() : null;
      let targetFloorId: string | null = caller?.floorId ?? null;
      if (floorName) {
        if (floorName.toLowerCase() === 'ground') targetFloorId = null;
        else {
          const found = ws.floors.find((f) => f.name.toLowerCase() === floorName.toLowerCase());
          if (!found) return { status: 404, body: `Floor "${floorName}" not found` };
          targetFloorId = found.id;
        }
      }

      if (json.clear === true) {
        await this.deps.store.setFloorStatus(workspaceId, targetFloorId, null);
        return { status: 200, body: 'Cleared floor status.' };
      }

      const state = (json.state as FloorStatusState | undefined) ?? 'working';
      const text = String(json.text ?? '').trim();
      const progress = typeof json.progress === 'number' ? json.progress : undefined;
      if (!text) {
        const cur =
          targetFloorId === null
            ? ws.groundStatus
            : ws.floors.find((f) => idsEqual(f.id, targetFloorId))?.status ?? null;
        return { status: 200, body: cur ?? { state: 'none', text: '' } };
      }
      await this.deps.store.setFloorStatus(workspaceId, targetFloorId, {
        state,
        text: truncate(text, 120),
        progress,
        author: caller?.terminal.name,
      });
      if (state === 'blocked' || state === 'review' || state === 'done') {
        this.deps.notifyUser(`Floor Status (${state})`, text);
      }
      return { status: 200, body: `Floor status updated: [${state}] ${text}` };
    }

    if (method === 'POST' && pathname === '/floor/land') {
      const name = String(json.name ?? '').trim();
      const floor = ws.floors.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (!floor) return { status: 404, body: `Floor "${name}" not found` };
      const res = await this.deps.store.landFloor(workspaceId, floor.id, {
        intoBranch: json.into ? String(json.into) : undefined,
        deleteBranch: json.deleteBranch === true,
        keepFloor: json.keepFloor === true,
      });
      if (!res.ok) return { status: 400, body: res.error };
      return { status: 200, body: res.message };
    }

    if (method === 'POST' && pathname === '/floor/delete') {
      const name = String(json.name ?? '').trim();
      const floor = ws.floors.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (!floor) return { status: 404, body: `Floor "${name}" not found` };
      const { removedTerminalIds } = await this.deps.store.deleteFloor(
        workspaceId,
        floor.id,
        json.keepFolder !== true
      );
      for (const tid of removedTerminalIds) this.deps.ptyManager.kill(tid);
      return { status: 200, body: `Deleted floor "${floor.name}".` };
    }

    return { status: 404, body: `Unknown floor route: ${pathname}` };
  }

  private async handleWorkspaces(
    method: string,
    pathname: string,
    workspaceId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    if (method === 'GET' && pathname === '/workspace/list') {
      const list = this.deps.store.listWorkspaces().map((w) => ({
        id: w.id,
        name: w.name,
        dir: w.workingDirectory,
        floors: w.floors.length + 1,
        current: idsEqual(w.id, workspaceId),
      }));
      return { status: 200, body: list };
    }

    if (method === 'POST' && pathname === '/workspace/create') {
      const name = String(json.name ?? '').trim();
      const dir = String(json.dir ?? '').trim();
      if (!name || !dir) return { status: 400, body: 'Name and --dir are required' };
      const fromName = json.from ? String(json.from).trim() : null;
      const fromWs = fromName
        ? this.deps.store.listWorkspaces().find((w) => w.name.toLowerCase() === fromName.toLowerCase())
        : null;
      const created = await this.deps.store.createWorkspace({
        name,
        workingDirectory: dir,
        fromWorkspaceId: fromWs?.id,
        groupName: json.group ? String(json.group) : undefined,
        folderName: json.folder ? String(json.folder) : undefined,
      });
      return { status: 200, body: `Created workspace "${created.name}" at ${created.workingDirectory}.` };
    }

    if (method === 'POST' && pathname === '/workspace/rename') {
      const curName = String(json.currentName ?? '').trim();
      const nextName = String(json.newName ?? '').trim();
      const ws = this.deps.store
        .listWorkspaces()
        .find((w) => w.name.toLowerCase() === curName.toLowerCase());
      if (!ws) return { status: 404, body: `Workspace "${curName}" not found` };
      await this.deps.store.patchWorkspace(ws.id, { name: nextName });
      return { status: 200, body: `Renamed workspace "${curName}" → "${nextName}".` };
    }

    return { status: 404, body: `Unknown workspace route: ${pathname}` };
  }

  private async handlePortals(
    method: string,
    pathname: string,
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const ws = this.deps.store.getWorkspace(workspaceId);
    if (!ws) return { status: 404, body: 'Workspace not found' };

    if (method === 'POST' && pathname === '/portal/create') {
      const url = String(json.url ?? 'https://example.com');
      const name = String(json.name ?? 'Portal').trim() || 'Portal';
      const sizeParts = json.size ? String(json.size).split('x').map(Number) : null;
      const viewportSize =
        sizeParts && sizeParts.length === 2 && sizeParts.every((n) => Number.isFinite(n) && n > 0)
          ? { width: sizeParts[0], height: sizeParts[1] }
          : null;

      const caller = this.deps.store.findTerminal(ws, fromTerminalId);
      const floorId = caller?.floorId ?? ws.activeFloorId;
      const frame = this.deps.store.placeNodeNear(
        ws,
        floorId,
        caller?.node.frame ?? null,
        viewportSize
          ? { width: Math.max(360, viewportSize.width), height: Math.max(320, viewportSize.height + 52) }
          : DEFAULT_PORTAL_SIZE,
        'right'
      );
      const now = new Date().toISOString();
      const portalId = newId();
      const node: CanvasNode = {
        id: newId(),
        frame,
        zIndex: 1,
        groupId: null,
        createdAt: now,
        lastModifiedAt: now,
        content: {
          kind: 'portal',
          portal: {
            id: portalId,
            name,
            url,
            userAgentPreset: 'desktop',
            viewportSize,
          },
        },
      };
      await this.deps.store.createNode(workspaceId, node, floorId);
      await this.deps.store.connectNodes(workspaceId, fromTerminalId, node.id);
      return { status: 200, body: `Created portal "${name}" at ${url}.` };
    }

    const portalName = String(json.name ?? '').trim();
    const portalNode = this.deps.store
      .allNodes(ws)
      .find(
        (n) =>
          n.content.kind === 'portal' &&
          (idsEqual(n.id, portalName) ||
            idsEqual(n.content.portal.id, portalName) ||
            (n.content.portal.name || 'Portal').toLowerCase() === portalName.toLowerCase())
      );

    if (!portalNode || portalNode.content.kind !== 'portal') {
      return { status: 404, body: `Portal "${portalName}" not found` };
    }

    if (method === 'POST' && pathname === '/portal/edit') {
      const nextUrl = String(json.url ?? portalNode.content.portal.url);
      await this.deps.store.patchNode(workspaceId, portalNode.id, {
        content: { kind: 'portal', portal: { ...portalNode.content.portal, url: nextUrl } },
      });
      await this.deps.portalBridge.executeAction(portalNode.content.portal.id, 'navigate', {
        url: nextUrl,
      });
      return { status: 200, body: `Updated portal "${portalName}" to ${nextUrl}.` };
    }

    if (method === 'POST' && pathname === '/portal/close') {
      await this.deps.store.deleteNodes(workspaceId, [portalNode.id]);
      this.deps.portalBridge.unregister(portalNode.content.portal.id);
      return { status: 200, body: `Closed portal "${portalName}".` };
    }

    if (method === 'POST' && pathname === '/portal/action') {
      const action = String(json.action ?? 'snapshot');
      if (action === 'resize') {
        const w = Number(json.width ?? 1280);
        const h = Number(json.height ?? 720);
        await this.deps.store.patchNode(workspaceId, portalNode.id, {
          frame: { ...portalNode.frame, width: w, height: h + 52 },
          content: {
            kind: 'portal',
            portal: { ...portalNode.content.portal, viewportSize: { width: w, height: h } },
          },
        });
        return { status: 200, body: `viewport: ${w}x${h}` };
      }
      if (action === 'ua' || action === 'useragent') {
        const preset = json.value ? String(json.value) : '';
        if (preset && PORTAL_UA_PRESETS[preset]) {
          await this.deps.store.patchNode(workspaceId, portalNode.id, {
            content: {
              kind: 'portal',
              portal: { ...portalNode.content.portal, userAgentPreset: preset },
            },
          });
        }
      }
      const res = await this.deps.portalBridge.executeAction(
        portalNode.content.portal.id,
        action,
        json
      );
      return { status: res.ok ? 200 : 400, body: res.result };
    }

    return { status: 404, body: `Unknown portal route: ${pathname}` };
  }

  private async handleRoutines(
    method: string,
    pathname: string,
    reqUrl: URL,
    workspaceId: string,
    fromTerminalId: string,
    json: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const list = this.deps.routineScheduler.list(workspaceId);
    if (method === 'GET' && pathname === '/routine/list') {
      return { status: 200, body: list };
    }
    if (method === 'GET' && pathname === '/routine/show') {
      const name = (reqUrl.searchParams.get('name') || '').trim();
      const r = list.find((x) => x.name.toLowerCase() === name.toLowerCase() || idsEqual(x.id, name));
      if (!r) return { status: 404, body: `Routine "${name}" not found` };
      return { status: 200, body: r };
    }
    if (method === 'POST' && pathname === '/routine/create') {
      const ws = this.deps.store.getWorkspace(workspaceId)!;
      let targetTerminalId: string | null = fromTerminalId;
      if (json.reminder === true) {
        targetTerminalId = null;
      } else if (json.terminal) {
        const resolved = this.deps.store.resolveTargetTerminal(ws, fromTerminalId, String(json.terminal));
        if (!resolved) return { status: 404, body: `Terminal "${json.terminal}" not found` };
        targetTerminalId = resolved.terminalId;
      }
      const routine = await this.deps.routineScheduler.create({
        workspaceId,
        name: String(json.name ?? 'Routine'),
        command: String(json.command ?? ''),
        schedule: json.schedule as RoutineSchedule,
        targetTerminalId,
        isReminder: json.reminder === true,
        preRunScript: json.preRun ? String(json.preRun) : null,
        skipIfBusy: json.noSkipIfBusy !== true,
        notify: json.noNotify !== true,
        enabled: json.disabled !== true,
        maxCount: typeof json.count === 'number' ? json.count : null,
        untilDate: json.until ? String(json.until) : null,
      });
      return { status: 200, body: `Created routine "${routine.name}" (next fire: ${routine.nextFireAt ?? 'n/a'}).` };
    }

    const target = String(json.target ?? '').trim();
    const found = list.find(
      (r) =>
        (json.id && r.id.toLowerCase().startsWith(String(json.id).toLowerCase())) ||
        r.name.toLowerCase() === target.toLowerCase()
    );
    if (!found) return { status: 404, body: `Routine "${target}" not found` };

    if (method === 'POST' && pathname === '/routine/toggle') {
      await this.deps.routineScheduler.setEnabled(found.id, Boolean(json.enabled));
      return { status: 200, body: `${json.enabled ? 'Enabled' : 'Disabled'} routine "${found.name}".` };
    }
    if (method === 'POST' && pathname === '/routine/run') {
      const r = await this.deps.routineScheduler.runNow(found.id);
      return { status: r.ok ? 200 : 400, body: r.status };
    }
    if (method === 'POST' && pathname === '/routine/delete') {
      await this.deps.routineScheduler.delete(found.id);
      return { status: 200, body: `Deleted routine "${found.name}".` };
    }
    if (method === 'POST' && pathname === '/routine/edit') {
      await this.deps.routineScheduler.update(found.id, json as Partial<typeof found>);
      return { status: 200, body: `Updated routine "${found.name}".` };
    }
    return { status: 404, body: `Unknown routine route: ${pathname}` };
  }
}
