import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Routine, RoutineHistoryEntry, RoutineSchedule } from '../shared/types';
import { idsEqual, newId, readJsonFile, writeJsonAtomic } from './utils';

const execAsync = promisify(exec);

export function parseEveryIntervalMs(value: string): number {
  const s = value.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s) * 60_000;
  let total = 0;
  const matches = [...s.matchAll(/(\d+)\s*(s|m|h|d)/g)];
  for (const m of matches) {
    const num = Number(m[1]);
    const unit = m[2];
    if (unit === 's') total += num * 1000;
    else if (unit === 'm') total += num * 60_000;
    else if (unit === 'h') total += num * 3_600_000;
    else if (unit === 'd') total += num * 86_400_000;
  }
  return Math.max(5_000, total || 60_000);
}

export function computeNextFireAt(schedule: RoutineSchedule, from = new Date()): string | null {
  const base = from.getTime();
  if (schedule.kind === 'every') {
    const ms = parseEveryIntervalMs(schedule.value);
    return new Date(base + ms).toISOString();
  }
  if (schedule.kind === 'once') {
    const parsed = new Date(schedule.value.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= base) return null;
    return parsed.toISOString();
  }
  if (schedule.kind === 'daily') {
    const [hh, mm] = schedule.value.split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    const next = new Date(from);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= base) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  if (schedule.kind === 'weekly') {
    const [daysPart, timePart] = schedule.value.split('@');
    if (!daysPart || !timePart) return null;
    const [hh, mm] = timePart.split(':').map(Number);
    const dayMap: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };
    const allowedDays = new Set(
      daysPart
        .split(',')
        .map((d) => dayMap[d.trim().toLowerCase()])
        .filter((x) => x !== undefined)
    );
    if (allowedDays.size === 0 || Number.isNaN(hh) || Number.isNaN(mm)) return null;
    for (let offset = 0; offset < 8; offset++) {
      const candidate = new Date(from);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(hh, mm, 0, 0);
      if (allowedDays.has(candidate.getDay()) && candidate.getTime() > base) {
        return candidate.toISOString();
      }
    }
  }
  return null;
}

export interface RoutineDeps {
  baseDir: string;
  deliverToTerminal: (terminalId: string, command: string) => Promise<boolean>;
  isTerminalBusy: (terminalId: string) => boolean;
  ensureTerminalRunning: (workspaceId: string, terminalId: string) => Promise<boolean>;
  getWorkspaceEnv: (workspaceId: string, terminalId: string | null) => Record<string, string>;
  notifyUser: (title: string, body: string) => void;
}

export class RoutineScheduler {
  private routines: Routine[] = [];
  private history: RoutineHistoryEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private changedListeners = new Set<() => void>();
  private historyListeners = new Set<() => void>();

  constructor(private deps: RoutineDeps) {}

  private routinesFile(): string {
    return path.join(this.deps.baseDir, 'routines.json');
  }

  private historyFile(): string {
    return path.join(this.deps.baseDir, 'routine-history.json');
  }

  async init(): Promise<void> {
    this.routines = await readJsonFile<Routine[]>(this.routinesFile(), []);
    this.history = await readJsonFile<RoutineHistoryEntry[]>(this.historyFile(), []);
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  list(workspaceId?: string | null): Routine[] {
    return workspaceId
      ? this.routines.filter((r) => idsEqual(r.workspaceId, workspaceId))
      : [...this.routines];
  }

  getHistory(workspaceId?: string | null): RoutineHistoryEntry[] {
    return workspaceId
      ? this.history.filter((h) => idsEqual(h.workspaceId, workspaceId))
      : [...this.history];
  }

  async create(input: {
    workspaceId: string;
    name: string;
    command: string;
    schedule: RoutineSchedule;
    targetTerminalId: string | null;
    isReminder?: boolean;
    preRunScript?: string | null;
    skipIfBusy?: boolean;
    notify?: boolean;
    enabled?: boolean;
    maxCount?: number | null;
    untilDate?: string | null;
  }): Promise<Routine> {
    const routine: Routine = {
      id: newId(),
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      command: input.command,
      schedule: input.schedule,
      targetTerminalId: input.targetTerminalId,
      isReminder: Boolean(input.isReminder),
      preRunScript: input.preRunScript ?? null,
      skipIfBusy: input.skipIfBusy ?? true,
      notify: input.notify ?? true,
      enabled: input.enabled ?? true,
      fireCount: 0,
      maxCount: input.maxCount ?? null,
      untilDate: input.untilDate ?? null,
      lastFiredAt: null,
      nextFireAt: computeNextFireAt(input.schedule),
      createdAt: new Date().toISOString(),
    };
    this.routines.push(routine);
    await this.persistRoutines();
    return routine;
  }

  async update(id: string, patch: Partial<Routine>): Promise<Routine | null> {
    const idx = this.routines.findIndex((r) => idsEqual(r.id, id));
    if (idx === -1) return null;
    const prev = this.routines[idx];
    const scheduleChanged =
      patch.schedule &&
      (patch.schedule.kind !== prev.schedule.kind || patch.schedule.value !== prev.schedule.value);
    const nextEnabled = patch.enabled ?? prev.enabled;
    const nextFireAt =
      patch.nextFireAt !== undefined
        ? patch.nextFireAt
        : scheduleChanged
          ? nextEnabled
            ? computeNextFireAt(patch.schedule!)
            : null
          : prev.nextFireAt;
    const updated: Routine = {
      ...prev,
      ...patch,
      fireCount: scheduleChanged ? 0 : (patch.fireCount ?? prev.fireCount),
      nextFireAt,
    };
    this.routines[idx] = updated;
    await this.persistRoutines();
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<Routine | null> {
    return this.update(id, {
      enabled,
      nextFireAt: enabled ? computeNextFireAt(this.routines.find((r) => idsEqual(r.id, id))?.schedule ?? { kind: 'every', value: '1h' }) : null,
    });
  }

  async delete(id: string): Promise<boolean> {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => !idsEqual(r.id, id));
    if (this.routines.length === before) return false;
    await this.persistRoutines();
    return true;
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.persistHistory();
  }

  async removeHistoryEntry(id: string): Promise<void> {
    this.history = this.history.filter((h) => !idsEqual(h.id, id));
    await this.persistHistory();
  }

  async runNow(id: string): Promise<{ ok: boolean; status: string }> {
    const r = this.routines.find((x) => idsEqual(x.id, id));
    if (!r) return { ok: false, status: 'Routine not found' };
    return this.fireRoutine(r, true);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const snapshot of [...this.routines]) {
        const r = this.routines.find((x) => idsEqual(x.id, snapshot.id));
        if (!r || !r.enabled || !r.nextFireAt) continue;
        if (r.maxCount !== null && r.fireCount >= r.maxCount) {
          await this.update(r.id, { enabled: false, nextFireAt: null });
          continue;
        }
        if (r.untilDate && now > new Date(`${r.untilDate}T23:59:59`).getTime()) {
          await this.update(r.id, { enabled: false, nextFireAt: null });
          continue;
        }
        const due = new Date(r.nextFireAt).getTime();
        if (due <= now) {
          await this.fireRoutine(r, false);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fireRoutine(
    routine: Routine,
    manual: boolean
  ): Promise<{ ok: boolean; status: string }> {
    const nowIso = new Date().toISOString();
    const nextFireAt = routine.schedule.kind === 'once' ? null : computeNextFireAt(routine.schedule);

    if (!manual && routine.skipIfBusy && routine.targetTerminalId) {
      if (this.deps.isTerminalBusy(routine.targetTerminalId)) {
        await this.appendHistory({
          id: newId(),
          routineId: routine.id,
          routineName: routine.name,
          workspaceId: routine.workspaceId,
          firedAt: nowIso,
          status: 'skipped_busy',
        });
        await this.update(routine.id, { nextFireAt });
        return { ok: false, status: 'Skipped (terminal busy)' };
      }
    }

    let commandText = routine.command;
    if (routine.preRunScript && routine.preRunScript.trim() !== '') {
      try {
        const env = {
          ...process.env,
          ...this.deps.getWorkspaceEnv(routine.workspaceId, routine.targetTerminalId),
          MAESTRI_ROUTINE_NAME: routine.name,
        };
        const { stdout } = await execAsync(routine.preRunScript, { env, timeout: 30_000 });
        commandText = commandText.replace(/\{\{output\}\}/g, stdout.trim());
      } catch (err) {
        await this.appendHistory({
          id: newId(),
          routineId: routine.id,
          routineName: routine.name,
          workspaceId: routine.workspaceId,
          firedAt: nowIso,
          status: 'skipped_prerun',
          detail: err instanceof Error ? err.message : String(err),
        });
        await this.update(routine.id, { nextFireAt });
        return { ok: false, status: 'Skipped (pre-run failed)' };
      }
    }

    if (routine.isReminder || !routine.targetTerminalId) {
      this.deps.notifyUser(routine.name, commandText);
    } else {
      const alive = await this.deps.ensureTerminalRunning(routine.workspaceId, routine.targetTerminalId);
      if (!alive) {
        await this.appendHistory({
          id: newId(),
          routineId: routine.id,
          routineName: routine.name,
          workspaceId: routine.workspaceId,
          firedAt: nowIso,
          status: 'failed',
          detail: 'Target terminal unavailable',
        });
        await this.update(routine.id, { nextFireAt });
        return { ok: false, status: 'Target terminal unavailable' };
      }
      await this.deps.deliverToTerminal(routine.targetTerminalId, commandText);
      if (routine.notify) {
        this.deps.notifyUser(`Routine: ${routine.name}`, `Fired into terminal`);
      }
    }

    await this.appendHistory({
      id: newId(),
      routineId: routine.id,
      routineName: routine.name,
      workspaceId: routine.workspaceId,
      firedAt: nowIso,
      status: 'fired',
    });

    const nextCount = routine.fireCount + 1;
    const stillEnabled =
      routine.schedule.kind === 'once'
        ? false
        : routine.maxCount !== null && nextCount >= routine.maxCount
          ? false
          : routine.enabled;

    await this.update(routine.id, {
      fireCount: nextCount,
      lastFiredAt: nowIso,
      nextFireAt: stillEnabled ? nextFireAt : null,
      enabled: stillEnabled,
    });

    return { ok: true, status: 'Fired' };
  }

  private async appendHistory(entry: RoutineHistoryEntry): Promise<void> {
    this.history.unshift(entry);
    if (this.history.length > 200) this.history = this.history.slice(0, 200);
    await this.persistHistory();
  }

  private async persistRoutines(): Promise<void> {
    await writeJsonAtomic(this.routinesFile(), this.routines);
    for (const cb of this.changedListeners) cb();
  }

  private async persistHistory(): Promise<void> {
    await writeJsonAtomic(this.historyFile(), this.history);
    for (const cb of this.historyListeners) cb();
  }

  onChanged(cb: () => void): () => void {
    this.changedListeners.add(cb);
    return () => this.changedListeners.delete(cb);
  }

  onHistoryChanged(cb: () => void): () => void {
    this.historyListeners.add(cb);
    return () => this.historyListeners.delete(cb);
  }
}
