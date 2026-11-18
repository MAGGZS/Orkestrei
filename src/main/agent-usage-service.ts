import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentUsageProviderId,
  AgentUsageProviderStatus,
  AgentUsageSnapshot,
} from '../shared/types';
import {
  parseAntigravityUsage,
  parseClaudeUsage,
  parseCodexUsage,
  resolveUsageProvider,
  type ParsedAgentUsage,
} from './agent-usage-parsers';
import type { TokenTrackingTarget } from './pty-manager';

export type { ParsedAgentUsage };

export interface AgentUsageTargetSource {
  getTokenTargets(): TokenTrackingTarget[];
}

export interface AgentUsageServiceOptions {
  /** Directory used for persistent per-provider caches such as CODEX_SQLITE_HOME. */
  cacheDir?: string;
  /** Interval in ms for checking active targets and due provider polls. */
  tickIntervalMs?: number;
  /** Minimum ms between automatic polls for the same provider. */
  minRequestGapMs?: number;
  /** Minimum ms between manual refreshes for the same provider. */
  manualMinGapMs?: number;
  /** Maximum concurrent CLI runs across all providers. */
  maxConcurrent?: number;
  /** Maximum exponential backoff delay in ms on consecutive failures. */
  maxBackoffMs?: number;
  /** Initial backoff base in ms on the first failure. */
  baseBackoffMs?: number;
  /** Per-provider poll interval overrides in ms. */
  pollIntervalMs?: Partial<Record<AgentUsageProviderId, number>>;
  /** Per-provider timeout overrides in ms. */
  timeoutsMs?: Partial<Record<AgentUsageProviderId, number>>;
  now?: () => number;
  /** Test seam to override CLI executable discovery. */
  resolveExecutable?: (
    providerId: AgentUsageProviderId,
    executableName: string
  ) => Promise<string | null>;
  /** Test seam to override CLI process execution. */
  runProvider?: (input: {
    providerId: AgentUsageProviderId;
    executablePath: string;
    env: Record<string, string>;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

interface ProviderDefinition {
  id: AgentUsageProviderId;
  name: string;
  executableName: string;
  args: string[];
  mode: 'stdio' | 'command';
  pollIntervalMs: number;
  timeoutMs: number;
  cacheSubdir?: string;
  parse: (raw: unknown) => ParsedAgentUsage;
}

interface ProviderRuntimeState {
  status: AgentUsageProviderStatus;
  failureCount: number;
  nextAutoPollAt: number;
  lastFinishedAt: number;
  lastManualAt: number;
}

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_MIN_REQUEST_GAP_MS = 60_000;
const DEFAULT_MANUAL_MIN_GAP_MS = 10_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_BASE_BACKOFF_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 2048;
const STDIO_EXIT_GRACE_MS = 200;
const CLAUDE_REQUEST_ID = 'orkestrei-usage';

const WINDOWS_MINIMAL_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'SSH_AUTH_SOCK',
] as const;

const POSIX_MINIMAL_ENV_KEYS = [
  'PATH',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SHELL',
  'SSH_AUTH_SOCK',
] as const;

const PROVIDERS: Record<AgentUsageProviderId, ProviderDefinition> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    executableName: 'claude',
    args: [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
    ],
    mode: 'stdio',
    pollIntervalMs: 300_000,
    timeoutMs: 30_000,
    parse: parseClaudeUsage,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    executableName: 'codex',
    args: ['app-server', '--stdio'],
    mode: 'stdio',
    pollIntervalMs: 300_000,
    timeoutMs: 60_000,
    cacheSubdir: 'codex',
    parse: parseCodexUsage,
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    executableName: 'agy',
    args: ['-p', '/usage', '--output-format', 'json'],
    mode: 'command',
    pollIntervalMs: 600_000,
    timeoutMs: 90_000,
    parse: parseAntigravityUsage,
  },
};

const PROVIDER_IDS: AgentUsageProviderId[] = ['claude', 'codex', 'antigravity'];

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'ProviderTimeoutError';
  }
}

class ProviderAbortedError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'ProviderAbortedError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && v !== undefined) return v;
  }
  return undefined;
}

function expandWindowsEnvRefs(raw: string, baseEnv: NodeJS.ProcessEnv): string {
  return raw.replace(/%([^%]+)%/g, (full, name: string) => {
    const val = getEnvCaseInsensitive(baseEnv, name);
    return val !== undefined ? val : full;
  });
}

function splitPathDirs(rawPath: string | undefined): string[] {
  if (!rawPath) return [];
  return rawPath
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function deduplicateDirs(dirs: string[], isWin: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    const normalized = path.normalize(cleaned);
    const key = isWin ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

async function readWindowsRegistryPathEntries(baseEnv: NodeJS.ProcessEnv): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ];
  const collected: string[] = [];
  for (const regKey of keys) {
    const stdout = await new Promise<string>((resolve) => {
      execFile(
        'reg',
        ['query', regKey, '/v', 'Path'],
        { windowsHide: true, timeout: 1500 },
        (err, out) => resolve(err ? '' : out)
      );
    });
    if (!stdout) continue;
    const match = stdout.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (match?.[1]) {
      const expanded = expandWindowsEnvRefs(match[1].trim(), baseEnv);
      collected.push(...splitPathDirs(expanded));
    }
  }
  return collected;
}

async function isRunnableBinary(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      return ext === '.exe' || ext === '.com';
    }
    await fsp.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a CLI binary directly from PATH and standard install directories without
 * falling back to shell script wrappers (.cmd, .bat, .ps1).
 */
export async function resolveCliExecutable(
  executableName: string,
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    checkRegistryOnWindows?: boolean;
  } = {}
): Promise<string | null> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? /\.(exe|com)$/i.test(executableName)
      ? [executableName]
      : [`${executableName}.exe`, `${executableName}.com`]
    : [executableName];

  const pathDirs = splitPathDirs(getEnvCaseInsensitive(env, 'PATH'));
  const usualDirs: string[] = isWin
    ? [
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, '.claude', 'local'),
        path.join(homeDir, '.bun', 'bin'),
        path.join(homeDir, '.volta', 'bin'),
        path.join(homeDir, '.cargo', 'bin'),
        ...(getEnvCaseInsensitive(env, 'LOCALAPPDATA')
          ? [
              path.join(getEnvCaseInsensitive(env, 'LOCALAPPDATA')!, 'Programs', 'OpenAI', 'Codex', 'bin'),
              path.join(getEnvCaseInsensitive(env, 'LOCALAPPDATA')!, 'agy', 'bin'),
            ]
          : []),
        ...(getEnvCaseInsensitive(env, 'APPDATA')
          ? [path.join(getEnvCaseInsensitive(env, 'APPDATA')!, 'npm')]
          : []),
        path.join(homeDir, 'bin'),
      ]
    : [
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, '.claude', 'local'),
        path.join(homeDir, '.bun', 'bin'),
        path.join(homeDir, '.volta', 'bin'),
        path.join(homeDir, '.npm-global', 'bin'),
        path.join(homeDir, '.cargo', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ];

  for (const dir of deduplicateDirs([...pathDirs, ...usualDirs], isWin)) {
    for (const file of candidates) {
      const full = path.join(dir, file);
      if (await isRunnableBinary(full)) return full;
    }
  }

  if (isWin && options.checkRegistryOnWindows !== false) {
    const regDirs = await readWindowsRegistryPathEntries(env);
    for (const dir of deduplicateDirs(regDirs, true)) {
      for (const file of candidates) {
        const full = path.join(dir, file);
        if (await isRunnableBinary(full)) return full;
      }
    }
  }

  return null;
}

/**
 * Construct the minimal environment whitelist for running agent CLIs cleanly
 * without leaking Orkestrei session tokens or nested-session markers.
 */
export function buildMinimalUsageEnv(
  executablePath: string,
  extraEnv: Record<string, string> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir()
): Record<string, string> {
  const isWin = process.platform === 'win32';
  const keys = isWin ? WINDOWS_MINIMAL_ENV_KEYS : POSIX_MINIMAL_ENV_KEYS;
  const out: Record<string, string> = {};

  for (const key of keys) {
    const val = getEnvCaseInsensitive(baseEnv, key);
    if (val !== undefined) out[key] = val;
  }

  out.HOME = homeDir;
  out.TERM = 'dumb';
  out.NO_COLOR = '1';
  if (!out.LANG) out.LANG = 'en_US.UTF-8';

  const execDir = path.dirname(executablePath);
  const currentPath = out.PATH ?? '';
  const pathEntries = splitPathDirs(currentPath);
  const hasExecDir = pathEntries.some((entry) =>
    isWin ? entry.toLowerCase() === execDir.toLowerCase() : entry === execDir
  );
  if (execDir && !hasExecDir) {
    out.PATH = currentPath ? `${execDir}${path.delimiter}${currentPath}` : execDir;
  }

  for (const [k, v] of Object.entries(extraEnv)) {
    out[k] = v;
  }
  return out;
}

/**
 * Terminate a spawned CLI process and any descendants it created.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 0) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile(
        'taskkill',
        ['/T', '/F', '/PID', String(pid)],
        { windowsHide: true, timeout: 2000 },
        () => resolve()
      );
    });
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      done();
    }, 1000);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function formatRpcError(errVal: unknown): string {
  const rec = asRecord(errVal);
  if (rec) {
    if (rec.code === -32601) return 'Update the CLI to see usage';
    if (rec.code === 'notSignedIn') return 'Not signed in';
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim();
  }
  if (typeof errVal === 'string' && errVal.trim()) return errVal.trim();
  return 'Provider request failed';
}

function createSpawnedChild(
  executablePath: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): ChildProcess {
  const child = spawn(executablePath, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.on('error', () => undefined);
  return child;
}

function attachBoundedStderr(child: ChildProcess): () => string {
  const chunks: Buffer[] = [];
  let bytes = 0;

  child.stderr?.on('data', (chunk: Buffer) => {
    if (bytes >= MAX_STDERR_BYTES) return;
    const remaining = MAX_STDERR_BYTES - bytes;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(slice);
    bytes += slice.length;
  });

  return () => {
    if (chunks.length === 0) return '';
    const text = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  };
}

function attachTimeoutAndAbort(
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
  onReject: (err: Error) => void
): () => void {
  const onAbort = () => {
    void killProcessTree(child);
    onReject(new ProviderAbortedError());
  };

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    void killProcessTree(child);
    onReject(new ProviderTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();

  return () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  };
}

export async function runCommandJson(input: {
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const child = createSpawnedChild(input.executablePath, input.args, input.cwd, input.env);
  const getStderr = attachBoundedStderr(child);
  child.stdin?.end();

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let cleanupGuard: () => void = () => undefined;

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupGuard();
      reject(err);
    };

    const finishResolve = (val: unknown) => {
      if (settled) return;
      settled = true;
      cleanupGuard();
      resolve(val);
    };

    cleanupGuard = attachTimeoutAndAbort(child, input.timeoutMs, input.signal, finishReject);

    child.on('error', (err) => {
      finishReject(err);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_LINE_BYTES) {
        void killProcessTree(child);
        finishReject(new Error('CLI output exceeded maximum allowed size'));
        return;
      }
      chunks.push(chunk);
    });

    child.on('close', (code) => {
      if (settled) return;
      const rawText = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      let parsed: unknown = null;
      let parseErr: Error | null = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parseErr = new Error('CLI returned invalid JSON');
        }
      }

      if (code !== 0) {
        // Preserve structured JSON errors when the CLI still returned a JSON envelope.
        if (parsed !== null) {
          finishResolve(parsed);
          return;
        }
        const stderr = getStderr();
        finishReject(
          new Error(
            stderr
              ? `CLI exited with code ${code ?? 'unknown'}: ${stderr}`
              : `CLI exited with code ${code ?? 'unknown'}`
          )
        );
        return;
      }

      if (!rawText) {
        finishReject(new Error('CLI returned empty output'));
        return;
      }
      if (parseErr) {
        finishReject(parseErr);
        return;
      }
      finishResolve(parsed);
    });
  });
}

export async function runStdioJsonExchange(input: {
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  exchange: (
    writeJson: (msg: Record<string, unknown>) => void,
    awaitJson: (predicate: (obj: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>
  ) => Promise<unknown>;
}): Promise<unknown> {
  const child = createSpawnedChild(input.executablePath, input.args, input.cwd, input.env);
  const getStderr = attachBoundedStderr(child);

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let streamClosed = false;
    let totalBytes = 0;
    let lineBuffer: Buffer = Buffer.alloc(0);
    const pendingObjects: Record<string, unknown>[] = [];
    let waiter: {
      predicate: (obj: Record<string, unknown>) => boolean;
      resolve: (obj: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    } | null = null;
    let cleanupGuard: () => void = () => undefined;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupGuard();
      if (waiter) {
        const activeWaiter = waiter;
        waiter = null;
        activeWaiter.reject(err);
      }
      reject(err);
    };

    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanupGuard();
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      const onPostAbort = () => {
        void killProcessTree(child);
      };
      input.signal.addEventListener('abort', onPostAbort, { once: true });
      const killTimer = setTimeout(() => {
        input.signal.removeEventListener('abort', onPostAbort);
        if (child.exitCode === null && child.signalCode === null) {
          void killProcessTree(child);
        }
      }, STDIO_EXIT_GRACE_MS);
      killTimer.unref?.();
      child.once('exit', () => {
        clearTimeout(killTimer);
        input.signal.removeEventListener('abort', onPostAbort);
      });
      resolve(value);
    };

    cleanupGuard = attachTimeoutAndAbort(child, input.timeoutMs, input.signal, fail);

    const dispatchLine = (lineBuf: Buffer) => {
      const text = lineBuf.toString('utf8').replace(/\r$/, '').trim();
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // Non-JSON stdout chatter is ignored per stdio provider contract.
      }
      const rec = asRecord(parsed);
      if (!rec) return;

      if (waiter && waiter.predicate(rec)) {
        const activeWaiter = waiter;
        waiter = null;
        activeWaiter.resolve(rec);
        return;
      }
      pendingObjects.push(rec);
    };

    child.on('error', (err) => {
      fail(err);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        void killProcessTree(child);
        fail(new Error('CLI stdout exceeded maximum total byte limit'));
        return;
      }

      lineBuffer = lineBuffer.length === 0 ? chunk : Buffer.concat([lineBuffer, chunk]);
      for (;;) {
        const nlIdx = lineBuffer.indexOf(0x0a);
        if (nlIdx === -1) break;
        const line = lineBuffer.subarray(0, nlIdx);
        lineBuffer = lineBuffer.subarray(nlIdx + 1);
        if (line.length > MAX_LINE_BYTES) {
          void killProcessTree(child);
          fail(new Error('CLI JSON line exceeded maximum size'));
          return;
        }
        dispatchLine(line);
        if (settled) return;
      }
      if (lineBuffer.length > MAX_LINE_BYTES) {
        void killProcessTree(child);
        fail(new Error('CLI JSON line exceeded maximum size'));
      }
    });

    child.on('close', (code) => {
      streamClosed = true;
      if (settled) return;
      if (lineBuffer.length > 0) {
        const tail = lineBuffer;
        lineBuffer = Buffer.alloc(0);
        dispatchLine(tail);
      }
      // Defer failure past pending microtasks so a final response at EOF without
      // a trailing newline can settle the exchange cleanly.
      setImmediate(() => {
        if (!settled) {
          const stderr = getStderr();
          fail(
            new Error(
              stderr
                ? `CLI closed stdio before completing exchange (exit ${code ?? 'unknown'}): ${stderr}`
                : `CLI closed stdio before completing exchange (exit ${code ?? 'unknown'})`
            )
          );
        }
      });
    });

    const writeJson = (msg: Record<string, unknown>) => {
      if (settled) return;
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };

    const awaitJson = (predicate: (obj: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < pendingObjects.length; i += 1) {
        if (predicate(pendingObjects[i])) {
          const [matched] = pendingObjects.splice(i, 1);
          return Promise.resolve(matched);
        }
      }
      if (settled || streamClosed) {
        return Promise.reject(new Error('Stdio stream already closed'));
      }
      return new Promise<Record<string, unknown>>((res, rej) => {
        waiter = { predicate, resolve: res, reject: rej };
      });
    };

    void input
      .exchange(writeJson, awaitJson)
      .then((res) => succeed(res))
      .catch((err) => {
        void killProcessTree(child);
        fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

async function runDefaultProvider(input: {
  providerId: AgentUsageProviderId;
  executablePath: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const spec = PROVIDERS[input.providerId];
  if (input.providerId === 'claude') {
    return runStdioJsonExchange({
      executablePath: input.executablePath,
      args: spec.args,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      exchange: async (writeJson, awaitJson) => {
        writeJson({
          type: 'control_request',
          request_id: CLAUDE_REQUEST_ID,
          request: { subtype: 'get_usage', skip_behaviors: true },
        });
        return awaitJson((obj) => {
          if (obj.type !== 'control_response') return false;
          const resp = asRecord(obj.response);
          return resp?.request_id === CLAUDE_REQUEST_ID;
        });
      },
    });
  }

  if (input.providerId === 'codex') {
    return runStdioJsonExchange({
      executablePath: input.executablePath,
      args: spec.args,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      exchange: async (writeJson, awaitJson) => {
        writeJson({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'orkestrei', title: 'Orkestrei', version: '1' },
          },
        });
        const initReply = await awaitJson((obj) => obj.id === 1);
        if (initReply.error !== undefined && initReply.error !== null) {
          throw new Error(formatRpcError(initReply.error));
        }
        if (initReply.result === undefined || initReply.result === null) {
          throw new Error('Codex initialize returned no result');
        }

        writeJson({ method: 'initialized' });
        writeJson({
          id: 2,
          method: 'account/rateLimits/read',
          params: { excludeResetCreditDetails: true },
        });
        const limitsReply = await awaitJson((obj) => obj.id === 2);
        if (limitsReply.error !== undefined && limitsReply.error !== null) {
          // Translate well-known JSON-RPC errors while passing full envelope on normal paths.
          const errRec = asRecord(limitsReply.error);
          if (errRec?.code === -32601 || errRec?.code === 'notSignedIn') {
            throw new Error(formatRpcError(limitsReply.error));
          }
        }
        return limitsReply;
      },
    });
  }

  return runCommandJson({
    executablePath: input.executablePath,
    args: spec.args,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

function cloneSnapshot(snapshot: AgentUsageSnapshot): AgentUsageSnapshot {
  const providers: AgentUsageSnapshot['providers'] = {};
  for (const [id, status] of Object.entries(snapshot.providers) as Array<
    [AgentUsageProviderId, AgentUsageProviderStatus | undefined]
  >) {
    if (!status) continue;
    providers[id] = {
      ...status,
      meters: status.meters.map((m) => ({
        ...m,
        windows: m.windows.map((w) => ({ ...w })),
      })),
    };
  }
  return {
    providers,
    byTerminal: { ...snapshot.byTerminal },
    updatedAt: snapshot.updatedAt,
  };
}

function stringMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Periodically polls usage quotas from all configured agent CLIs (`claude`, `codex`, `agy`),
 * mapping active terminal providers while respecting concurrency, throttling, and backoff limits.
 */
export class AgentUsageService {
  private targetSource: AgentUsageTargetSource;
  private cacheDir: string;
  private tickIntervalMs: number;
  private minRequestGapMs: number;
  private manualMinGapMs: number;
  private maxConcurrent: number;
  private baseBackoffMs: number;
  private maxBackoffMs: number;
  private pollIntervals: Record<AgentUsageProviderId, number>;
  private timeouts: Record<AgentUsageProviderId, number>;
  private now: () => number;
  private resolveExecFn: (
    providerId: AgentUsageProviderId,
    executableName: string
  ) => Promise<string | null>;
  private runProviderFn: (input: {
    providerId: AgentUsageProviderId;
    executablePath: string;
    env: Record<string, string>;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<unknown>;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private byTerminal: Record<string, AgentUsageProviderId> = {};
  private providerStates = new Map<AgentUsageProviderId, ProviderRuntimeState>();
  private inFlight = new Map<AgentUsageProviderId, Promise<void>>();
  private activeAborts = new Set<AbortController>();
  private listeners = new Set<(snapshot: AgentUsageSnapshot) => void>();
  private updatedAt: string;

  private activeRunCount = 0;
  private semaphoreQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(targetSource: AgentUsageTargetSource, options: AgentUsageServiceOptions = {}) {
    this.targetSource = targetSource;
    this.cacheDir = options.cacheDir ?? path.join(os.tmpdir(), 'orkestrei-usage-cache');
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.minRequestGapMs = options.minRequestGapMs ?? DEFAULT_MIN_REQUEST_GAP_MS;
    this.manualMinGapMs = options.manualMinGapMs ?? DEFAULT_MANUAL_MIN_GAP_MS;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.updatedAt = new Date(this.now()).toISOString();

    this.pollIntervals = {
      claude: options.pollIntervalMs?.claude ?? PROVIDERS.claude.pollIntervalMs,
      codex: options.pollIntervalMs?.codex ?? PROVIDERS.codex.pollIntervalMs,
      antigravity: options.pollIntervalMs?.antigravity ?? PROVIDERS.antigravity.pollIntervalMs,
    };
    this.timeouts = {
      claude: options.timeoutsMs?.claude ?? PROVIDERS.claude.timeoutMs,
      codex: options.timeoutsMs?.codex ?? PROVIDERS.codex.timeoutMs,
      antigravity: options.timeoutsMs?.antigravity ?? PROVIDERS.antigravity.timeoutMs,
    };

    this.resolveExecFn =
      options.resolveExecutable ?? ((_id, execName) => resolveCliExecutable(execName));
    this.runProviderFn = options.runProvider ?? runDefaultProvider;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.syncTargets();
    this.timer = setInterval(() => {
      this.syncTargets();
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const ac of this.activeAborts) {
      ac.abort();
    }
    this.activeAborts.clear();
    while (this.semaphoreQueue.length > 0) {
      const waiter = this.semaphoreQueue.shift();
      waiter?.reject(new ProviderAbortedError());
    }
    this.listeners.clear();
  }

  getSnapshot(): AgentUsageSnapshot {
    const providers: AgentUsageSnapshot['providers'] = {};
    for (const [id, state] of this.providerStates.entries()) {
      providers[id] = state.status;
    }
    return cloneSnapshot({
      providers,
      byTerminal: this.byTerminal,
      updatedAt: this.updatedAt,
    });
  }

  onChanged(cb: (snapshot: AgentUsageSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Re-evaluate active terminal -> provider mappings and trigger due automatic polls.
   */
  syncTargets(): void {
    if (this.stopped) return;
    const changed = this.refreshTargetMappings();
    if (changed) {
      this.emitChanged();
    }
    this.pollDueProviders();
  }

  /**
   * Trigger a manual usage refresh for one provider or all configured providers,
   * bypassing interval/backoff while preserving dedupe, 10s manual floor, and max concurrency.
   */
  async refresh(providerId?: AgentUsageProviderId): Promise<void> {
    if (this.stopped) return;
    if (providerId !== undefined && !PROVIDER_IDS.includes(providerId)) return;

    const changed = this.refreshTargetMappings();
    if (changed) {
      this.emitChanged();
    }

    const targets: AgentUsageProviderId[] = providerId ? [providerId] : [...PROVIDER_IDS];

    await Promise.all(targets.map((id) => this.scheduleProviderRun(id, true)));
  }

  private refreshTargetMappings(): boolean {
    const targets = this.targetSource.getTokenTargets();
    const nextByTerminal: Record<string, AgentUsageProviderId> = {};

    for (const target of targets) {
      const provider = resolveUsageProvider(target.agentType, target.command);
      if (!provider) continue;
      nextByTerminal[target.terminalId] = provider;
    }

    let changed = !stringMapsEqual(this.byTerminal, nextByTerminal);
    this.byTerminal = nextByTerminal;

    for (const id of PROVIDER_IDS) {
      if (!this.providerStates.has(id)) {
        this.ensureProviderState(id);
        changed = true;
      }
    }
    return changed;
  }

  private ensureProviderState(id: AgentUsageProviderId): ProviderRuntimeState {
    let state = this.providerStates.get(id);
    if (!state) {
      state = {
        status: {
          id,
          name: PROVIDERS[id].name,
          state: 'idle',
          plan: null,
          limitReached: false,
          meters: [],
          lastSuccessAt: null,
          executable: null,
        },
        failureCount: 0,
        nextAutoPollAt: 0,
        lastFinishedAt: 0,
        lastManualAt: 0,
      };
      this.providerStates.set(id, state);
    }
    return state;
  }

  private pollDueProviders(): void {
    const currentNow = this.now();
    for (const id of PROVIDER_IDS) {
      if (this.inFlight.has(id)) continue;
      const state = this.ensureProviderState(id);
      if (currentNow < state.nextAutoPollAt) continue;
      if (state.lastFinishedAt > 0 && currentNow - state.lastFinishedAt < this.minRequestGapMs) {
        continue;
      }
      void this.scheduleProviderRun(id, false);
    }
  }

  private scheduleProviderRun(id: AgentUsageProviderId, manual: boolean): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const state = this.ensureProviderState(id);
    const currentNow = this.now();
    if (manual) {
      if (state.lastManualAt > 0 && currentNow - state.lastManualAt < this.manualMinGapMs) {
        return Promise.resolve();
      }
      state.lastManualAt = currentNow;
    }

    let runPromise!: Promise<void>;
    const clearInFlight = () => {
      if (this.inFlight.get(id) === runPromise) {
        this.inFlight.delete(id);
      }
    };
    runPromise = this.executeProviderRun(id, clearInFlight).finally(clearInFlight);
    this.inFlight.set(id, runPromise);
    return runPromise;
  }

  private acquireSlot(): Promise<void> {
    if (this.stopped) return Promise.reject(new ProviderAbortedError());
    if (this.activeRunCount < this.maxConcurrent) {
      this.activeRunCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.semaphoreQueue.push({ resolve, reject });
    });
  }

  private releaseSlot(): void {
    this.activeRunCount = Math.max(0, this.activeRunCount - 1);
    while (this.semaphoreQueue.length > 0 && this.activeRunCount < this.maxConcurrent) {
      const next = this.semaphoreQueue.shift();
      if (!next) continue;
      if (this.stopped) {
        next.reject(new ProviderAbortedError());
        continue;
      }
      this.activeRunCount += 1;
      next.resolve();
    }
  }

  private async executeProviderRun(
    id: AgentUsageProviderId,
    clearInFlight: () => void
  ): Promise<void> {
    const spec = PROVIDERS[id];
    const state = this.ensureProviderState(id);

    let acquired = false;
    let tempCwd: string | null = null;
    let resolvedExecutable: string | null = state.status.executable;
    const ac = new AbortController();
    this.activeAborts.add(ac);

    type Outcome =
      | { kind: 'aborted' }
      | { kind: 'success'; parsed: ParsedAgentUsage; executablePath: string }
      | {
          kind: 'failure';
          failureState: 'error' | 'executableNotFound' | 'timeout';
          message: string;
          executable: string | null;
          resetCache: boolean;
        };

    let outcome: Outcome = { kind: 'aborted' };

    try {
      await this.acquireSlot();
      acquired = true;
      if (this.stopped) return;

      state.status = {
        ...state.status,
        state: 'loading',
        error: undefined,
      };
      this.emitChanged();

      const executablePath = await this.resolveExecFn(id, spec.executableName);
      if (this.stopped) return;

      if (!executablePath) {
        resolvedExecutable = null;
        outcome = {
          kind: 'failure',
          failureState: 'executableNotFound',
          message: `Executable not found: ${spec.executableName}`,
          executable: null,
          resetCache: false,
        };
        return;
      }
      resolvedExecutable = executablePath;

      tempCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'orkestrei-usage-'));
      const extraEnv: Record<string, string> = {};
      if (spec.cacheSubdir) {
        const cachePath = path.join(this.cacheDir, spec.cacheSubdir);
        await fsp.mkdir(cachePath, { recursive: true });
        extraEnv.CODEX_SQLITE_HOME = cachePath;
      }

      const env = buildMinimalUsageEnv(executablePath, extraEnv);
      const timeoutMs = this.timeouts[id];
      const rawEnvelope = await this.runProviderFn({
        providerId: id,
        executablePath,
        env,
        cwd: tempCwd,
        timeoutMs,
        signal: ac.signal,
      });

      if (this.stopped) return;

      const parsed = spec.parse(rawEnvelope);
      if (parsed.error) {
        outcome = {
          kind: 'failure',
          failureState: 'error',
          message: parsed.error,
          executable: executablePath,
          resetCache: false,
        };
        return;
      }

      outcome = { kind: 'success', parsed, executablePath };
    } catch (err) {
      if (err instanceof ProviderAbortedError || this.stopped) {
        outcome = { kind: 'aborted' };
        return;
      }

      const errCode = (err as NodeJS.ErrnoException | undefined)?.code;
      if (err instanceof ProviderTimeoutError) {
        outcome = {
          kind: 'failure',
          failureState: 'timeout',
          message: err.message,
          executable: resolvedExecutable,
          resetCache: true,
        };
      } else if (errCode === 'ENOENT') {
        outcome = {
          kind: 'failure',
          failureState: 'executableNotFound',
          message: `Executable not found: ${spec.executableName}`,
          executable: null,
          resetCache: false,
        };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        outcome = {
          kind: 'failure',
          failureState: 'error',
          message,
          executable: resolvedExecutable,
          resetCache: false,
        };
      }
    } finally {
      this.activeAborts.delete(ac);
      if (acquired) {
        this.releaseSlot();
      }
      if (tempCwd) {
        await fsp
          .rm(tempCwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
          .catch(() => undefined);
      }
      if (outcome.kind === 'failure' && outcome.resetCache) {
        await this.resetProviderCacheIfNeeded(spec);
      }
      clearInFlight();

      if (!this.stopped) {
        if (outcome.kind === 'success') {
          const finishNow = this.now();
          state.failureCount = 0;
          state.lastFinishedAt = finishNow;
          state.nextAutoPollAt =
            finishNow + Math.max(this.pollIntervals[id], this.minRequestGapMs);
          state.status = {
            id,
            name: spec.name,
            state: 'ready',
            plan: outcome.parsed.plan,
            limitReached: outcome.parsed.limitReached,
            meters: outcome.parsed.meters,
            lastSuccessAt: new Date(finishNow).toISOString(),
            executable: outcome.executablePath,
          };
          this.emitChanged();
        } else if (outcome.kind === 'failure') {
          this.recordFailure(
            id,
            state,
            outcome.failureState,
            outcome.message,
            outcome.executable
          );
        }
      }
    }
  }

  private async resetProviderCacheIfNeeded(spec: ProviderDefinition): Promise<void> {
    if (!spec.cacheSubdir) return;
    const cachePath = path.join(this.cacheDir, spec.cacheSubdir);
    await fsp.rm(cachePath, { recursive: true, force: true }).catch(() => undefined);
  }

  private recordFailure(
    id: AgentUsageProviderId,
    state: ProviderRuntimeState,
    failureState: 'error' | 'executableNotFound' | 'timeout',
    message: string,
    executable: string | null
  ): void {
    const finishNow = this.now();
    state.failureCount += 1;
    const expDelay = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * Math.pow(2, state.failureCount - 1)
    );
    state.lastFinishedAt = finishNow;
    state.nextAutoPollAt = finishNow + Math.max(expDelay, this.minRequestGapMs);
    state.status = {
      ...state.status,
      state: failureState,
      error: message,
      executable,
    };
    this.emitChanged();
  }

  private emitChanged(): void {
    if (this.stopped) return;
    this.updatedAt = new Date(this.now()).toISOString();
    const snapshot = this.getSnapshot();
    for (const cb of this.listeners) {
      cb(snapshot);
    }
  }
}
