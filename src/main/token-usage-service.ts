import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TokenTrackingTarget } from './pty-manager';
import type {
  TerminalTokenUsage,
  TokenUsageMap,
  TokenUsageProvider,
} from '../shared/types';

export interface TokenTargetSource {
  getTokenTargets(): TokenTrackingTarget[];
}

export interface TokenUsageServiceOptions {
  pollIntervalMs?: number;
  claudeConfigDir?: string;
  codexHomeDir?: string;
  geminiHomeDir?: string;
  now?: () => number;
}

const DEFAULT_POLL_MS = 2500;
const CHUNK_SIZE = 1024 * 1024;
const BIRTHTIME_GRACE_MS = 3000;
const CLAUDE_DEFAULT_WINDOW = 200_000;
const CLAUDE_LARGE_WINDOW = 1_000_000;
const CODEX_DEFAULT_WINDOW = 200_000;
const GEMINI_CONTEXT_WINDOW = 1_048_576;

interface CandidateFile {
  path: string;
  normPath: string;
  stat: Stats;
}

interface ClaudeTurnRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | null;
  isSidechain: boolean;
  isSynthetic: boolean;
}

interface GeminiTurnRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  model: string | null;
}

interface ClaudeFileState {
  provider: 'claude';
  offset: number;
  ino: number;
  messages: Map<string, ClaudeTurnRecord>;
  anonSeq: number;
}

interface CodexFileState {
  provider: 'codex';
  offset: number;
  ino: number;
  model: string | null;
  contextWindow: number;
  turns: number;
  lastUsageSig: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  hasUsage: boolean;
}

interface GeminiFileState {
  provider: 'gemini';
  isLegacyJson: boolean;
  offset: number;
  ino: number;
  size: number;
  mtimeMs: number;
  messages: Map<string, GeminiTurnRecord>;
  anonSeq: number;
}

type FileParseState = ClaudeFileState | CodexFileState | GeminiFileState;

interface CodexMetaEntry {
  size: number;
  mtimeMs: number;
  cwd: string | null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizePathForCompare(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  let norm = path.normalize(trimmed);
  if (/^[a-zA-Z]:[\\/]+$/.test(norm)) {
    norm = `${norm[0]}:\\`;
  } else if (norm.length > 1) {
    norm = norm.replace(/[\\/]+$/, '');
  }
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

export function pathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

export function resolveTokenProvider(target: TokenTrackingTarget): TokenUsageProvider | null {
  if (
    target.agentType === 'claude' ||
    target.agentType === 'codex' ||
    target.agentType === 'gemini'
  ) {
    return target.agentType;
  }
  const cmd = target.command ?? '';
  const match = cmd.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const firstToken = match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
  if (!firstToken) return null;
  const base = path
    .basename(firstToken)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (base === 'claude' || base === 'codex' || base === 'gemini') {
    return base;
  }
  return null;
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function getFileBirthtimeMs(stat: Stats): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
}

function formatDateParts(date: Date, utc: boolean): string {
  const y = utc ? date.getUTCFullYear() : date.getFullYear();
  const m = String((utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, '0');
  const d = String(utc ? date.getUTCDate() : date.getDate()).padStart(2, '0');
  return path.join(String(y), m, d);
}

function isSameUsage(a: TerminalTokenUsage | undefined, b: TerminalTokenUsage): boolean {
  if (!a) return false;
  return (
    a.terminalId === b.terminalId &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.totalTokens === b.totalTokens &&
    a.contextTokens === b.contextTokens &&
    a.contextWindow === b.contextWindow &&
    a.turns === b.turns &&
    a.sessionFile === b.sessionFile
  );
}

function mapsEqual(a: TokenUsageMap, b: TokenUsageMap): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export class TokenUsageService {
  private targetSource: TokenTargetSource;
  private pollIntervalMs: number;
  private claudeConfigDirOverride?: string;
  private codexHomeDirOverride?: string;
  private geminiHomeDirOverride?: string;
  private now: () => number;

  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  private currentMap: TokenUsageMap = {};
  private listeners = new Set<(map: TokenUsageMap) => void>();
  private loggedWarnings = new Set<string>();

  /** terminalId -> bound session file path */
  private bindings = new Map<string, string>();
  /** normalized path -> incremental parse state */
  private fileStates = new Map<string, FileParseState>();
  /** normalized path -> cached Codex session_meta cwd */
  private codexMetaCache = new Map<string, CodexMetaEntry>();
  /** cached ~/.gemini/projects.json lookup */
  private geminiProjectsCache: {
    mtimeMs: number;
    size: number;
    entries: Array<{ cwd: string; name: string }>;
  } | null = null;

  constructor(targetSource: TokenTargetSource, options: TokenUsageServiceOptions = {}) {
    this.targetSource = targetSource;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.claudeConfigDirOverride = options.claudeConfigDir;
    this.codexHomeDirOverride = options.codexHomeDir;
    this.geminiHomeDirOverride = options.geminiHomeDir;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  getSnapshot(): TokenUsageMap {
    return { ...this.currentMap };
  }

  onChanged(cb: (map: TokenUsageMap) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async poll(): Promise<TokenUsageMap> {
    if (this.stopped || this.polling) {
      return this.getSnapshot();
    }
    this.polling = true;
    try {
      const targets = this.targetSource.getTokenTargets();
      const nextMap = await this.collectUsage(targets);
      if (!this.stopped && !mapsEqual(this.currentMap, nextMap)) {
        this.currentMap = nextMap;
        const snapshot = this.getSnapshot();
        for (const cb of this.listeners) {
          cb(snapshot);
        }
      }
      return this.getSnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.loggedWarnings.has(msg)) {
        this.loggedWarnings.add(msg);
        console.warn('[TokenUsageService] poll failed:', msg);
      }
      return this.getSnapshot();
    } finally {
      this.polling = false;
    }
  }

  private getClaudeDir(): string {
    return (
      this.claudeConfigDirOverride ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), '.claude')
    );
  }

  private getCodexDir(): string {
    return (
      this.codexHomeDirOverride ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), '.codex')
    );
  }

  private getGeminiDir(): string {
    return this.geminiHomeDirOverride || path.join(os.homedir(), '.gemini');
  }

  private async collectUsage(targets: TokenTrackingTarget[]): Promise<TokenUsageMap> {
    const activeIds = new Set(targets.map((t) => t.terminalId));
    for (const tid of [...this.bindings.keys()]) {
      if (!activeIds.has(tid)) {
        this.bindings.delete(tid);
      }
    }

    const classified = targets
      .map((target) => ({ target, provider: resolveTokenProvider(target) }))
      .filter(
        (item): item is { target: TokenTrackingTarget; provider: TokenUsageProvider } =>
          item.provider !== null
      );

    const claimedFiles = new Set<string>();
    const resolvedPaths = new Map<string, string>();
    const exactTerminalIds = new Set<string>();
    const exactPinnedNorms = new Map<string, string>();
    const currentBoundStats = new Map<string, CandidateFile>();

    // Pass 1: Exact Claude --session-id targets (preserving any /clear rebind if active)
    for (const { target, provider } of classified) {
      if (provider === 'claude' && target.claudeSessionId) {
        exactTerminalIds.add(target.terminalId);
        const exactPath = await this.resolveClaudeExactPath(target);
        const normExact = normalizePathForCompare(exactPath);
        claimedFiles.add(normExact);
        exactPinnedNorms.set(target.terminalId, normExact);

        const existingBound = this.bindings.get(target.terminalId);
        const candidatePath =
          existingBound && normalizePathForCompare(existingBound) !== normExact
            ? existingBound
            : exactPath;
        const stat = await this.safeStat(candidatePath);
        if (stat && stat.isFile()) {
          const normBound = normalizePathForCompare(candidatePath);
          claimedFiles.add(normBound);
          this.bindings.set(target.terminalId, candidatePath);
          resolvedPaths.set(target.terminalId, candidatePath);
          currentBoundStats.set(target.terminalId, {
            path: candidatePath,
            normPath: normBound,
            stat,
          });
        } else if (candidatePath !== exactPath) {
          const exactStat = await this.safeStat(exactPath);
          if (exactStat && exactStat.isFile()) {
            this.bindings.set(target.terminalId, exactPath);
            resolvedPaths.set(target.terminalId, exactPath);
            currentBoundStats.set(target.terminalId, {
              path: exactPath,
              normPath: normExact,
              stat: exactStat,
            });
          } else {
            this.bindings.delete(target.terminalId);
          }
        } else {
          this.bindings.delete(target.terminalId);
        }
      }
    }

    // Pass 2: Preserve valid existing heuristic bindings before assigning unbound targets
    const heuristicItems = classified.filter((item) => !exactTerminalIds.has(item.target.terminalId));

    for (const { target } of heuristicItems) {
      const boundPath = this.bindings.get(target.terminalId);
      if (!boundPath) continue;
      const normBound = normalizePathForCompare(boundPath);
      if (claimedFiles.has(normBound)) {
        this.bindings.delete(target.terminalId);
        continue;
      }
      const stat = await this.safeStat(boundPath);
      if (stat && stat.isFile()) {
        claimedFiles.add(normBound);
        resolvedPaths.set(target.terminalId, boundPath);
        currentBoundStats.set(target.terminalId, {
          path: boundPath,
          normPath: normBound,
          stat,
        });
      } else {
        this.bindings.delete(target.terminalId);
      }
    }

    // Pass 3: Bind unbound heuristic targets (newest spawnedAt first)
    const unbound = heuristicItems
      .filter((item) => !resolvedPaths.has(item.target.terminalId))
      .sort((a, b) => b.target.spawnedAt - a.target.spawnedAt);

    const candidatesByTerminal = new Map<string, CandidateFile[]>();
    const getCandidates = async (
      target: TokenTrackingTarget,
      provider: TokenUsageProvider
    ): Promise<CandidateFile[]> => {
      const cached = candidatesByTerminal.get(target.terminalId);
      if (cached) return cached;
      const found = await this.findCandidates(target, provider);
      candidatesByTerminal.set(target.terminalId, found);
      return found;
    };

    for (const { target, provider } of unbound) {
      const candidates = await getCandidates(target, provider);
      const best = this.pickBestUnclaimedCandidate(candidates, claimedFiles);
      if (best) {
        claimedFiles.add(best.normPath);
        this.bindings.set(target.terminalId, best.path);
        resolvedPaths.set(target.terminalId, best.path);
        currentBoundStats.set(target.terminalId, best);
      }
    }

    // Pass 4: Rebind running bound targets if a newer unclaimed session file appeared (e.g. /clear)
    for (const { target, provider } of classified) {
      if (!target.running) continue;
      const current = currentBoundStats.get(target.terminalId);
      if (!current) continue;
      const candidates = await getCandidates(target, provider);
      const isExact = exactTerminalIds.has(target.terminalId);
      const newer = this.pickRebindCandidate(candidates, claimedFiles, current, isExact);
      if (newer) {
        const pinnedNorm = exactPinnedNorms.get(target.terminalId);
        if (current.normPath !== pinnedNorm) {
          claimedFiles.delete(current.normPath);
        }
        claimedFiles.add(newer.normPath);
        this.bindings.set(target.terminalId, newer.path);
        resolvedPaths.set(target.terminalId, newer.path);
      }
    }

    // Prune fileStates for files no longer referenced by any bound terminal
    const activeBoundNorms = new Set(
      [...resolvedPaths.values()].map((p) => normalizePathForCompare(p))
    );
    for (const normPath of [...this.fileStates.keys()]) {
      if (!activeBoundNorms.has(normPath)) {
        this.fileStates.delete(normPath);
      }
    }

    // Parse bound files incrementally and build next TokenUsageMap
    const nextMap: TokenUsageMap = {};
    for (const { target, provider } of classified) {
      const sessionFile = resolvedPaths.get(target.terminalId);
      if (!sessionFile) continue;
      const usage = await this.parseUsageFile(target.terminalId, provider, sessionFile);
      if (!usage) continue;
      const prev = this.currentMap[target.terminalId];
      nextMap[target.terminalId] = isSameUsage(prev, usage) ? prev : usage;
    }

    return nextMap;
  }

  private pickBestUnclaimedCandidate(
    candidates: CandidateFile[],
    claimedFiles: Set<string>
  ): CandidateFile | null {
    let best: CandidateFile | null = null;
    for (const cand of candidates) {
      if (claimedFiles.has(cand.normPath)) continue;
      if (
        !best ||
        cand.stat.mtimeMs > best.stat.mtimeMs ||
        (cand.stat.mtimeMs === best.stat.mtimeMs &&
          getFileBirthtimeMs(cand.stat) > getFileBirthtimeMs(best.stat))
      ) {
        best = cand;
      }
    }
    return best;
  }

  private pickRebindCandidate(
    candidates: CandidateFile[],
    claimedFiles: Set<string>,
    current: CandidateFile,
    strictAfterCurrentMtime = false
  ): CandidateFile | null {
    const currentBirth = getFileBirthtimeMs(current.stat);
    let best: CandidateFile | null = null;
    for (const cand of candidates) {
      if (claimedFiles.has(cand.normPath)) continue;
      if (cand.normPath === current.normPath) continue;
      const candBirth = getFileBirthtimeMs(cand.stat);
      if (cand.stat.mtimeMs <= current.stat.mtimeMs) continue;
      if (strictAfterCurrentMtime) {
        if (candBirth <= current.stat.mtimeMs) continue;
      } else if (candBirth < currentBirth) {
        continue;
      }
      if (
        !best ||
        cand.stat.mtimeMs > best.stat.mtimeMs ||
        (cand.stat.mtimeMs === best.stat.mtimeMs && candBirth > getFileBirthtimeMs(best.stat))
      ) {
        best = cand;
      }
    }
    return best;
  }

  private async safeStat(filePath: string): Promise<Stats | null> {
    try {
      return await fsp.stat(filePath);
    } catch {
      return null;
    }
  }

  private async resolveClaudeProjectDir(cwd: string): Promise<string | null> {
    const projectsDir = path.join(this.getClaudeDir(), 'projects');
    const slugs = new Set<string>([claudeProjectSlug(cwd)]);
    const trimmed = cwd.replace(/[\\/]+$/, '');
    if (trimmed && trimmed !== cwd) {
      slugs.add(claudeProjectSlug(trimmed));
    }

    for (const slug of slugs) {
      const candidate = path.join(projectsDir, slug);
      const stat = await this.safeStat(candidate);
      if (stat && stat.isDirectory()) return candidate;
    }

    if (process.platform === 'win32') {
      const targetLowers = new Set([...slugs].map((s) => s.toLowerCase()));
      const entries = await fsp.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && targetLowers.has(entry.name.toLowerCase())) {
          return path.join(projectsDir, entry.name);
        }
      }
    }

    return null;
  }

  private async resolveClaudeExactPath(target: TokenTrackingTarget): Promise<string> {
    const projectDir = await this.resolveClaudeProjectDir(target.cwd);
    const dir =
      projectDir ?? path.join(this.getClaudeDir(), 'projects', claudeProjectSlug(target.cwd));
    return path.join(dir, `${target.claudeSessionId}.jsonl`);
  }

  private async findCandidates(
    target: TokenTrackingTarget,
    provider: TokenUsageProvider
  ): Promise<CandidateFile[]> {
    const minBirthMs = target.spawnedAt - BIRTHTIME_GRACE_MS;
    if (provider === 'claude') {
      return this.findClaudeCandidates(target.cwd, minBirthMs);
    }
    if (provider === 'codex') {
      return this.findCodexCandidates(target, minBirthMs);
    }
    return this.findGeminiCandidates(target.cwd, minBirthMs);
  }

  private async findClaudeCandidates(cwd: string, minBirthMs: number): Promise<CandidateFile[]> {
    const projectDir = await this.resolveClaudeProjectDir(cwd);
    if (!projectDir) return [];
    const entries = await fsp.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    const candidates: CandidateFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
      const fullPath = path.join(projectDir, entry.name);
      const stat = await this.safeStat(fullPath);
      if (!stat || !stat.isFile()) continue;
      if (getFileBirthtimeMs(stat) < minBirthMs) continue;
      candidates.push({
        path: fullPath,
        normPath: normalizePathForCompare(fullPath),
        stat,
      });
    }
    return candidates;
  }

  private async findCodexCandidates(
    target: TokenTrackingTarget,
    minBirthMs: number
  ): Promise<CandidateFile[]> {
    const sessionsRoot = path.join(this.getCodexDir(), 'sessions');
    const nowMs = this.now();
    const startMs = Math.min(target.spawnedAt, nowMs) - 86_400_000;
    const endMs = nowMs + 86_400_000;

    const dateRelDirs = new Set<string>();
    for (let ts = startMs; ts <= endMs; ts += 43_200_000) {
      const dt = new Date(ts);
      dateRelDirs.add(formatDateParts(dt, false));
      dateRelDirs.add(formatDateParts(dt, true));
    }
    const nowDate = new Date(nowMs);
    dateRelDirs.add(formatDateParts(nowDate, false));
    dateRelDirs.add(formatDateParts(nowDate, true));

    const candidates: CandidateFile[] = [];
    for (const rel of dateRelDirs) {
      const dir = path.join(sessionsRoot, rel);
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const stat = await this.safeStat(fullPath);
        if (!stat || !stat.isFile()) continue;
        if (getFileBirthtimeMs(stat) < minBirthMs) continue;
        const metaCwd = await this.readCodexMetaCwd(fullPath, stat);
        if (!metaCwd || !pathsEqual(metaCwd, target.cwd)) continue;
        candidates.push({
          path: fullPath,
          normPath: normalizePathForCompare(fullPath),
          stat,
        });
      }
    }
    return candidates;
  }

  private async readCodexMetaCwd(filePath: string, stat: Stats): Promise<string | null> {
    const norm = normalizePathForCompare(filePath);
    const cached = this.codexMetaCache.get(norm);
    if (
      cached &&
      cached.cwd !== null &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      return cached.cwd;
    }
    if (stat.size === 0) return null;

    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(filePath, 'r');
      const len = Math.min(stat.size, 32 * 1024);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const nl = text.indexOf('\n');
      const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
      if (!firstLine) return null;

      let cwd: string | null = null;
      const parsed = asRecord(JSON.parse(firstLine));
      if (parsed && parsed.type === 'session_meta') {
        const payload = asRecord(parsed.payload);
        cwd = asNonEmptyString(payload?.cwd);
      }
      if (cwd) {
        this.codexMetaCache.set(norm, { size: stat.size, mtimeMs: stat.mtimeMs, cwd });
      }
      return cwd;
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private async getGeminiProjectMappings(): Promise<Array<{ cwd: string; name: string }>> {
    const projectsPath = path.join(this.getGeminiDir(), 'projects.json');
    const stat = await this.safeStat(projectsPath);
    if (!stat || !stat.isFile()) return [];
    if (
      this.geminiProjectsCache &&
      this.geminiProjectsCache.mtimeMs === stat.mtimeMs &&
      this.geminiProjectsCache.size === stat.size
    ) {
      return this.geminiProjectsCache.entries;
    }
    try {
      const raw = await fsp.readFile(projectsPath, 'utf8');
      const parsed = asRecord(JSON.parse(raw));
      if (!parsed) return [];
      const mapObj = asRecord(parsed.projects) ?? parsed;
      const entries: Array<{ cwd: string; name: string }> = [];
      for (const [k, v] of Object.entries(mapObj)) {
        if (typeof v === 'string' && v.trim()) {
          entries.push({ cwd: k, name: v.trim() });
        }
      }
      this.geminiProjectsCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
      return entries;
    } catch {
      return [];
    }
  }

  private async findGeminiCandidates(cwd: string, minBirthMs: number): Promise<CandidateFile[]> {
    const geminiDir = this.getGeminiDir();
    const chatDirs = new Map<string, string>();

    const mappings = await this.getGeminiProjectMappings();
    for (const entry of mappings) {
      if (pathsEqual(entry.cwd, cwd)) {
        const dir = path.join(geminiDir, 'tmp', entry.name, 'chats');
        chatDirs.set(normalizePathForCompare(dir), dir);
      }
    }

    const hashVariants = new Set<string>([
      cwd,
      cwd.toLowerCase(),
      path.normalize(cwd),
      path.normalize(cwd).toLowerCase(),
    ]);
    for (const variant of hashVariants) {
      const hash = createHash('sha256').update(variant).digest('hex');
      const dir = path.join(geminiDir, 'tmp', hash, 'chats');
      chatDirs.set(normalizePathForCompare(dir), dir);
    }

    const candidates: CandidateFile[] = [];
    for (const dir of chatDirs.values()) {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/^session-.*\.(jsonl|json)$/i.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const stat = await this.safeStat(fullPath);
        if (!stat || !stat.isFile()) continue;
        if (getFileBirthtimeMs(stat) < minBirthMs) continue;
        candidates.push({
          path: fullPath,
          normPath: normalizePathForCompare(fullPath),
          stat,
        });
      }
    }
    return candidates;
  }

  private async parseUsageFile(
    terminalId: string,
    provider: TokenUsageProvider,
    filePath: string
  ): Promise<TerminalTokenUsage | null> {
    if (provider === 'claude') {
      return this.parseClaudeFile(terminalId, filePath);
    }
    if (provider === 'codex') {
      return this.parseCodexFile(terminalId, filePath);
    }
    return this.parseGeminiFile(terminalId, filePath);
  }

  private async readIncrementalJsonl(
    filePath: string,
    state: { offset: number; ino: number },
    onReset: () => void,
    onRecord: (record: Record<string, unknown>) => void
  ): Promise<boolean> {
    const stat = await this.safeStat(filePath);
    if (!stat || !stat.isFile()) return false;

    const fileIno = typeof stat.ino === 'number' ? stat.ino : 0;
    const shouldReset =
      stat.size < state.offset ||
      (fileIno !== 0 && state.ino !== 0 && fileIno !== state.ino);

    if (shouldReset) {
      state.offset = 0;
      state.ino = fileIno;
      onReset();
    } else if (state.ino === 0 && fileIno !== 0) {
      state.ino = fileIno;
    }

    if (stat.size === state.offset) {
      return true;
    }

    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(filePath, 'r');
      let cursor = state.offset;
      let committedOffset = state.offset;
      let pending: Buffer = Buffer.alloc(0);

      while (cursor < stat.size) {
        const toRead = Math.min(CHUNK_SIZE, stat.size - cursor);
        const chunk = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await fh.read(chunk, 0, toRead, cursor);
        if (bytesRead <= 0) break;
        cursor += bytesRead;
        const slice = bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead);
        pending = pending.length === 0 ? slice : Buffer.concat([pending, slice]);

        const lastNl = pending.lastIndexOf(0x0a);
        if (lastNl !== -1) {
          const block = pending.subarray(0, lastNl + 1).toString('utf8');
          for (const rawLine of block.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            try {
              const obj = asRecord(JSON.parse(line));
              if (obj) onRecord(obj);
            } catch {
              // ignore malformed complete line
            }
          }
          committedOffset += lastNl + 1;
          pending = pending.subarray(lastNl + 1);
        }
      }

      if (pending.length > 0) {
        const tail = pending.toString('utf8').trim();
        if (!tail) {
          committedOffset += pending.length;
        } else {
          try {
            const obj = asRecord(JSON.parse(tail));
            if (obj) onRecord(obj);
            committedOffset += pending.length;
          } catch {
            // Incomplete line at EOF without trailing newline; retry from committedOffset next poll.
          }
        }
      }

      state.offset = committedOffset;
      state.ino = fileIno;
      return true;
    } catch {
      return false;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private async parseClaudeFile(
    terminalId: string,
    filePath: string
  ): Promise<TerminalTokenUsage | null> {
    const norm = normalizePathForCompare(filePath);
    let state = this.fileStates.get(norm);
    if (!state || state.provider !== 'claude') {
      state = {
        provider: 'claude',
        offset: 0,
        ino: 0,
        messages: new Map(),
        anonSeq: 0,
      };
      this.fileStates.set(norm, state);
    }

    const claudeState = state;
    const ok = await this.readIncrementalJsonl(
      filePath,
      claudeState,
      () => {
        claudeState.messages.clear();
        claudeState.anonSeq = 0;
      },
      (obj) => {
        if (obj.type !== 'assistant') return;
        const msg = asRecord(obj.message);
        const usage = asRecord(msg?.usage);
        if (!msg || !usage) return;

        const msgId = asNonEmptyString(msg.id) ?? `__anon_${++claudeState.anonSeq}`;
        const model = asNonEmptyString(msg.model);
        const record: ClaudeTurnRecord = {
          input: asNumber(usage.input_tokens),
          output: asNumber(usage.output_tokens),
          cacheRead: asNumber(usage.cache_read_input_tokens),
          cacheWrite: asNumber(usage.cache_creation_input_tokens),
          model,
          isSidechain: obj.isSidechain === true,
          isSynthetic: model === '<synthetic>',
        };
        // Re-insert so iteration order reflects the latest turn and deduplicates by message.id.
        claudeState.messages.delete(msgId);
        claudeState.messages.set(msgId, record);
      }
    );

    if (!ok || claudeState.messages.size === 0) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let lastMainTurn: ClaudeTurnRecord | null = null;
    let mainModel: string | null = null;
    let fallbackModel: string | null = null;

    for (const turn of claudeState.messages.values()) {
      inputTokens += turn.input;
      outputTokens += turn.output;
      cacheReadTokens += turn.cacheRead;
      cacheWriteTokens += turn.cacheWrite;
      if (turn.model && !turn.isSynthetic) {
        fallbackModel = turn.model;
      }
      if (!turn.isSidechain && !turn.isSynthetic) {
        lastMainTurn = turn;
        if (turn.model) mainModel = turn.model;
      }
    }

    const model = mainModel ?? fallbackModel;
    const contextTokens = lastMainTurn
      ? lastMainTurn.input + lastMainTurn.cacheRead + lastMainTurn.cacheWrite + lastMainTurn.output
      : 0;
    const contextWindow =
      (model && model.toLowerCase().includes('1m')) || contextTokens > CLAUDE_DEFAULT_WINDOW
        ? CLAUDE_LARGE_WINDOW
        : CLAUDE_DEFAULT_WINDOW;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    return {
      terminalId,
      provider: 'claude',
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      contextTokens,
      contextWindow,
      turns: claudeState.messages.size,
      sessionFile: filePath,
      updatedAt: this.now(),
    };
  }

  private async parseCodexFile(
    terminalId: string,
    filePath: string
  ): Promise<TerminalTokenUsage | null> {
    const norm = normalizePathForCompare(filePath);
    let state = this.fileStates.get(norm);
    if (!state || state.provider !== 'codex') {
      state = {
        provider: 'codex',
        offset: 0,
        ino: 0,
        model: null,
        contextWindow: CODEX_DEFAULT_WINDOW,
        turns: 0,
        lastUsageSig: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        contextTokens: 0,
        hasUsage: false,
      };
      this.fileStates.set(norm, state);
    }

    const codexState = state;
    const ok = await this.readIncrementalJsonl(
      filePath,
      codexState,
      () => {
        codexState.model = null;
        codexState.contextWindow = CODEX_DEFAULT_WINDOW;
        codexState.turns = 0;
        codexState.lastUsageSig = null;
        codexState.inputTokens = 0;
        codexState.outputTokens = 0;
        codexState.cacheReadTokens = 0;
        codexState.contextTokens = 0;
        codexState.hasUsage = false;
      },
      (obj) => {
        const payload = asRecord(obj.payload);
        if (!payload) return;

        if (obj.type === 'session_meta' || obj.type === 'turn_context') {
          const m = asNonEmptyString(payload.model);
          if (m) codexState.model = m;
          return;
        }

        if (obj.type !== 'event_msg' || payload.type !== 'token_count') return;

        const payloadModel = asNonEmptyString(payload.model);
        if (payloadModel) codexState.model = payloadModel;

        const info = asRecord(payload.info);
        if (!info) return;

        const infoModel = asNonEmptyString(info.model);
        if (infoModel) codexState.model = infoModel;

        const ctxWin = asNumber(info.model_context_window);
        if (ctxWin > 0) codexState.contextWindow = ctxWin;

        const totalUsage = asRecord(info.total_token_usage);
        const lastUsage = asRecord(info.last_token_usage);

        if (totalUsage) {
          const rawInput = asNumber(totalUsage.input_tokens);
          const cached = asNumber(totalUsage.cached_input_tokens);
          const output = asNumber(totalUsage.output_tokens);
          const reasoning = asNumber(totalUsage.reasoning_output_tokens);
          const sig = `${rawInput}:${cached}:${output}:${reasoning}`;

          codexState.inputTokens = Math.max(0, rawInput - cached);
          codexState.cacheReadTokens = cached;
          codexState.outputTokens = output;
          codexState.hasUsage = true;

          if (sig !== codexState.lastUsageSig) {
            codexState.turns += 1;
            codexState.lastUsageSig = sig;
          }
        } else if (lastUsage) {
          const rawInput = asNumber(lastUsage.input_tokens);
          const cached = asNumber(lastUsage.cached_input_tokens);
          const output = asNumber(lastUsage.output_tokens);

          codexState.inputTokens += Math.max(0, rawInput - cached);
          codexState.cacheReadTokens += cached;
          codexState.outputTokens += output;
          codexState.turns += 1;
          codexState.hasUsage = true;
        }

        if (lastUsage) {
          const lastIn = asNumber(lastUsage.input_tokens);
          const lastOut = asNumber(lastUsage.output_tokens);
          const lastTot = asNumber(lastUsage.total_tokens);
          codexState.contextTokens = lastIn > 0 || lastOut > 0 ? lastIn + lastOut : lastTot;
        } else if (totalUsage) {
          const totIn = asNumber(totalUsage.input_tokens);
          const totOut = asNumber(totalUsage.output_tokens);
          codexState.contextTokens = totIn + totOut;
        }
      }
    );

    if (!ok || !codexState.hasUsage) return null;

    const totalTokens =
      codexState.inputTokens + codexState.outputTokens + codexState.cacheReadTokens;

    return {
      terminalId,
      provider: 'codex',
      model: codexState.model,
      inputTokens: codexState.inputTokens,
      outputTokens: codexState.outputTokens,
      cacheReadTokens: codexState.cacheReadTokens,
      cacheWriteTokens: 0,
      totalTokens,
      contextTokens: codexState.contextTokens,
      contextWindow: codexState.contextWindow,
      turns: codexState.turns,
      sessionFile: filePath,
      updatedAt: this.now(),
    };
  }

  private recordGeminiMessage(state: GeminiFileState, obj: Record<string, unknown>): void {
    const tokens = asRecord(obj.tokens);
    if (!tokens) return;

    const rawInput = asNumber(tokens.input);
    const output = asNumber(tokens.output);
    const cached = asNumber(tokens.cached);
    const thoughts = asNumber(tokens.thoughts);
    const tool = asNumber(tokens.tool);
    const total = asNumber(tokens.total);

    const sumWithoutCached = rawInput + output + thoughts + tool;
    const sumWithCached = rawInput + cached + output + thoughts + tool;
    const inputAlreadyUncached =
      cached > 0 &&
      total > 0 &&
      Math.abs(sumWithCached - total) < Math.abs(sumWithoutCached - total);

    const freshPrompt = inputAlreadyUncached ? rawInput : Math.max(0, rawInput - cached);
    const inputTokens = freshPrompt + tool;
    const outputTokens = output + thoughts;
    const cacheReadTokens = cached;
    const contextTokens = freshPrompt + cached + tool + output + thoughts;

    const msgId = asNonEmptyString(obj.id) ?? `__anon_${++state.anonSeq}`;
    const model = asNonEmptyString(obj.model);

    state.messages.delete(msgId);
    state.messages.set(msgId, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      contextTokens,
      model,
    });
  }

  private async parseGeminiFile(
    terminalId: string,
    filePath: string
  ): Promise<TerminalTokenUsage | null> {
    const isLegacyJson = filePath.toLowerCase().endsWith('.json');
    const norm = normalizePathForCompare(filePath);
    let state = this.fileStates.get(norm);
    if (!state || state.provider !== 'gemini' || state.isLegacyJson !== isLegacyJson) {
      state = {
        provider: 'gemini',
        isLegacyJson,
        offset: 0,
        ino: 0,
        size: -1,
        mtimeMs: -1,
        messages: new Map(),
        anonSeq: 0,
      };
      this.fileStates.set(norm, state);
    }

    const geminiState = state;

    if (isLegacyJson) {
      const stat = await this.safeStat(filePath);
      if (!stat || !stat.isFile()) return null;
      if (stat.size !== geminiState.size || stat.mtimeMs !== geminiState.mtimeMs) {
        try {
          const raw = await fsp.readFile(filePath, 'utf8');
          const parsed = asRecord(JSON.parse(raw));
          geminiState.messages.clear();
          geminiState.anonSeq = 0;
          geminiState.size = stat.size;
          geminiState.mtimeMs = stat.mtimeMs;
          if (parsed && Array.isArray(parsed.messages)) {
            const rootModel = asNonEmptyString(parsed.model);
            for (const item of parsed.messages) {
              const rec = asRecord(item);
              if (!rec) continue;
              if (!asNonEmptyString(rec.model) && rootModel) {
                this.recordGeminiMessage(geminiState, { ...rec, model: rootModel });
              } else {
                this.recordGeminiMessage(geminiState, rec);
              }
            }
          }
        } catch {
          return null;
        }
      }
    } else {
      const ok = await this.readIncrementalJsonl(
        filePath,
        geminiState,
        () => {
          geminiState.messages.clear();
          geminiState.anonSeq = 0;
        },
        (obj) => {
          this.recordGeminiMessage(geminiState, obj);
        }
      );
      if (!ok) return null;
    }

    if (geminiState.messages.size === 0) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let contextTokens = 0;
    let model: string | null = null;

    for (const msg of geminiState.messages.values()) {
      inputTokens += msg.inputTokens;
      outputTokens += msg.outputTokens;
      cacheReadTokens += msg.cacheReadTokens;
      contextTokens = msg.contextTokens;
      if (msg.model) model = msg.model;
    }

    const totalTokens = inputTokens + outputTokens + cacheReadTokens;

    return {
      terminalId,
      provider: 'gemini',
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      totalTokens,
      contextTokens,
      contextWindow: GEMINI_CONTEXT_WINDOW,
      turns: geminiState.messages.size,
      sessionFile: filePath,
      updatedAt: this.now(),
    };
  }
}
