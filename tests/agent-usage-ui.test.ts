import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type {
  AgentUsageMeter,
  AgentUsageProviderStatus,
  AgentUsageSnapshot,
} from '../src/shared/types';
import {
  clampUsagePercent,
  computePopoverPosition,
  computeRingArc,
  extractRingWindows,
  formatLastUpdated,
  formatPlanName,
  formatProviderSummary,
  formatResetCountdown,
  formatUsedPercentLabel,
  getAllUsageProviders,
  getContextTone,
  getProviderStatusInfo,
  getVisibleProviders,
  hasValidUsageMeters,
  isAgentUsageVisible,
} from '../src/renderer/src/components/AgentUsageRing';
import { agentUsageAtom, EMPTY_AGENT_USAGE_SNAPSHOT } from '../src/renderer/src/state/atoms';

const SAMPLE_METERS: AgentUsageMeter[] = [
  {
    id: 'plan',
    label: 'Limites do plano',
    windows: [
      {
        id: 'five_hour',
        title: 'Sessão',
        ring: 'session',
        usedPercent: 69,
        resetsAt: '2026-11-17T23:00:00Z',
        durationSeconds: 18000,
      },
      {
        id: 'seven_day',
        title: 'Semanal',
        ring: 'weekly',
        usedPercent: 85,
        resetsAt: '2026-11-19T12:00:00Z',
        durationSeconds: 604800,
      },
    ],
  },
];

function makeStatus(overrides: Partial<AgentUsageProviderStatus> = {}): AgentUsageProviderStatus {
  return {
    id: 'claude',
    name: 'Claude Code',
    state: 'ready',
    plan: 'pro',
    limitReached: false,
    meters: SAMPLE_METERS,
    lastSuccessAt: '2026-11-17T20:00:00Z',
    executable: 'claude.exe',
    ...overrides,
  };
}

describe('AgentUsageRing helpers', () => {
  it('reuses threshold tones at <=70, >70, and >90', () => {
    expect(getContextTone(0).strokeColor).toBe('var(--foreground)');
    expect(getContextTone(70).strokeColor).toBe('var(--foreground)');
    expect(getContextTone(71).strokeColor).toBe('var(--warning)');
    expect(getContextTone(90).strokeColor).toBe('var(--warning)');
    expect(getContextTone(91).strokeColor).toBe('var(--destructive)');
  });

  it('filters visible providers per snapshot using isAgentUsageVisible', () => {
    expect(isAgentUsageVisible(null)).toBe(false);
    expect(isAgentUsageVisible(undefined)).toBe(false);

    expect(isAgentUsageVisible(makeStatus({ state: 'ready', lastSuccessAt: null }))).toBe(true);
    expect(isAgentUsageVisible(makeStatus({ state: 'ready', meters: [] }))).toBe(false);
    expect(
      isAgentUsageVisible(
        makeStatus({
          state: 'ready',
          meters: [{ id: 'empty', label: 'Empty', windows: [] }],
        })
      )
    ).toBe(false);

    expect(isAgentUsageVisible(makeStatus({ state: 'executableNotFound' }))).toBe(false);
    expect(
      isAgentUsageVisible(
        makeStatus({ state: 'error', error: 'Not signed in', meters: [], lastSuccessAt: null })
      )
    ).toBe(false);
    expect(
      isAgentUsageVisible(makeStatus({ state: 'loading', meters: [], lastSuccessAt: null }))
    ).toBe(false);
    expect(
      isAgentUsageVisible(makeStatus({ state: 'timeout', meters: [], lastSuccessAt: null }))
    ).toBe(false);
    expect(
      isAgentUsageVisible(makeStatus({ state: 'idle', meters: [], lastSuccessAt: null }))
    ).toBe(false);

    expect(
      isAgentUsageVisible(
        makeStatus({ state: 'loading', lastSuccessAt: '2026-11-17T20:00:00Z' })
      )
    ).toBe(true);
    expect(
      isAgentUsageVisible(
        makeStatus({ state: 'timeout', lastSuccessAt: '2026-11-17T20:00:00Z' })
      )
    ).toBe(true);

    expect(hasValidUsageMeters([])).toBe(false);
    expect(hasValidUsageMeters(SAMPLE_METERS)).toBe(true);

    const snapshot: AgentUsageSnapshot = {
      providers: {
        antigravity: makeStatus({ id: 'antigravity', name: 'Antigravity', plan: null }),
        codex: makeStatus({
          id: 'codex',
          name: 'Codex',
          state: 'executableNotFound',
          meters: [],
          lastSuccessAt: null,
        }),
        claude: makeStatus({ id: 'claude', name: 'Claude Code', limitReached: true }),
      },
      byTerminal: {},
      updatedAt: '2026-11-17T20:00:00Z',
    };

    const visible = getVisibleProviders(snapshot);
    expect(visible.map((p) => p.id)).toEqual(['claude', 'antigravity']);
    expect(formatProviderSummary(visible[0])).toBe(
      'Claude Code · Limite atingido · Sessão 69% · Semanal 85%'
    );

    const all = getAllUsageProviders(snapshot);
    expect(all.map((p) => p.id)).toEqual(['claude', 'codex', 'antigravity']);
    expect(formatProviderSummary(all[1])).toBe('Codex · Indisponível');

    expect(getVisibleProviders(EMPTY_AGENT_USAGE_SNAPSHOT)).toEqual([]);
    expect(getAllUsageProviders(EMPTY_AGENT_USAGE_SNAPSHOT)).toEqual([]);
  });

  it('maps unlogged, unavailable, timeout, loading, and idle states to clear PT-BR status info', () => {
    expect(getProviderStatusInfo(makeStatus({ state: 'ready' }))).toBeNull();

    expect(
      getProviderStatusInfo(
        makeStatus({ state: 'executableNotFound', meters: [], error: 'Executable not found: codex' })
      )
    ).toEqual({
      badgeLabel: 'Indisponível',
      detail: 'CLI não instalado',
      tone: 'muted',
    });

    expect(
      getProviderStatusInfo(
        makeStatus({ state: 'error', meters: [], error: 'Not signed in' })
      )
    ).toEqual({
      badgeLabel: 'Não logado',
      detail: 'Entre no CLI pelo terminal para ver o uso',
      tone: 'warning',
    });

    expect(
      getProviderStatusInfo(
        makeStatus({ state: 'error', meters: [], error: 'Plan limits unavailable' })
      )
    ).toEqual({
      badgeLabel: 'Não logado',
      detail: 'Limites do plano indisponíveis — faça login no CLI',
      tone: 'warning',
    });

    expect(
      getProviderStatusInfo(makeStatus({ state: 'timeout', meters: [], error: 'Timed out after 30s' }))
    ).toEqual({
      badgeLabel: 'Indisponível',
      detail: 'Tempo esgotado na leitura',
      tone: 'warning',
    });

    expect(getProviderStatusInfo(makeStatus({ state: 'loading', meters: [] }))).toEqual({
      badgeLabel: 'Verificando',
      detail: 'Consultando limites do plano…',
      tone: 'muted',
    });

    expect(getProviderStatusInfo(makeStatus({ state: 'idle', meters: [] }))).toEqual({
      badgeLabel: 'Aguardando',
      detail: 'Aguardando leitura',
      tone: 'muted',
    });

    expect(formatProviderSummary(makeStatus({ state: 'error', meters: [], error: 'Not signed in' }))).toBe(
      'Claude Code · Não logado'
    );
  });

  it('clamps visual percentage to 0..100 and formats label cleanly', () => {
    expect(clampUsagePercent(null)).toBe(0);
    expect(clampUsagePercent(Number.NaN)).toBe(0);
    expect(clampUsagePercent(-12)).toBe(0);
    expect(clampUsagePercent(69.4)).toBe(69.4);
    expect(clampUsagePercent(114)).toBe(100);

    expect(formatUsedPercentLabel(null)).toBe('—');
    expect(formatUsedPercentLabel(17.96)).toBe('18% usado');
    expect(formatUsedPercentLabel(105)).toBe('105% usado');
  });

  it('computes SVG ring arc circumference and dash offset accurately', () => {
    const empty = computeRingArc(6.25, 0);
    expect(empty.clampedPercent).toBe(0);
    expect(empty.dashOffset).toBeCloseTo(empty.circumference, 6);

    const half = computeRingArc(6.25, 50);
    expect(half.dashOffset).toBeCloseTo(half.circumference / 2, 6);

    const over = computeRingArc(6.25, 130);
    expect(over.clampedPercent).toBe(100);
    expect(over.dashOffset).toBeCloseTo(0, 6);
  });

  it('extracts session, weekly, and special ring windows across meters', () => {
    const meters: AgentUsageMeter[] = [
      {
        id: 'Gemini Models',
        label: 'Gemini Models',
        windows: [
          {
            id: 'gemini-weekly',
            title: 'Semanal',
            ring: 'weekly',
            usedPercent: 18,
            resetsAt: null,
            durationSeconds: 604800,
          },
          {
            id: 'gemini-5h',
            title: 'Sessão',
            ring: 'session',
            usedPercent: 42,
            resetsAt: null,
            durationSeconds: 18000,
          },
        ],
      },
      {
        id: 'Claude and GPT models',
        label: 'Claude and GPT models',
        windows: [
          {
            id: '3p-weekly',
            title: 'Semanal',
            ring: 'special',
            usedPercent: 5,
            resetsAt: null,
            durationSeconds: 604800,
          },
        ],
      },
    ];

    const rings = extractRingWindows(meters);
    expect(rings.session?.id).toBe('gemini-5h');
    expect(rings.weekly?.id).toBe('gemini-weekly');
    expect(rings.special?.id).toBe('3p-weekly');
  });

  it('formats relative reset countdowns in PT-BR', () => {
    const now = Date.parse('2026-11-17T20:00:00Z');
    expect(formatResetCountdown(null, now)).toBeNull();
    expect(formatResetCountdown('invalid', now)).toBeNull();
    expect(formatResetCountdown('2026-11-17T19:59:00Z', now)).toBe('Reseta agora');
    expect(formatResetCountdown('2026-11-17T20:00:30Z', now)).toBe('Reseta em < 1m');
    expect(formatResetCountdown('2026-11-17T20:15:00Z', now)).toBe('Reseta em 15m');
    expect(formatResetCountdown('2026-11-17T23:12:00Z', now)).toBe('Reseta em 3h 12m');
    expect(formatResetCountdown('2026-11-17T22:00:00Z', now)).toBe('Reseta em 2h');
    expect(formatResetCountdown('2026-11-19T23:00:00Z', now)).toBe('Reseta em 2d 3h');
    expect(formatResetCountdown('2026-11-19T20:00:00Z', now)).toBe('Reseta em 2d');
  });

  it('formats last updated time and plan labels cleanly', () => {
    const now = Date.parse('2026-11-17T20:00:00Z');
    expect(formatLastUpdated(null, now)).toBe('Sem leitura');
    expect(formatLastUpdated('2026-11-17T19:59:30Z', now)).toBe('Atualizado agora');
    expect(formatLastUpdated('2026-11-17T19:48:00Z', now)).toBe('Atualizado há 12m');
    expect(formatLastUpdated('2026-11-17T17:00:00Z', now)).toBe('Atualizado há 3h');
    expect(formatLastUpdated('2026-11-15T20:00:00Z', now)).toBe('Atualizado há 2d');

    expect(formatPlanName('pro')).toBe('Pro');
    expect(formatPlanName('Business Pro Lite')).toBe('Business Pro Lite');
    expect(formatPlanName('   ')).toBeNull();
    expect(formatPlanName(null)).toBeNull();
  });

  it('positions portaled popover from toolbar trigger rect and clamps/flips within viewport', () => {
    const normal = computePopoverPosition(
      { left: 1120, right: 1148, top: 14, bottom: 42 },
      { width: 320, height: 260 },
      { width: 1280, height: 800 }
    );
    expect(normal).toEqual({ left: 828, top: 50 });

    const clampedLeft = computePopoverPosition(
      { left: 90, right: 100, top: 14, bottom: 42 },
      { width: 320, height: 260 },
      { width: 1280, height: 800 }
    );
    expect(clampedLeft).toEqual({ left: 8, top: 50 });

    const flippedAbove = computePopoverPosition(
      { left: 500, right: 520, top: 720, bottom: 748 },
      { width: 320, height: 260 },
      { width: 1280, height: 800 }
    );
    expect(flippedAbove).toEqual({ left: 200, top: 452 });
  });

  it('initializes agentUsageAtom empty and accepts snapshot updates', () => {
    const store = createStore();
    expect(store.get(agentUsageAtom)).toEqual(EMPTY_AGENT_USAGE_SNAPSHOT);

    const next: AgentUsageSnapshot = {
      providers: {
        claude: makeStatus(),
      },
      byTerminal: { 'term-1': 'claude' },
      updatedAt: '2026-11-17T20:00:00Z',
    };
    store.set(agentUsageAtom, next);
    expect(store.get(agentUsageAtom).byTerminal['term-1']).toBe('claude');
  });
});
