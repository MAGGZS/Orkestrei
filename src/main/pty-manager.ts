import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as ptyTypes from 'node-pty';
import type { Terminal as HeadlessXtermType } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import type { RolePreset, TerminalActivityState, TerminalData } from '../shared/types';
import { AttentionTracker, type AttentionTransitionEvent } from './attention-detector';
import { ensureDir } from './utils';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof ptyTypes;
const { Terminal: HeadlessXterm } = require('@xterm/headless') as {
  Terminal: typeof HeadlessXtermType;
};
const { SerializeAddon } = require('@xterm/addon-serialize') as {
  SerializeAddon: typeof SerializeAddonType;
};

export class HeadlessTerminal {
  cols: number;
  rows: number;
  scrollback: number;
  lastByteAtMs: number | null = null;
  private term: HeadlessXtermType;
  private serializeAddon: SerializeAddonType;
  private disposed = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: { cols?: number; rows?: number; scrollback?: number } = {}) {
    this.cols = opts.cols ?? 100;
    this.rows = opts.rows ?? 30;
    this.scrollback = opts.scrollback ?? 5000;
    this.term = new HeadlessXterm({
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
      convertEol: false,
    });
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.serializeAddon);
  }

  feed(data: string): void {
    if (this.disposed || !data) return;
    this.lastByteAtMs = Date.now();
    this.writeChain = this.writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (this.disposed) {
              resolve();
              return;
            }
            this.term.write(data, () => resolve());
          })
      )
      .catch(() => undefined);
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const chain = this.writeChain;
      await chain;
      if (this.writeChain === chain) return;
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.cols = Math.max(10, cols);
    this.rows = Math.max(4, rows);
    this.term.resize(this.cols, this.rows);
  }

  get bracketedPasteMode(): boolean {
    if (this.disposed) return false;
    return this.term.modes.bracketedPasteMode;
  }

  serializeLive(): string {
    if (this.disposed) return '';
    try {
      return this.serializeAddon.serialize({ excludeModes: true });
    } catch {
      return this.getPlainText();
    }
  }

  getScrollbackLines(): string[] {
    if (this.disposed) return [];
    try {
      const active = this.term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < active.length; i++) {
        const line = active.getLine(i);
        if (!line) break;
        lines.push(line.translateToString(true).replace(/\0/g, ' '));
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines;
    } catch {
      return [];
    }
  }

  getVisibleLines(): string[] {
    if (this.disposed) return [];
    try {
      const active = this.term.buffer.active;
      const start = Math.max(0, active.baseY);
      const end = Math.min(active.length, start + this.rows);
      const lines: string[] = [];
      for (let i = start; i < end; i++) {
        const line = active.getLine(i);
        if (!line) continue;
        lines.push(line.translateToString(true).replace(/\0/g, ' '));
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines;
    } catch {
      return [];
    }
  }

  getVisibleText(): string {
    const vis = this.getVisibleLines();
    if (vis.length > 0) return vis.join('\n');
    return this.getScrollbackLines().slice(-this.rows).join('\n');
  }

  getPlainText(): string {
    return this.getScrollbackLines().join('\n');
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.serializeAddon.dispose();
    } catch {
      // ignore
    }
    try {
      this.term.dispose();
    } catch {
      // ignore
    }
  }
}

interface PtyEntry {
  terminalId: string;
  workspaceId: string;
  proc: ptyTypes.IPty;
  headless: HeadlessTerminal;
  status: 'starting' | 'running' | 'exited';
  exitCode: number | null;
  cols: number;
  rows: number;
  lastOutputAt: number;
  cwd: string;
  pid: number;
  agentType: TerminalData['agentType'];
  command: string | null;
  spawnedAt: number;
  /** Claude Code session id injected via --session-id (exact transcript mapping). */
  claudeSessionId: string | null;
  bootReadyPromise: Promise<void>;
  cancelBoot: () => void;
}

export interface TokenTrackingTarget {
  terminalId: string;
  cwd: string;
  agentType: TerminalData['agentType'];
  command: string | null;
  spawnedAt: number;
  claudeSessionId: string | null;
  running: boolean;
}

export interface SpawnTerminalInput {
  workspaceId: string;
  workspaceName: string;
  workspaceDir: string;
  terminal: TerminalData;
  role: RolePreset | null;
  cols?: number;
  rows?: number;
}

export class PTYManager {
  private entries = new Map<string, PtyEntry>();
  private dataListeners = new Set<(event: { terminalId: string; data: string }) => void>();
  private exitListeners = new Set<(event: { terminalId: string; exitCode: number }) => void>();
  private statusListeners = new Set<
    (event: { terminalId: string; status: 'starting' | 'running' | 'exited' }) => void
  >();
  private activityListeners = new Set<(state: TerminalActivityState) => void>();
  private attentionTracker = new AttentionTracker();
  private pipeUrl = '';
  private authToken = '';
  private binDir = '';
  private activityTimer: NodeJS.Timeout | null = null;
  private lastActivityHash = '';

  constructor(binDir: string) {
    this.binDir = binDir;
    this.activityTimer = setInterval(() => this.broadcastActivityIfChanged(), 450);
  }

  setPipeUrl(url: string): void {
    this.pipeUrl = url;
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  getPipeUrl(): string {
    return this.pipeUrl;
  }

  private resolveShellExecutable(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const candidates = [
        'pwsh.exe',
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'powershell.exe',
        process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
      ];
      for (const cand of candidates) {
        if (cand.includes('\\')) {
          if (fs.existsSync(cand)) {
            return {
              file: cand,
              args: cand.toLowerCase().includes('powershell') || cand.toLowerCase().includes('pwsh')
                ? ['-NoLogo']
                : [],
            };
          }
        } else if (this.existsOnPath(cand)) {
          return { file: cand, args: ['-NoLogo'] };
        }
      }
      return { file: 'powershell.exe', args: ['-NoLogo'] };
    }
    const shell = process.env.SHELL || '/bin/bash';
    return { file: shell, args: ['-l'] };
  }

  private existsOnPath(exe: string): boolean {
    const pathVar = process.env.PATH || process.env.Path || '';
    for (const dir of pathVar.split(path.delimiter)) {
      const cleaned = dir.trim().replace(/^"|"$/g, '');
      if (cleaned && fs.existsSync(path.join(cleaned, exe))) {
        return true;
      }
    }
    return false;
  }

  private async prepareRoleDirectory(
    workspaceDir: string,
    role: RolePreset | null
  ): Promise<string | null> {
    if (!role) return null;
    try {
      const roleDir = path.join(workspaceDir, '.orkestrei', 'roles', role.id);
      await ensureDir(roleDir);
      const roleDoc = `# Role: ${role.name}\n\n<your_assigned_role>\n${role.prompt}\n</your_assigned_role>\n\nYou are running inside Orkestrei (spatial workspace).\nUse \`orkestrei list\` to discover connected agents, notes, and portals, and \`orkestrei ask "Name" "message"\` to collaborate.\n`;
      await fsp.writeFile(path.join(roleDir, 'ROLE.md'), roleDoc, 'utf8');
      await fsp.writeFile(path.join(roleDir, 'CLAUDE.md'), roleDoc, 'utf8');
      await fsp.writeFile(path.join(roleDir, 'AGENTS.md'), roleDoc, 'utf8');
      await fsp.writeFile(path.join(roleDir, 'GEMINI.md'), roleDoc, 'utf8');
      await ensureDir(path.join(roleDir, '.gemini'));
      await fsp.writeFile(path.join(roleDir, '.gemini', 'GEMINI.md'), roleDoc, 'utf8');
      return roleDir;
    } catch {
      return null;
    }
  }

  private quoteShellArg(value: string): string {
    if (process.platform === 'win32') {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private injectRoleIntoCommand(
    bootCmd: string,
    agentType: TerminalData['agentType'],
    role: RolePreset | null,
    roleDir: string | null
  ): string {
    if (!role || !roleDir) return bootCmd;
    const padded = ` ${bootCmd}`;

    if (/^claude(\.cmd|\.exe)?(\s|$)/i.test(bootCmd) || (agentType === 'claude' && /\bclaude\b/i.test(bootCmd))) {
      if (!/(\s)(--append-system-prompt|--append-system-prompt-file|--system-prompt|--system-prompt-file)(\s|=|$)/.test(padded)) {
        return `${bootCmd} --append-system-prompt-file ${this.quoteShellArg(path.join(roleDir, 'CLAUDE.md'))}`;
      }
      return bootCmd;
    }

    if (/^gemini(\.cmd|\.ps1|\.exe)?(\s|$)/i.test(bootCmd) || (agentType === 'gemini' && /\bgemini\b/i.test(bootCmd))) {
      if (!/(\s)--include-directories(\s|=|$)/.test(padded)) {
        return `${bootCmd} --include-directories ${this.quoteShellArg(roleDir)}`;
      }
      return bootCmd;
    }

    if (/^codex(\.cmd|\.exe)?(\s|$)/i.test(bootCmd) || (agentType === 'codex' && /\bcodex\b/i.test(bootCmd))) {
      if (!/(\s)(-c|--config)(\s+developer_instructions\b)/.test(padded)) {
        const agentsPath = path.join(roleDir, 'AGENTS.md');
        const singleLineRole = role.name.replace(/[\r\n]+/g, ' ').trim();
        return `${bootCmd} -c developer_instructions=${this.quoteShellArg(
          `Follow your assigned role instructions in ${agentsPath} (Role: ${singleLineRole}).`
        )}`;
      }
      return bootCmd;
    }

    if (/^agy(\.cmd|\.exe)?(\s|$)/i.test(bootCmd) || (agentType === 'antigravity' && /\bagy\b/i.test(bootCmd))) {
      if (!/(\s)--add-dir(\s|=|$)/.test(padded)) {
        return `${bootCmd} --add-dir ${this.quoteShellArg(roleDir)}`;
      }
      return bootCmd;
    }

    return bootCmd;
  }

  private scheduleBootReady(entry: PtyEntry, bootCmd: string | null): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    const spawnStart = Date.now();
    const promptRegex = /(?:PS\s+[^>]*>|^[A-Za-z]:\\[^>]*>|[#$%>❯➜])\s*$/;
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;
    let resolveFn: () => void = () => undefined;

    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolveFn();
    };

    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;

      const step = async () => {
        if (cancelled || entry.status !== 'running') {
          finish();
          return;
        }
        const elapsed = Date.now() - spawnStart;
        const lastByte = entry.headless.lastByteAtMs;
        const quietMs = lastByte !== null ? Date.now() - lastByte : 0;

        let ready = false;
        if (elapsed >= 3500) {
          ready = true;
        } else if (lastByte !== null && quietMs >= 140) {
          await entry.headless.whenIdle();
          if (cancelled || entry.status !== 'running') {
            finish();
            return;
          }
          const lines = entry.headless.getVisibleLines();
          const lastLine = lines[lines.length - 1] ?? '';
          if ((lines.length > 0 && promptRegex.test(lastLine)) || (lines.length > 0 && quietMs >= 450)) {
            ready = true;
          }
        }

        if (!ready) {
          timer = setTimeout(() => void step(), 60);
          return;
        }

        if (bootCmd && entry.status === 'running') {
          entry.proc.write(`${bootCmd}\r`);
          timer = setTimeout(() => finish(), 120);
        } else {
          finish();
        }
      };

      timer = setTimeout(() => void step(), 80);
    });

    return {
      promise,
      cancel: () => {
        cancelled = true;
        finish();
      },
    };
  }

  async waitForReady(terminalId: string, maxMs = 4500): Promise<void> {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    await Promise.race([
      entry.bootReadyPromise,
      new Promise<void>((resolve) => setTimeout(resolve, maxMs)),
    ]);
  }

  async spawn(input: SpawnTerminalInput): Promise<{ ok: boolean; pid?: number; error?: string }> {
    const { terminal, workspaceId, workspaceName, workspaceDir, role } = input;
    const cols = input.cols ?? 100;
    const rows = input.rows ?? 30;
    if (this.entries.has(terminal.id)) {
      this.resize(terminal.id, cols, rows);
      return { ok: true, pid: this.entries.get(terminal.id)!.pid };
    }
    const baseCwd = terminal.workingDirectory && fs.existsSync(terminal.workingDirectory)
      ? terminal.workingDirectory
      : fs.existsSync(workspaceDir)
        ? workspaceDir
        : os.homedir();

    const roleDir = await this.prepareRoleDirectory(baseCwd, role);

    const shell = this.resolveShellExecutable();
    const cliBin =
      process.platform === 'win32'
        ? path.join(this.binDir, 'orkestrei.cmd')
        : path.join(this.binDir, 'orkestrei');

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const currentPath = process.env[pathKey] ?? '';
    let nextPath = currentPath.includes(this.binDir)
      ? currentPath
      : `${this.binDir}${path.delimiter}${currentPath}`;
    if (process.platform === 'win32') {
      const agyBinDir = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin');
      if (fs.existsSync(agyBinDir) && !nextPath.toLowerCase().includes(agyBinDir.toLowerCase())) {
        nextPath = `${nextPath}${path.delimiter}${agyBinDir}`;
      }
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env[pathKey] = nextPath;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'Orkestrei';
    env.ORKESTREI_TERMINAL_ID = terminal.id;
    env.ORKESTREI_TERMINAL_NAME = terminal.name;
    env.ORKESTREI_WORKSPACE_ID = workspaceId;
    env.ORKESTREI_WORKSPACE_NAME = workspaceName;
    env.ORKESTREI_WORKSPACE_DIR = baseCwd;
    env.ORKESTREI_PIPE = this.pipeUrl;
    env.ORKESTREI_CLI = cliBin;
    if (this.authToken) {
      env.ORKESTREI_TOKEN = this.authToken;
    }
    if (role) {
      env.ORKESTREI_ROLE_NAME = role.name;
      env.ORKESTREI_ROLE_PROMPT = role.prompt;
      if (roleDir) {
        env.ORKESTREI_ROLE_DIR = roleDir;
        env.ORKESTREI_ROLE_FILE = path.join(roleDir, 'ROLE.md');
        const isOpenCode =
          terminal.agentType === 'opencode' ||
          Boolean(terminal.command && /^opencode(\.cmd|\.exe)?(\s|$)/i.test(terminal.command.trim()));
        if (isOpenCode) {
          let existingCfg: Record<string, unknown> = {};
          if (env.OPENCODE_CONFIG_CONTENT) {
            try {
              existingCfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
            } catch {
              existingCfg = {};
            }
          }
          const existingInstr = Array.isArray(existingCfg.instructions)
            ? existingCfg.instructions
            : [];
          env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
            ...existingCfg,
            instructions: [...existingInstr, path.join(roleDir, 'AGENTS.md')],
          });
        }
      }
    }

    try {
      const proc = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: baseCwd,
        env,
        useConpty: process.platform === 'win32',
      });

      const headless = new HeadlessTerminal({ cols, rows, scrollback: 5000 });
      const entry: PtyEntry = {
        terminalId: terminal.id,
        workspaceId,
        proc,
        headless,
        status: 'running',
        exitCode: null,
        cols,
        rows,
        lastOutputAt: Date.now(),
        cwd: baseCwd,
        pid: proc.pid,
        agentType: terminal.agentType,
        command: terminal.command,
        spawnedAt: Date.now(),
        claudeSessionId: null,
        bootReadyPromise: Promise.resolve(),
        cancelBoot: () => undefined,
      };
      this.entries.set(terminal.id, entry);
      this.emitStatus(terminal.id, 'running');

      proc.onData((data) => {
        if (!entry.pid && proc.pid) {
          entry.pid = proc.pid;
        }
        entry.lastOutputAt = Date.now();
        entry.headless.feed(data);
        for (const cb of this.dataListeners) {
          cb({ terminalId: terminal.id, data });
        }
      });

      proc.onExit(({ exitCode }) => {
        entry.status = 'exited';
        entry.exitCode = exitCode;
        entry.cancelBoot();
        this.attentionTracker.evaluate({
          terminalId: entry.terminalId,
          agentType: entry.agentType,
          visibleText: entry.headless.getVisibleText(),
          lastOutputAt: entry.lastOutputAt,
          running: false,
        });
        this.broadcastActivityIfChanged();
        this.emitStatus(terminal.id, 'exited');
        for (const cb of this.exitListeners) {
          cb({ terminalId: terminal.id, exitCode });
        }
      });

      let bootCmd: string | null = null;
      if (terminal.command && terminal.command.trim() !== '') {
        bootCmd = terminal.command.trim();
        // Pin Claude Code to a known session id so token usage maps to this exact terminal.
        if (
          /^claude(\.cmd|\.exe)?(\s|$)/i.test(bootCmd) &&
          !/(\s)(--session-id|--resume|-r|--continue|-c|-p|--print)(\s|=|$)/.test(` ${bootCmd}`)
        ) {
          const sid = randomUUID();
          entry.claudeSessionId = sid;
          bootCmd = `${bootCmd} --session-id ${sid}`;
        }
        bootCmd = this.injectRoleIntoCommand(bootCmd, terminal.agentType, role, roleDir);
      }

      const boot = this.scheduleBootReady(entry, bootCmd);
      entry.bootReadyPromise = boot.promise;
      entry.cancelBoot = boot.cancel;

      return { ok: true, pid: proc.pid };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  write(terminalId: string, data: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.status !== 'running') return;
    this.attentionTracker.noteInput(terminalId);
    entry.proc.write(data);
  }

  async deliverPrompt(terminalId: string, text: string): Promise<boolean> {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.status !== 'running') return false;
    this.attentionTracker.noteInput(terminalId);
    const cleaned = text.replace(/\r\n/g, '\n');
    if (entry.headless.bracketedPasteMode || cleaned.includes('\n')) {
      entry.proc.write(`\x1b[200~${cleaned}\x1b[201~`);
      await new Promise((r) => setTimeout(r, 75));
      entry.proc.write('\r');
    } else {
      entry.proc.write(`${cleaned}\r`);
    }
    return true;
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    const safeCols = Math.max(10, Math.floor(cols));
    const safeRows = Math.max(4, Math.floor(rows));
    if (entry.cols === safeCols && entry.rows === safeRows) return;
    entry.cols = safeCols;
    entry.rows = safeRows;
    entry.headless.resize(safeCols, safeRows);
    if (entry.status === 'running') {
      try {
        entry.proc.resize(safeCols, safeRows);
      } catch {
        // ignore pty resize race on exit
      }
    }
  }

  kill(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.entries.delete(terminalId);
    entry.status = 'exited';
    entry.cancelBoot();
    this.attentionTracker.remove(terminalId);
    const pid = entry.proc.pid || entry.pid;
    if (process.platform === 'win32' && pid > 0) {
      try {
        execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 2000,
        });
      } catch {
        // process tree may already have exited
      }
    } else if (pid > 0) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // process group may already have exited
      }
    }
    try {
      entry.proc.kill();
    } catch {
      // ignore
    }
    entry.headless.dispose();
  }

  async restart(input: SpawnTerminalInput): Promise<{ ok: boolean; pid?: number; error?: string }> {
    this.kill(input.terminal.id);
    return this.spawn(input);
  }

  has(terminalId: string): boolean {
    return this.entries.has(terminalId);
  }

  isRunning(terminalId: string): boolean {
    return this.entries.get(terminalId)?.status === 'running';
  }

  getStatus(terminalId: string): 'starting' | 'running' | 'exited' {
    return this.entries.get(terminalId)?.status ?? 'exited';
  }

  getLastOutputAt(terminalId: string): number {
    return this.entries.get(terminalId)?.lastOutputAt ?? 0;
  }

  getPid(terminalId: string): number | null {
    const entry = this.entries.get(terminalId);
    if (!entry) return null;
    return entry.proc.pid || entry.pid || null;
  }

  getEntryInfo(terminalId: string): {
    terminalId: string;
    pid: number | null;
    running: boolean;
    working: boolean;
    cwd: string;
    cols: number;
    rows: number;
    pipeEnv: string;
  } {
    const entry = this.entries.get(terminalId);
    const working = Boolean(
      entry && entry.status === 'running' && Date.now() - entry.lastOutputAt < 1800
    );
    return {
      terminalId,
      pid: entry ? entry.proc.pid || entry.pid || null : null,
      running: entry?.status === 'running',
      working,
      cwd: entry?.cwd ?? '',
      cols: entry?.cols ?? 100,
      rows: entry?.rows ?? 30,
      pipeEnv: this.pipeUrl,
    };
  }

  async getScrollback(terminalId: string): Promise<string> {
    const entry = this.entries.get(terminalId);
    if (!entry) return '';
    await entry.headless.whenIdle();
    return entry.headless.serializeLive();
  }

  async getVisibleText(terminalId: string): Promise<string> {
    const entry = this.entries.get(terminalId);
    if (!entry) return '';
    await entry.headless.whenIdle();
    return entry.headless.getVisibleText();
  }

  async getPlainText(terminalId: string): Promise<string> {
    const entry = this.entries.get(terminalId);
    if (!entry) return '';
    await entry.headless.whenIdle();
    return entry.headless.getPlainText();
  }

  getTokenTargets(): TokenTrackingTarget[] {
    return [...this.entries.values()].map((e) => ({
      terminalId: e.terminalId,
      cwd: e.cwd,
      agentType: e.agentType,
      command: e.command,
      spawnedAt: e.spawnedAt,
      claudeSessionId: e.claudeSessionId,
      running: e.status === 'running',
    }));
  }

  getActivityState(): TerminalActivityState {
    const now = Date.now();
    const active: string[] = [];
    const working: string[] = [];
    for (const [id, entry] of this.entries.entries()) {
      if (entry.status === 'running') {
        active.push(id);
        if (now - entry.lastOutputAt < 1800) {
          working.push(id);
        }
      }
    }
    return {
      active,
      attention: this.attentionTracker.getAttentionIds(),
      attentionReasons: this.attentionTracker.getAttentionReasons(),
      working,
      hasActiveWork: working.length > 0,
    };
  }

  private broadcastActivityIfChanged(): void {
    for (const [id, entry] of this.entries.entries()) {
      if (entry.status !== 'running') continue;
      this.attentionTracker.evaluate({
        terminalId: id,
        agentType: entry.agentType,
        visibleText: entry.headless.getVisibleText(),
        lastOutputAt: entry.lastOutputAt,
        running: true,
      });
    }
    const state = this.getActivityState();
    const hash = JSON.stringify(state);
    if (hash === this.lastActivityHash) return;
    this.lastActivityHash = hash;
    for (const cb of this.activityListeners) {
      cb(state);
    }
  }

  private emitStatus(terminalId: string, status: 'starting' | 'running' | 'exited'): void {
    for (const cb of this.statusListeners) {
      cb({ terminalId, status });
    }
  }

  onData(cb: (event: { terminalId: string; data: string }) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (event: { terminalId: string; exitCode: number }) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  onStatus(
    cb: (event: { terminalId: string; status: 'starting' | 'running' | 'exited' }) => void
  ): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onActivity(cb: (state: TerminalActivityState) => void): () => void {
    this.activityListeners.add(cb);
    return () => this.activityListeners.delete(cb);
  }

  onAttentionTransition(cb: (ev: AttentionTransitionEvent) => void): () => void {
    return this.attentionTracker.onTransition(cb);
  }

  terminateAll(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
    for (const id of [...this.entries.keys()]) {
      this.kill(id);
    }
    this.attentionTracker.clear();
  }
}
