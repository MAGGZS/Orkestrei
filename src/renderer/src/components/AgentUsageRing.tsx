import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import type {
  AgentUsageMeter,
  AgentUsageProviderId,
  AgentUsageProviderStatus,
  AgentUsageSnapshot,
  AgentUsageWindow,
} from '../../../shared/types';

export interface UsageTone {
  textClass: string;
  barClass: string;
  borderClass: string;
  strokeColor: string;
}

const PROVIDER_ORDER: AgentUsageProviderId[] = ['claude', 'codex', 'antigravity'];
const OUTER_RING_RADIUS = 6.25;
const INNER_RING_RADIUS = 3.05;
const RING_STROKE_WIDTH = 1.6;
const POPOVER_MARGIN_PX = 8;
const POPOVER_GAP_PX = 8;
const DEFAULT_POPOVER_WIDTH = 320;
const DEFAULT_POPOVER_HEIGHT = 260;

/**
 * Maps a usage percentage (0..100+) to consistent semantic tone tokens.
 * Thresholds: <= 70 normal, > 70 warning, > 90 destructive.
 */
export function getContextTone(pct: number): UsageTone {
  if (pct > 90) {
    return {
      textClass: 'text-[var(--destructive)]',
      barClass: 'bg-[var(--destructive)]',
      borderClass: 'border-[var(--destructive)]/40',
      strokeColor: 'var(--destructive)',
    };
  }
  if (pct > 70) {
    return {
      textClass: 'text-[var(--warning)]',
      barClass: 'bg-[var(--warning)]',
      borderClass: 'border-[var(--warning)]/40',
      strokeColor: 'var(--warning)',
    };
  }
  return {
    textClass: 'text-[var(--foreground)]',
    barClass: 'bg-[var(--muted-foreground)]',
    borderClass: 'border-[var(--border)]',
    strokeColor: 'var(--foreground)',
  };
}

/** Returns true when at least one meter contains a window to display. */
export function hasValidUsageMeters(meters: AgentUsageMeter[]): boolean {
  return meters.some((meter) => meter.windows.length > 0);
}

/**
 * Determines whether a provider has valid usage data worth displaying.
 * Visible only when connected (`ready` with non-empty meters, or cached via `lastSuccessAt` + meters).
 */
export function isAgentUsageVisible(
  status: AgentUsageProviderStatus | null | undefined
): status is AgentUsageProviderStatus {
  if (!status) return false;
  if (status.state === 'executableNotFound') return false;
  if (!hasValidUsageMeters(status.meters)) return false;
  if (status.state === 'ready') return true;
  return Boolean(status.lastSuccessAt && status.lastSuccessAt.trim().length > 0);
}

/** Returns all providers present in `snapshot` in stable display order. */
function collectOrderedProviders(
  snapshot: AgentUsageSnapshot,
  predicate?: (status: AgentUsageProviderStatus | null | undefined) => status is AgentUsageProviderStatus
): AgentUsageProviderStatus[] {
  const result: AgentUsageProviderStatus[] = [];
  const seen = new Set<string>();

  for (const id of PROVIDER_ORDER) {
    const status = snapshot.providers[id];
    seen.add(id);
    if (status && (!predicate || predicate(status))) {
      result.push(status);
    }
  }

  for (const [id, status] of Object.entries(snapshot.providers)) {
    if (!seen.has(id) && status && (!predicate || predicate(status))) {
      result.push(status);
    }
  }

  return result;
}

/** Returns all connected providers in stable display order filtered by `isAgentUsageVisible`. */
export function getVisibleProviders(snapshot: AgentUsageSnapshot): AgentUsageProviderStatus[] {
  return collectOrderedProviders(snapshot, isAgentUsageVisible);
}

/** Returns all tracked providers (connected, unlogged, or unavailable) in stable display order. */
export function getAllUsageProviders(snapshot: AgentUsageSnapshot): AgentUsageProviderStatus[] {
  return collectOrderedProviders(snapshot);
}

export interface ProviderStatusInfo {
  badgeLabel: string;
  detail: string;
  tone: 'muted' | 'warning' | 'destructive';
}

const AUTH_ERROR_PATTERN =
  /\b(not signed in|not authenticated|not logged in|login required|sign in|log in|unauthenticated|unauthorized)\b/i;

/** Maps non-ready or empty-meter provider states into clear PT-BR status labels. */
export function getProviderStatusInfo(
  status: AgentUsageProviderStatus
): ProviderStatusInfo | null {
  if (status.state === 'executableNotFound') {
    return {
      badgeLabel: 'Indisponível',
      detail: 'CLI não instalado',
      tone: 'muted',
    };
  }

  if (status.state === 'timeout') {
    return {
      badgeLabel: 'Indisponível',
      detail: 'Tempo esgotado na leitura',
      tone: 'warning',
    };
  }

  if (status.state === 'error') {
    const rawErr = status.error?.trim() ?? '';
    if (/^plan limits unavailable$/i.test(rawErr)) {
      return {
        badgeLabel: 'Não logado',
        detail: 'Limites do plano indisponíveis — faça login no CLI',
        tone: 'warning',
      };
    }
    if (AUTH_ERROR_PATTERN.test(rawErr)) {
      return {
        badgeLabel: 'Não logado',
        detail: 'Entre no CLI pelo terminal para ver o uso',
        tone: 'warning',
      };
    }
    return {
      badgeLabel: 'Indisponível',
      detail: rawErr || 'Falha ao consultar uso',
      tone: 'warning',
    };
  }

  if (hasValidUsageMeters(status.meters)) {
    return null;
  }

  if (status.state === 'loading') {
    return {
      badgeLabel: 'Verificando',
      detail: 'Consultando limites do plano…',
      tone: 'muted',
    };
  }

  if (status.state === 'idle') {
    return {
      badgeLabel: 'Aguardando',
      detail: 'Aguardando leitura',
      tone: 'muted',
    };
  }

  return {
    badgeLabel: 'Indisponível',
    detail: 'Nenhum limite disponível',
    tone: 'muted',
  };
}

/** Clamps a nullable usage percentage into the 0..100 range for visual bars and arcs. */
export function clampUsagePercent(pct: number | null | undefined): number {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/** Formats a nullable usage percentage as `"X% usado"` or `"—"` when unavailable. */
export function formatUsedPercentLabel(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${Math.round(Math.max(0, pct))}% usado`;
}

/** Extracts the session, weekly, and special windows used for rings and summaries. */
export function extractRingWindows(meters: AgentUsageMeter[]): {
  session: AgentUsageWindow | null;
  weekly: AgentUsageWindow | null;
  special: AgentUsageWindow | null;
} {
  let session: AgentUsageWindow | null = null;
  let weekly: AgentUsageWindow | null = null;
  let special: AgentUsageWindow | null = null;

  for (const meter of meters) {
    for (const win of meter.windows) {
      if (win.ring === 'session' && !session) session = win;
      else if (win.ring === 'weekly' && !weekly) weekly = win;
      else if (win.ring === 'special' && !special) special = win;
    }
  }

  return { session, weekly, special };
}

/** Computes SVG dasharray/dashoffset geometry for a circular progress ring. */
export function computeRingArc(
  radius: number,
  usedPercent: number | null | undefined
): { circumference: number; dashOffset: number; clampedPercent: number } {
  const circumference = 2 * Math.PI * radius;
  const clampedPercent = clampUsagePercent(usedPercent);
  const dashOffset = circumference * (1 - clampedPercent / 100);
  return { circumference, dashOffset, clampedPercent };
}

/** Formats an ISO reset timestamp into a concise relative string like `"Reseta em 3h 12m"`. */
export function formatResetCountdown(
  resetsAt: string | null | undefined,
  nowMs = Date.now()
): string | null {
  if (!resetsAt) return null;
  const targetMs = Date.parse(resetsAt);
  if (!Number.isFinite(targetMs)) return null;

  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'Reseta agora';
  if (diffMs < 60_000) return 'Reseta em < 1m';

  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes < 60) return `Reseta em ${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remMinutes > 0 ? `Reseta em ${totalHours}h ${remMinutes}m` : `Reseta em ${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `Reseta em ${days}d ${remHours}h` : `Reseta em ${days}d`;
}

/** Formats the last successful update timestamp as a quiet relative string. */
export function formatLastUpdated(
  iso: string | null | undefined,
  nowMs = Date.now()
): string {
  if (!iso) return 'Sem leitura';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'Sem leitura';

  const diffMs = Math.max(0, nowMs - ts);
  if (diffMs < 60_000) return 'Atualizado agora';

  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) return `Atualizado há ${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `Atualizado há ${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  return `Atualizado há ${days}d`;
}

/** Formats an ISO timestamp for native hover tooltips. */
export function formatExactTimestamp(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toLocaleString();
}

/** Normalizes short lowercase plan identifiers (e.g. `"pro"` -> `"Pro"`). */
export function formatPlanName(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const trimmed = plan.trim();
  if (!trimmed) return null;
  if (/^[a-z0-9_-]+$/.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}

/**
 * Computes fixed viewport coordinates for a portaled popover anchored to a trigger's screen rect,
 * clamping horizontally inside the window and flipping above when near the bottom edge.
 */
export function computePopoverPosition(
  anchorRect: { left: number; right: number; top: number; bottom: number },
  popoverSize: { width: number; height: number },
  viewportSize: { width: number; height: number }
): { left: number; top: number } {
  const width = popoverSize.width > 0 ? popoverSize.width : DEFAULT_POPOVER_WIDTH;
  const height = popoverSize.height > 0 ? popoverSize.height : DEFAULT_POPOVER_HEIGHT;

  const maxLeft = Math.max(POPOVER_MARGIN_PX, viewportSize.width - width - POPOVER_MARGIN_PX);
  const left = Math.round(
    Math.max(POPOVER_MARGIN_PX, Math.min(anchorRect.right - width, maxLeft))
  );

  const belowTop = anchorRect.bottom + POPOVER_GAP_PX;
  const aboveTop = anchorRect.top - POPOVER_GAP_PX - height;
  const maxTop = Math.max(POPOVER_MARGIN_PX, viewportSize.height - height - POPOVER_MARGIN_PX);

  let top = belowTop;
  if (belowTop + height > viewportSize.height - POPOVER_MARGIN_PX && aboveTop >= POPOVER_MARGIN_PX) {
    top = aboveTop;
  } else {
    top = Math.max(POPOVER_MARGIN_PX, Math.min(belowTop, maxTop));
  }

  return { left, top: Math.round(top) };
}

function windowFallbackTitle(win: AgentUsageWindow): string {
  const title = win.title.trim();
  if (title) return title;
  if (win.ring === 'session') return 'Sessão';
  if (win.ring === 'weekly') return 'Semanal';
  if (win.durationSeconds !== null) {
    if (win.durationSeconds <= 86_400) return 'Sessão';
    if (win.durationSeconds <= 604_800) return 'Semanal';
    return 'Mensal';
  }
  return win.id;
}

function resolveRingStroke(
  usedPercent: number | null,
  limitReached: boolean,
  isSecondaryRing: boolean
): string {
  if (limitReached) return 'var(--destructive)';
  if (usedPercent === null || !Number.isFinite(usedPercent)) {
    return isSecondaryRing ? 'var(--muted-foreground)' : 'var(--foreground)';
  }
  const tone = getContextTone(usedPercent);
  if (usedPercent <= 70 && isSecondaryRing) {
    return 'var(--muted-foreground)';
  }
  return tone.strokeColor;
}

/** Builds a concise summary string for a single provider (usage % or status). */
export function formatProviderSummary(status: AgentUsageProviderStatus): string {
  const parts: string[] = [status.name];
  if (!hasValidUsageMeters(status.meters)) {
    const statusInfo = getProviderStatusInfo(status);
    if (statusInfo) {
      parts.push(statusInfo.badgeLabel);
    }
    return parts.join(' · ');
  }

  const { session, weekly, special } = extractRingWindows(status.meters);

  if (status.limitReached) {
    parts.push('Limite atingido');
  }
  if (session?.usedPercent !== null && session?.usedPercent !== undefined) {
    parts.push(`Sessão ${Math.round(Math.max(0, session.usedPercent))}%`);
  }
  if (weekly?.usedPercent !== null && weekly?.usedPercent !== undefined) {
    parts.push(`Semanal ${Math.round(Math.max(0, weekly.usedPercent))}%`);
  }
  if (!session && !weekly && special?.usedPercent !== null && special?.usedPercent !== undefined) {
    parts.push(`${windowFallbackTitle(special)} ${Math.round(Math.max(0, special.usedPercent))}%`);
  }

  return parts.join(' · ');
}

interface RingCircleProps {
  radius: number;
  usedPercent: number | null;
  strokeColor: string;
  trackOpacity?: number;
}

const RingCircle: React.FC<RingCircleProps> = ({
  radius,
  usedPercent,
  strokeColor,
  trackOpacity = 1,
}) => {
  const { circumference, dashOffset, clampedPercent } = computeRingArc(radius, usedPercent);
  return (
    <>
      <circle
        cx={8}
        cy={8}
        r={radius}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={RING_STROKE_WIDTH}
        strokeOpacity={trackOpacity}
      />
      {clampedPercent > 0 && (
        <circle
          cx={8}
          cy={8}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={RING_STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 8 8)"
        />
      )}
    </>
  );
};

/** Concentric SVG gauge for one provider (outer = session, inner = weekly). */
export const ConcentricUsageSvg: React.FC<{ status: AgentUsageProviderStatus }> = ({ status }) => {
  const { session, weekly, special } = extractRingWindows(status.meters);
  const outerWindow = session ?? (!weekly ? special : null);

  const outerPercent = outerWindow?.usedPercent ?? (status.limitReached ? 100 : null);
  const outerStroke = resolveRingStroke(outerPercent, status.limitReached, false);
  const weeklyStroke = weekly
    ? resolveRingStroke(weekly.usedPercent, status.limitReached, true)
    : 'var(--muted-foreground)';

  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      {outerWindow && (
        <RingCircle
          radius={OUTER_RING_RADIUS}
          usedPercent={outerPercent}
          strokeColor={outerStroke}
        />
      )}
      {!outerWindow && weekly && (
        <RingCircle
          radius={OUTER_RING_RADIUS}
          usedPercent={null}
          strokeColor="var(--border-strong)"
          trackOpacity={0.45}
        />
      )}
      {!outerWindow && !weekly && (
        <RingCircle
          radius={OUTER_RING_RADIUS}
          usedPercent={null}
          strokeColor="var(--border-strong)"
          trackOpacity={0.55}
        />
      )}
      {weekly && (
        <RingCircle
          radius={INNER_RING_RADIUS}
          usedPercent={weekly.usedPercent}
          strokeColor={weeklyStroke}
        />
      )}
    </svg>
  );
};

export interface AgentUsageToolbarButtonProps {
  providers: AgentUsageProviderStatus[];
  allProviders?: AgentUsageProviderStatus[];
  isOpen: boolean;
  onToggle: () => void;
}

/**
 * Single global toolbar button showing compact concentric SVG rings for every connected provider,
 * or a standby ring when providers are tracked but none are logged in yet.
 */
export const AgentUsageToolbarButton = forwardRef<HTMLButtonElement, AgentUsageToolbarButtonProps>(
  ({ providers, allProviders = providers, isOpen, onToggle }, ref) => {
    if (providers.length === 0 && allProviders.length === 0) return null;

    const anyLimitReached = providers.some((p) => p.limitReached);
    const summaryProviders = allProviders.length > 0 ? allProviders : providers;
    const tooltip = summaryProviders.map(formatProviderSummary).join(' | ');
    const ringCount = providers.length > 0 ? providers.length : 1;
    const sizeClasses = ringCount === 1 ? 'size-7 justify-center' : 'h-7 gap-1 px-2';

    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-label={`Uso dos agentes: ${tooltip}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title={tooltip}
        className={`flex shrink-0 items-center rounded-full transition-colors active:scale-[0.98] ${sizeClasses} ${
          isOpen
            ? 'bg-[var(--bg-hover)] text-[var(--foreground)]'
            : anyLimitReached
              ? 'bg-[var(--destructive)]/14 text-[var(--destructive)] hover:bg-[var(--destructive)]/20'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
        }`}
      >
        {providers.length > 0 ? (
          providers.map((provider) => (
            <ConcentricUsageSvg key={provider.id} status={provider} />
          ))
        ) : (
          <ConcentricUsageSvg status={allProviders[0]} />
        )}
      </button>
    );
  }
);

AgentUsageToolbarButton.displayName = 'AgentUsageToolbarButton';

export interface AgentUsagePopoverProps {
  providers: AgentUsageProviderStatus[];
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onRefresh: (providerId: AgentUsageProviderId) => Promise<void>;
}

/**
 * Quiet graphite popover portaled to `document.body` listing every connected provider
 * (plan, windows, "% usado", bar, reset countdown, limit alert, and Refresh action).
 */
export const AgentUsagePopover = forwardRef<HTMLDivElement, AgentUsagePopoverProps>(
  ({ providers, anchorRef, onClose, onRefresh }, ref) => {
    const [refreshingIds, setRefreshingIds] = useState<Set<AgentUsageProviderId>>(() => new Set());
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

    const setMergedRef = useCallback(
      (node: HTMLDivElement | null) => {
        setPanelEl(node);
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref]
    );

    const updatePosition = useCallback(() => {
      const anchorEl = anchorRef.current;
      if (!anchorEl || typeof window === 'undefined') return;
      const anchorRect = anchorEl.getBoundingClientRect();
      const box = panelEl?.getBoundingClientRect();
      const next = computePopoverPosition(
        anchorRect,
        {
          width: box && box.width > 0 ? box.width : DEFAULT_POPOVER_WIDTH,
          height: box && box.height > 0 ? box.height : DEFAULT_POPOVER_HEIGHT,
        },
        { width: window.innerWidth, height: window.innerHeight }
      );
      setPosition((prev) =>
        prev && prev.left === next.left && prev.top === next.top ? prev : next
      );
    }, [anchorRef, panelEl]);

    const layoutSignature = providers
      .map(
        (p) =>
          `${p.id}:${p.state}:${p.meters.length}:${p.limitReached ? 1 : 0}:${p.error ? 1 : 0}`
      )
      .join(',');

    useLayoutEffect(() => {
      updatePosition();
    }, [updatePosition, layoutSignature]);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onResize = () => updatePosition();
      window.addEventListener('resize', onResize);

      const anchorEl = anchorRef.current;
      const ro =
        typeof ResizeObserver !== 'undefined' && anchorEl
          ? new ResizeObserver(() => updatePosition())
          : null;
      if (ro && anchorEl) ro.observe(anchorEl);

      return () => {
        window.removeEventListener('resize', onResize);
        ro?.disconnect();
      };
    }, [anchorRef, updatePosition]);

    useEffect(() => {
      setNowMs(Date.now());
      const id = window.setInterval(() => {
        setNowMs(Date.now());
      }, 30_000);
      return () => window.clearInterval(id);
    }, [providers]);

    const handleRefreshClick = async (providerId: AgentUsageProviderId) => {
      if (refreshingIds.has(providerId)) return;
      setRefreshingIds((prev) => new Set(prev).add(providerId));
      try {
        await onRefresh(providerId);
      } catch {
        // Provider state updates arrive through the snapshot subscription.
      } finally {
        setRefreshingIds((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    };

    if (typeof document === 'undefined' || providers.length === 0) return null;

    return createPortal(
      <div
        ref={setMergedRef}
        role="dialog"
        aria-label="Uso dos agentes"
        data-canvas-overlay="true"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: position?.left ?? -9999,
          top: position?.top ?? -9999,
          visibility: position ? 'visible' : 'hidden',
        }}
        className="z-[9600] w-80 rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3 text-[var(--popover-foreground)] shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
      >
        {/* Popover Header */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium leading-4 text-[var(--foreground)]">
            Uso dos agentes
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
          >
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Providers */}
        <div className="mt-3 max-h-[420px] space-y-3 divide-y divide-[var(--border)] overflow-y-auto pr-1">
          {providers.map((provider) => {
            const planLabel = formatPlanName(provider.plan);
            const hasMeters = hasValidUsageMeters(provider.meters);
            const statusInfo = getProviderStatusInfo(provider);
            const isBusy = refreshingIds.has(provider.id) || provider.state === 'loading';
            const updatedLabel = isBusy
              ? 'Atualizando…'
              : formatLastUpdated(provider.lastSuccessAt, nowMs);
            const exactUpdatedTitle = formatExactTimestamp(provider.lastSuccessAt);
            const showFooterTimestamp =
              hasMeters || provider.lastSuccessAt !== null || (isBusy && !statusInfo);
            const badgeToneClass =
              statusInfo?.tone === 'warning'
                ? 'bg-[var(--warning)]/12 text-[var(--warning)]'
                : statusInfo?.tone === 'destructive'
                  ? 'bg-[var(--destructive)]/12 text-[var(--destructive)]'
                  : 'bg-[var(--secondary)] text-[var(--muted-foreground)]';

            return (
              <section key={provider.id} className="pt-3 first:pt-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <ConcentricUsageSvg status={provider} />
                    <span className="truncate text-[13px] font-medium leading-4 text-[var(--foreground)]">
                      {provider.name}
                    </span>
                    {planLabel && (
                      <span className="shrink-0 rounded bg-[var(--secondary)] px-2 py-0.5 text-[11px] font-medium leading-4 text-[var(--muted-foreground)]">
                        {planLabel}
                      </span>
                    )}
                    {!planLabel && statusInfo && (
                      <span
                        className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium leading-4 ${badgeToneClass}`}
                        title={provider.error}
                      >
                        {statusInfo.badgeLabel}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRefreshClick(provider.id)}
                    disabled={isBusy}
                    aria-label={`Atualizar ${provider.name}`}
                    className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2 text-[11px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:opacity-55"
                  >
                    <RefreshCw
                      className={`size-4 text-[var(--muted-foreground)] ${isBusy ? 'animate-spin' : ''}`}
                      strokeWidth={1.5}
                    />
                    <span>Atualizar</span>
                  </button>
                </div>

                {provider.limitReached && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-2 py-2 text-[12px] font-medium text-[var(--destructive)]">
                    <AlertCircle className="size-4 shrink-0" strokeWidth={1.5} />
                    <span>Limite atingido</span>
                  </div>
                )}

                {hasMeters ? (
                  <div className="mt-2 space-y-2">
                    {provider.meters.map((meter) => (
                      <div key={`${provider.id}:${meter.id}`} className="space-y-2">
                        <div className="truncate text-[11px] font-medium text-[var(--muted-foreground)]">
                          {meter.label}
                        </div>
                        <div className="space-y-2">
                          {meter.windows.map((win) => {
                            const usedPct = win.usedPercent;
                            const barPct = clampUsagePercent(usedPct);
                            const tone = getContextTone(
                              usedPct !== null && Number.isFinite(usedPct) ? usedPct : 0
                            );
                            const resetLabel = formatResetCountdown(win.resetsAt, nowMs);
                            const exactReset = formatExactTimestamp(win.resetsAt);

                            return (
                              <div key={`${provider.id}:${meter.id}:${win.id}`} className="space-y-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="truncate text-[12px] font-medium text-[var(--foreground)]">
                                    {windowFallbackTitle(win)}
                                  </span>
                                  <span
                                    className={`shrink-0 font-mono text-[12px] tabular-nums ${
                                      usedPct === null
                                        ? 'text-[var(--muted-foreground)]'
                                        : tone.textClass
                                    }`}
                                  >
                                    {formatUsedPercentLabel(usedPct)}
                                  </span>
                                </div>
                                <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--border-strong)]">
                                  <div
                                    className={`h-full w-full origin-left rounded-full transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${tone.barClass}`}
                                    style={{ transform: `scaleX(${barPct / 100})` }}
                                  />
                                </div>
                                {resetLabel && (
                                  <div
                                    className="font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]"
                                    title={exactReset}
                                  >
                                    {resetLabel}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {statusInfo && (
                      <div
                        className="truncate text-[11px] leading-4 text-[var(--warning)]"
                        title={provider.error}
                      >
                        {statusInfo.detail}
                      </div>
                    )}
                  </div>
                ) : (
                  statusInfo && (
                    <div
                      className="mt-2 text-[12px] leading-4 text-[var(--muted-foreground)]"
                      title={provider.error}
                    >
                      {statusInfo.detail}
                    </div>
                  )
                )}

                {showFooterTimestamp && (
                  <div
                    className="mt-2 truncate font-mono text-[11px] tabular-nums text-[var(--muted-foreground)]"
                    title={exactUpdatedTitle}
                  >
                    {updatedLabel}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>,
      document.body
    );
  }
);

AgentUsagePopover.displayName = 'AgentUsagePopover';
