import type {
  AgentType,
  AgentUsageMeter,
  AgentUsageProviderId,
  AgentUsageRing,
  AgentUsageWindow,
} from '../shared/types';

export interface ParsedAgentUsage {
  plan: string | null;
  limitReached: boolean;
  meters: AgentUsageMeter[];
  error?: string;
}

const SECONDS_5H = 18_000;
const SECONDS_1D = 86_400;
const SECONDS_7D = 604_800;
const SECONDS_30D = 2_592_000;

const CODEX_PLAN_NAMES: Record<string, string> = {
  prolite: 'Pro Lite',
  self_serve_business_prolite: 'Business Pro Lite',
  self_serve_business_usage_based: 'Business',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  ent26: 'Enterprise',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
};

const WINDOW_NAME_SECONDS: Record<string, number> = {
  five_hour: SECONDS_5H,
  '5h': SECONDS_5H,
  hourly: 3_600,
  hour: 3_600,
  '1h': 3_600,
  daily: SECONDS_1D,
  day: SECONDS_1D,
  '1d': SECONDS_1D,
  '24h': SECONDS_1D,
  usage_period_type_daily: SECONDS_1D,
  weekly: SECONDS_7D,
  week: SECONDS_7D,
  '7d': SECONDS_7D,
  usage_period_type_weekly: SECONDS_7D,
  monthly: SECONDS_30D,
  month: SECONDS_30D,
  '30d': SECONDS_30D,
  usage_period_type_monthly: SECONDS_30D,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePercent(value: unknown): number | null {
  const num = parseFiniteNumber(value);
  if (num === null) return null;
  return num < 0 ? 0 : num;
}

function parseRemainingFractionPercent(value: unknown): number | null {
  const frac = parseFiniteNumber(value);
  if (frac === null) return null;
  const used = (1 - frac) * 100;
  return used < 0 ? 0 : used;
}

function parseIso8601(value: unknown): string | null {
  const str = asNonEmptyString(value);
  if (!str) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? str : null;
}

function parseEpochSecondsOrIso(value: unknown): string | null {
  const numeric = parseFiniteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    const date = new Date(numeric * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return parseIso8601(value);
}

function parseWindowNameDuration(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  const str = asNonEmptyString(value);
  if (!str) return null;
  const lower = str.toLowerCase();
  const known = WINDOW_NAME_SECONDS[lower];
  if (known !== undefined) return known;

  const hoursMatch = lower.match(/^(\d+)h$/);
  if (hoursMatch) return Number(hoursMatch[1]) * 3_600;
  const daysMatch = lower.match(/^(\d+)d$/);
  if (daysMatch) return Number(daysMatch[1]) * SECONDS_1D;
  const minsMatch = lower.match(/^(\d+)m$/);
  if (minsMatch) return Number(minsMatch[1]) * 60;
  return null;
}

function titleForDuration(durationSeconds: number | null, fallbackLabel: string): string {
  if (durationSeconds === null || durationSeconds <= 0) return fallbackLabel;
  if (durationSeconds === SECONDS_5H) return 'Sessão';
  if (durationSeconds === SECONDS_1D) return 'Diário';
  if (durationSeconds === SECONDS_7D) return 'Semanal';
  if (durationSeconds === SECONDS_30D) return 'Mensal';
  if (durationSeconds % SECONDS_1D === 0) return `${durationSeconds / SECONDS_1D}d`;
  if (durationSeconds % 3_600 === 0) return `${durationSeconds / 3_600}h`;
  if (durationSeconds % 60 === 0) return `${durationSeconds / 60}m`;
  return `${durationSeconds}s`;
}

function extractErrorMessage(errValue: unknown, fallback: string): string {
  const direct = asNonEmptyString(errValue);
  if (direct) return direct;
  const rec = asRecord(errValue);
  if (!rec) return fallback;
  if (rec.code === -32601) return 'Update the CLI to see usage';
  if (rec.code === 'notSignedIn') return 'Not signed in';
  const msg = asNonEmptyString(rec.message) ?? asNonEmptyString(rec.error);
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return fallback;
  }
}

function failureResult(error: string): ParsedAgentUsage {
  return {
    plan: null,
    limitReached: false,
    meters: [],
    error,
  };
}

function parseRawObjects(
  raw: unknown
): { ok: true; objects: Record<string, unknown>[] } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'Empty usage payload' };
  }

  let text: string | null = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  }

  if (text !== null) {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, error: 'Empty usage output' };
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const objects = parsed.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
        return objects.length > 0
          ? { ok: true, objects }
          : { ok: false, error: 'Unexpected JSON array in usage output' };
      }
      const rec = asRecord(parsed);
      return rec
        ? { ok: true, objects: [rec] }
        : { ok: false, error: 'Unexpected JSON root type in usage output' };
    } catch {
      const objects: Record<string, unknown>[] = [];
      for (const line of trimmed.split(/\r?\n/)) {
        const cleanLine = line.trim();
        if (!cleanLine) continue;
        try {
          const rec = asRecord(JSON.parse(cleanLine));
          if (rec) objects.push(rec);
        } catch {
          // Ignore non-JSON preamble/log lines in stdio output.
        }
      }
      if (objects.length > 0) {
        return { ok: true, objects };
      }
      // Fallback for multi-line JSON preceded by CLI log lines.
      const braceMatch = trimmed.match(/(?:^|\r?\n)\s*\{/);
      if (braceMatch && braceMatch.index !== undefined) {
        const jsonStart = trimmed.indexOf('{', braceMatch.index);
        try {
          const rec = asRecord(JSON.parse(trimmed.slice(jsonStart)));
          if (rec) return { ok: true, objects: [rec] };
        } catch {
          // Fall through to invalid JSON error.
        }
      }
      return { ok: false, error: 'Invalid JSON in usage output' };
    }
  }

  if (Array.isArray(raw)) {
    const objects = raw.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
    return objects.length > 0
      ? { ok: true, objects }
      : { ok: false, error: 'Unexpected array in usage payload' };
  }

  const rec = asRecord(raw);
  if (!rec) {
    return { ok: false, error: 'Unexpected usage payload type' };
  }
  return { ok: true, objects: [rec] };
}

function assignUsageRings(
  meters: AgentUsageMeter[],
  hasPrimaryMeter: boolean
): AgentUsageMeter[] {
  return meters.map((meter, meterIndex) => {
    const logicalIndex = hasPrimaryMeter ? meterIndex : meterIndex + 1;
    let sessionAssigned = false;
    let weeklyAssigned = false;

    let specialWindowIndex = -1;
    if (logicalIndex === 1 && meter.windows.length > 0) {
      let bestDuration = -1;
      for (let i = 0; i < meter.windows.length; i++) {
        const dur = meter.windows[i].durationSeconds ?? -1;
        if (specialWindowIndex === -1 || dur > bestDuration) {
          specialWindowIndex = i;
          bestDuration = dur;
        }
      }
    }

    const windows: AgentUsageWindow[] = meter.windows.map((win, winIndex) => {
      let ring: AgentUsageRing = null;
      if (logicalIndex === 0) {
        if (win.durationSeconds !== null) {
          if (win.durationSeconds <= SECONDS_1D && !sessionAssigned) {
            ring = 'session';
            sessionAssigned = true;
          } else if (win.durationSeconds > SECONDS_1D && !weeklyAssigned) {
            ring = 'weekly';
            weeklyAssigned = true;
          }
        }
      } else if (logicalIndex === 1 && winIndex === specialWindowIndex) {
        ring = 'special';
      }
      return { ...win, ring };
    });

    return { ...meter, windows };
  });
}

function hasAnyWindowAtLimit(meters: AgentUsageMeter[]): boolean {
  return meters.some((meter) =>
    meter.windows.some((win) => win.usedPercent !== null && win.usedPercent >= 100)
  );
}

function isRejectedStatus(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  return asNonEmptyString(record.status)?.toLowerCase() === 'rejected';
}

function buildWindow(input: {
  id: string;
  title?: string;
  usedPercent: number | null;
  resetsAt: string | null;
  durationSeconds: number | null;
  fallbackLabel: string;
}): AgentUsageWindow | null {
  if (input.usedPercent === null && input.resetsAt === null) {
    return null;
  }
  return {
    id: input.id,
    title: input.title ?? titleForDuration(input.durationSeconds, input.fallbackLabel),
    ring: null,
    usedPercent: input.usedPercent,
    resetsAt: input.resetsAt,
    durationSeconds: input.durationSeconds,
  };
}

/**
 * Resolve which Agent Usage provider corresponds to a terminal's agentType or command.
 */
export function resolveUsageProvider(
  agentType: AgentType | string | null | undefined,
  command?: string | null
): AgentUsageProviderId | null {
  if (agentType === 'claude' || agentType === 'codex' || agentType === 'antigravity') {
    return agentType;
  }
  if (agentType === 'agy') {
    return 'antigravity';
  }
  const cmd = command ?? '';
  const match = cmd.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const firstToken = match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
  if (!firstToken) return null;
  const base = (firstToken.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(exe|com|cmd|bat|ps1)$/i, '');
  if (base === 'claude' || base === 'codex') {
    return base;
  }
  if (base === 'agy' || base === 'antigravity') {
    return 'antigravity';
  }
  return null;
}

/**
 * Parse the full Claude Code `control_response` envelope (object or JSON/NDJSON string).
 */
export function parseClaudeUsage(raw: unknown): ParsedAgentUsage {
  const parsed = parseRawObjects(raw);
  if (!parsed.ok) return failureResult(parsed.error);

  const controlResponses = parsed.objects.filter((obj) => obj.type === 'control_response');
  const envelope =
    controlResponses.find((obj) => {
      const r = asRecord(obj.response);
      const inner = asRecord(r?.response);
      return Boolean(
        inner &&
          ('rate_limits' in inner ||
            'subscription_type' in inner ||
            'rate_limits_available' in inner)
      );
    }) ??
    controlResponses[controlResponses.length - 1] ??
    parsed.objects.find((obj) => obj.error != null || obj.type === 'error') ??
    parsed.objects[parsed.objects.length - 1];

  if (envelope.type !== 'control_response') {
    if (envelope.error != null || envelope.type === 'error') {
      return failureResult(extractErrorMessage(envelope.error ?? envelope, 'Claude usage error'));
    }
    return failureResult('Unexpected Claude usage envelope');
  }

  const resp = asRecord(envelope.response);
  if (!resp) {
    return failureResult('Missing response in Claude control_response');
  }

  if (resp.subtype === 'error' || resp.error != null) {
    return failureResult(extractErrorMessage(resp.error ?? resp, 'Claude usage request failed'));
  }

  const payload = asRecord(resp.response);
  if (!payload) {
    return failureResult('Missing /response/response in Claude control_response');
  }

  const rateLimits = asRecord(payload.rate_limits);
  if (payload.rate_limits_available === false && !rateLimits) {
    return failureResult('Plan limits unavailable');
  }

  const plan = asNonEmptyString(payload.subscription_type);
  const meters: AgentUsageMeter[] = [];
  const seenMeterIds = new Set<string>();
  let hasPrimaryMeter = false;
  let rejected = isRejectedStatus(payload) || isRejectedStatus(rateLimits);

  if (rateLimits) {
    const planLabel = 'Limites do plano';
    const planWindows: AgentUsageWindow[] = [];

    const fiveHour = asRecord(rateLimits.five_hour);
    if (fiveHour) {
      if (isRejectedStatus(fiveHour)) rejected = true;
      const win = buildWindow({
        id: 'five_hour',
        title: 'Sessão',
        usedPercent: parsePercent(fiveHour.utilization),
        resetsAt: parseIso8601(fiveHour.resets_at),
        durationSeconds: SECONDS_5H,
        fallbackLabel: planLabel,
      });
      if (win) planWindows.push(win);
    }

    const sevenDay = asRecord(rateLimits.seven_day);
    if (sevenDay) {
      if (isRejectedStatus(sevenDay)) rejected = true;
      const win = buildWindow({
        id: 'seven_day',
        title: 'Semanal',
        usedPercent: parsePercent(sevenDay.utilization),
        resetsAt: parseIso8601(sevenDay.resets_at),
        durationSeconds: SECONDS_7D,
        fallbackLabel: planLabel,
      });
      if (win) planWindows.push(win);
    }

    if (planWindows.length > 0) {
      seenMeterIds.add('plan');
      hasPrimaryMeter = true;
      meters.push({ id: 'plan', label: planLabel, windows: planWindows });
    }

    const modelScoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : [];
    for (const item of modelScoped) {
      const rec = asRecord(item);
      if (!rec) continue;
      if (isRejectedStatus(rec)) rejected = true;
      const name = asNonEmptyString(rec.display_name);
      if (!name || seenMeterIds.has(name)) continue;
      const win = buildWindow({
        id: 'limit',
        usedPercent: parsePercent(rec.utilization),
        resetsAt: parseIso8601(rec.resets_at),
        durationSeconds: SECONDS_7D,
        fallbackLabel: name,
      });
      if (!win) continue;
      seenMeterIds.add(name);
      meters.push({ id: name, label: name, windows: [win] });
    }
  }

  const ringedMeters = assignUsageRings(meters, hasPrimaryMeter);
  return {
    plan,
    limitReached: rejected || hasAnyWindowAtLimit(ringedMeters),
    meters: ringedMeters,
  };
}

function buildCodexMeter(
  id: string,
  entry: Record<string, unknown>
): { meter: AgentUsageMeter | null; limitReachedByReason: boolean } {
  const limitReachedByReason =
    entry.rateLimitReachedType !== null &&
    entry.rateLimitReachedType !== undefined &&
    entry.rateLimitReachedType !== false &&
    (typeof entry.rateLimitReachedType !== 'string' || entry.rateLimitReachedType.trim() !== '');

  const label = asNonEmptyString(entry.limitName) ?? 'Codex';
  const windows: AgentUsageWindow[] = [];

  for (const winId of ['primary', 'secondary'] as const) {
    const winRec = asRecord(entry[winId]);
    if (!winRec) continue;
    const mins = parseFiniteNumber(winRec.windowDurationMins);
    const durationSeconds = mins !== null && mins > 0 ? Math.round(mins * 60) : null;
    const win = buildWindow({
      id: winId,
      usedPercent: parsePercent(winRec.usedPercent),
      resetsAt: parseEpochSecondsOrIso(winRec.resetsAt),
      durationSeconds,
      fallbackLabel: label,
    });
    if (win) windows.push(win);
  }

  if (windows.length === 0) {
    return { meter: null, limitReachedByReason };
  }
  return { meter: { id, label, windows }, limitReachedByReason };
}

/**
 * Parse the full Codex `app-server` JSON-RPC envelope (object or JSON/NDJSON string).
 */
export function parseCodexUsage(raw: unknown): ParsedAgentUsage {
  const parsed = parseRawObjects(raw);
  if (!parsed.ok) return failureResult(parsed.error);

  const envelope =
    parsed.objects.find((obj) => {
      const res = asRecord(obj.result);
      return obj.id === 2 || Boolean(res && (res.rateLimits !== undefined || res.rateLimitsByLimitId !== undefined));
    }) ??
    parsed.objects.find((obj) => obj.error != null) ??
    parsed.objects[parsed.objects.length - 1];

  if (envelope.error != null) {
    return failureResult(extractErrorMessage(envelope.error, 'Codex usage request failed'));
  }

  const result = asRecord(envelope.result);
  if (!result) {
    return failureResult('Missing /result in Codex JSON-RPC response');
  }
  if (
    envelope.id === 1 &&
    result.rateLimits === undefined &&
    result.rateLimitsByLimitId === undefined &&
    result.ordinaryUsageAllowed === undefined
  ) {
    return failureResult('Missing account/rateLimits/read response in Codex output');
  }

  const rateLimits = asRecord(result.rateLimits);
  const byLimitId = asRecord(result.rateLimitsByLimitId);

  let rawPlan = asNonEmptyString(rateLimits?.planType);
  if (!rawPlan && byLimitId) {
    for (const val of Object.values(byLimitId)) {
      const rec = asRecord(val);
      const candidate = asNonEmptyString(rec?.planType);
      if (candidate) {
        rawPlan = candidate;
        break;
      }
    }
  }
  const plan = rawPlan ? (CODEX_PLAN_NAMES[rawPlan] ?? rawPlan) : null;

  const meters: AgentUsageMeter[] = [];
  const seenMeterIds = new Set<string>();
  let limitReached = result.ordinaryUsageAllowed === false;

  if (rateLimits) {
    const primaryId = asNonEmptyString(rateLimits.limitId) ?? 'codex';
    const built = buildCodexMeter(primaryId, rateLimits);
    if (built.limitReachedByReason) limitReached = true;
    if (built.meter && !seenMeterIds.has(primaryId)) {
      seenMeterIds.add(primaryId);
      meters.push(built.meter);
    }
  }

  if (byLimitId) {
    for (const [entryKey, value] of Object.entries(byLimitId)) {
      const rec = asRecord(value);
      if (!rec) continue;
      const built = buildCodexMeter(entryKey, rec);
      if (built.limitReachedByReason) limitReached = true;
      if (!entryKey || seenMeterIds.has(entryKey) || !built.meter) continue;
      seenMeterIds.add(entryKey);
      meters.push(built.meter);
    }
  }

  const ringedMeters = assignUsageRings(meters, true);
  return {
    plan,
    limitReached: limitReached || hasAnyWindowAtLimit(ringedMeters),
    meters: ringedMeters,
  };
}

/**
 * Parse the full Antigravity `agy -p /usage --output-format json` envelope (object or JSON string).
 */
export function parseAntigravityUsage(raw: unknown): ParsedAgentUsage {
  const parsed = parseRawObjects(raw);
  if (!parsed.ok) return failureResult(parsed.error);

  const envelope =
    parsed.objects.find((obj) => typeof obj.status === 'string') ??
    parsed.objects[parsed.objects.length - 1];

  if (envelope.status !== 'SUCCESS') {
    const errMsg =
      asNonEmptyString(asRecord(envelope.error)?.message) ??
      asNonEmptyString(envelope.error) ??
      asNonEmptyString(envelope.message) ??
      (typeof envelope.status === 'string'
        ? `Antigravity usage returned status: ${envelope.status}`
        : 'Unexpected Antigravity usage envelope');
    return failureResult(errMsg);
  }

  const command = asRecord(envelope.command);
  const data = asRecord(command?.data);
  if (!data || !Array.isArray(data.groups)) {
    return failureResult('Missing /command/data/groups in Antigravity output');
  }

  const meters: AgentUsageMeter[] = [];
  const seenMeterIds = new Set<string>();

  for (const groupItem of data.groups) {
    const group = asRecord(groupItem);
    if (!group) continue;
    const name = asNonEmptyString(group.name);
    if (!name || seenMeterIds.has(name)) continue;

    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const windows: AgentUsageWindow[] = [];
    const seenWindowIds = new Set<string>();

    for (const bucketItem of buckets) {
      const bucket = asRecord(bucketItem);
      if (!bucket) continue;
      const winId = asNonEmptyString(bucket.id);
      if (!winId || seenWindowIds.has(winId)) continue;

      const win = buildWindow({
        id: winId,
        usedPercent: parseRemainingFractionPercent(bucket.remaining_fraction),
        resetsAt: parseIso8601(bucket.reset_time),
        durationSeconds: parseWindowNameDuration(bucket.window),
        fallbackLabel: name,
      });
      if (!win) continue;
      seenWindowIds.add(winId);
      windows.push(win);
    }

    if (windows.length === 0) continue;
    seenMeterIds.add(name);
    meters.push({ id: name, label: name, windows });
  }

  const ringedMeters = assignUsageRings(meters, true);
  return {
    plan: null,
    limitReached: hasAnyWindowAtLimit(ringedMeters),
    meters: ringedMeters,
  };
}
