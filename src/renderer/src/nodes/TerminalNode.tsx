import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal as XTerm } from '@xterm/xterm';
import { toast } from 'sonner';
import {
  Bot,
  Crown,
  Info,
  Maximize2,
  MessageSquare,
  Minimize2,
  RotateCw,
  Search,
  Unlink,
  X,
} from 'lucide-react';
import { CHAT_THREAD_COLORS } from '../../../shared/constants';
import type {
  CanvasNode,
  ChatThreadColor,
  ChatThreadsState,
  ReachableListResponse,
  TerminalData,
  TerminalInspectInfo,
  TerminalTokenUsage,
  TokenUsageProvider,
} from '../../../shared/types';
import { PromptComposer, injectNoteMentions } from '../components/PromptComposer';
import { getContextTone } from '../components/AgentUsageRing';
import {
  activeLevelAtom,
  activeWorkspaceAtom,
  activityStateAtom,
  asksInFlightAtom,
  preferencesAtom,
  rolesAtom,
  tokenUsageAtom,
  type PromptImageAttachment,
} from '../state/atoms';
import { NodeFrame } from './NodeFrame';

function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 999_950) return `${(count / 1000).toFixed(1)}k`;
  if (count < 999_950_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${(count / 1_000_000_000).toFixed(1)}B`;
}

function formatExactTokenCount(count: number): string {
  return `${Math.round(count).toLocaleString('en-US')} tokens`;
}

function formatSessionFileLabel(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function providerDisplayName(provider: TokenUsageProvider): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Gemini';
}

const TokenUsageBreakdown: React.FC<{ usage: TerminalTokenUsage }> = ({ usage }) => {
  const pct = usage.contextWindow > 0 ? (usage.contextTokens / usage.contextWindow) * 100 : 0;
  const pctRounded = Math.round(pct);
  const barWidth = Math.max(0, Math.min(100, pct));
  const tone = getContextTone(pct);

  const metricRows: Array<{ label: string; value: string; title?: string }> = [
    { label: 'Input', value: formatTokenCount(usage.inputTokens), title: formatExactTokenCount(usage.inputTokens) },
    { label: 'Output', value: formatTokenCount(usage.outputTokens), title: formatExactTokenCount(usage.outputTokens) },
    {
      label: 'Cache read',
      value: formatTokenCount(usage.cacheReadTokens),
      title: formatExactTokenCount(usage.cacheReadTokens),
    },
    {
      label: 'Cache write',
      value: formatTokenCount(usage.cacheWriteTokens),
      title: formatExactTokenCount(usage.cacheWriteTokens),
    },
    { label: 'Total', value: formatTokenCount(usage.totalTokens), title: formatExactTokenCount(usage.totalTokens) },
    { label: 'Turns', value: String(usage.turns) },
  ];

  return (
    <div className="space-y-1.5 text-[11px] text-[var(--muted-foreground)]">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span>Context</span>
          <span className={`font-mono tabular-nums ${tone.textClass}`}>
            {formatTokenCount(usage.contextTokens)} / {formatTokenCount(usage.contextWindow)} ({pctRounded}%)
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--border-strong)]">
          <div className={`h-full rounded-full ${tone.barClass}`} style={{ width: `${barWidth}%` }} />
        </div>
      </div>

      <div className="space-y-1 pt-0.5">
        {metricRows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2">
            <span>{row.label}</span>
            <span
              className="font-mono tabular-nums text-[var(--foreground)]"
              title={row.title}
            >
              {row.value}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0">Model</span>
          <span
            className="min-w-0 truncate font-mono text-[10px] text-[var(--foreground)]"
            title={usage.model ?? 'Unknown'}
          >
            {usage.model ?? '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0">File</span>
          <span
            className="min-w-0 truncate font-mono text-[10px] text-[var(--foreground)]"
            title={usage.sessionFile}
          >
            {formatSessionFileLabel(usage.sessionFile)}
          </span>
        </div>
      </div>
    </div>
  );
};

export const TerminalContentBody: React.FC<{
  workspaceId: string;
  terminal: TerminalData;
  nodeId: string;
  isLifted?: boolean;
  hideHeader?: boolean;
  startDrag?: (e: React.PointerEvent) => void;
  toggleLift?: () => void;
}> = ({
  workspaceId,
  terminal,
  nodeId,
  isLifted = false,
  hideHeader = false,
  startDrag,
  toggleLift,
}) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const prefs = useAtomValue(preferencesAtom);
  const activity = useAtomValue(activityStateAtom);
  const asksInFlight = useAtomValue(asksInFlightAtom);
  const roles = useAtomValue(rolesAtom);
  const tokenUsageMap = useAtomValue(tokenUsageAtom);

  const nodeContainerRef = useRef<HTMLDivElement | null>(null);
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const lastSentGridRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const syncFitRef = useRef<((forceRefresh?: boolean) => void) | null>(null);

  const [nodeHeight, setNodeHeight] = useState(390);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(terminal.name);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [peers, setPeers] = useState<ReachableListResponse | null>(null);
  const [chatState, setChatState] = useState<ChatThreadsState | null>(null);
  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [inspectInfo, setInspectInfo] = useState<TerminalInspectInfo | null>(null);
  const [tokenPopoverPinned, setTokenPopoverPinned] = useState(false);
  const [tokenBadgeHovered, setTokenBadgeHovered] = useState(false);
  const tokenPopoverRef = useRef<HTMLDivElement | null>(null);

  const isRunning = activity.active.includes(terminal.id);
  const isWorking = activity.working.includes(terminal.id);
  const needsAttention = activity.attention.includes(terminal.id);
  const attentionReason =
    (
      activity as typeof activity & {
        attentionReasons?: Record<string, string>;
      }
    ).attentionReasons?.[terminal.id] ?? null;
  const statusTooltip = needsAttention
    ? attentionReason || 'Needs attention'
    : isWorking
      ? 'Working'
      : isRunning
        ? 'Running'
        : 'Stopped';
  const tokenUsage = tokenUsageMap[terminal.id] ?? null;
  const contextPct =
    tokenUsage && tokenUsage.contextWindow > 0
      ? (tokenUsage.contextTokens / tokenUsage.contextWindow) * 100
      : 0;
  const contextPctRounded = Math.round(contextPct);
  const contextBarWidth = Math.max(0, Math.min(100, contextPct));
  const contextTone = getContextTone(contextPct);
  const showTokenPopover = Boolean(tokenUsage && (tokenPopoverPinned || tokenBadgeHovered));

  useEffect(() => {
    if (!tokenPopoverPinned) return;
    const handlePointerDown = (ev: PointerEvent) => {
      if (tokenPopoverRef.current && !tokenPopoverRef.current.contains(ev.target as Node)) {
        setTokenPopoverPinned(false);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setTokenPopoverPinned(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [tokenPopoverPinned]);

  const activeAskStatus = useMemo(() => {
    for (const ask of Object.values(asksInFlight)) {
      if (ask.fromTerminalId.toLowerCase() === terminal.id.toLowerCase()) {
        const target = workspace?.nodes.find(
          (n) => n.content.kind === 'terminal' && n.content.terminal.id === ask.toTerminalId
        );
        const name =
          target?.content.kind === 'terminal' ? target.content.terminal.name : 'Teammate';
        return `Talking to ${name}…`;
      }
      if (ask.toTerminalId.toLowerCase() === terminal.id.toLowerCase()) {
        const sender = workspace?.nodes.find(
          (n) => n.content.kind === 'terminal' && n.content.terminal.id === ask.fromTerminalId
        );
        const name =
          sender?.content.kind === 'terminal' ? sender.content.terminal.name : 'Peer';
        return `Answering ${name}…`;
      }
    }
    return null;
  }, [asksInFlight, terminal.id, workspace]);

  useEffect(() => {
    setDraftName(terminal.name);
  }, [terminal.name]);

  // Mount Xterm.js & connect to node-pty
  useEffect(() => {
    const container = termContainerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      rescaleOverlappingGlyphs: true,
      theme:
        prefs.theme === 'light'
          ? {
              background: '#ffffff',
              foreground: '#1d1d1f',
              cursor: '#007aff',
              selectionBackground: 'rgba(0, 122, 255, 0.22)',
            }
          : {
              background: '#141519',
              foreground: '#ededed',
              cursor: '#0a84ff',
              selectionBackground: 'rgba(10, 132, 255, 0.28)',
            },
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(container);

    xtermRef.current = term;
    fitAddonRef.current = fit;
    searchAddonRef.current = search;

    let cancelled = false;
    let spawned = false;
    let resizeTimer: number | null = null;

    const syncFit = (forceRefresh = false) => {
      if (cancelled || container.clientWidth <= 0 || container.clientHeight <= 0) return;
      try {
        const proposed = fit.proposeDimensions();
        if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
        const cols = Math.max(20, Math.floor(proposed.cols));
        const rows = Math.max(4, Math.floor(proposed.rows));
        const gridChanged = term.cols !== cols || term.rows !== rows;
        if (gridChanged) {
          term.resize(cols, rows);
        }
        if (gridChanged || forceRefresh) {
          term.refresh(0, Math.max(0, term.rows - 1));
        }
        if (
          spawned &&
          (lastSentGridRef.current.cols !== cols || lastSentGridRef.current.rows !== rows)
        ) {
          lastSentGridRef.current = { cols, rows };
          void window.maestri.terminal.resize(terminal.id, cols, rows);
        }
      } catch {
        // ignore layout race
      }
    };
    syncFitRef.current = syncFit;

    const unsubData = window.maestri.terminal.onData((ev) => {
      if (!cancelled && ev.terminalId === terminal.id) {
        term.write(ev.data);
      }
    });

    const inputDisposable = term.onData((data) => {
      window.maestri.terminal.write(terminal.id, data);
    });

    const bootTerminal = async () => {
      if (cancelled) return;
      syncFit(true);
      await window.maestri.terminal.spawn({
        workspaceId,
        terminalId: terminal.id,
        cols: term.cols,
        rows: term.rows,
      });
      if (cancelled) return;
      spawned = true;
      lastSentGridRef.current = { cols: term.cols, rows: term.rows };

      const scrollback = await window.maestri.terminal.getScrollback(terminal.id);
      if (cancelled) return;
      if (scrollback) {
        term.write(scrollback, () => {
          if (cancelled) return;
          term.refresh(0, Math.max(0, term.rows - 1));
          term.scrollToBottom();
        });
      }
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        void document.fonts.ready.then(() => {
          if (!cancelled) syncFit(true);
        });
      }
    };

    const rafId = window.requestAnimationFrame(() => {
      void bootTerminal();
    });

    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (!cancelled) syncFit(true);
      }, 80);
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      syncFitRef.current = null;
      window.cancelAnimationFrame(rafId);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      ro.disconnect();
      inputDisposable.dispose();
      unsubData();
      term.dispose();
      xtermRef.current = null;
    };
  }, [terminal.id]);

  // Refit when lifted focus or chat mode changes
  useEffect(() => {
    const id = window.setTimeout(() => {
      syncFitRef.current?.(true);
    }, 60);
    return () => window.clearTimeout(id);
  }, [isLifted, terminal.inChatMode]);

  // Update font/theme dynamically
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.fontFamily = prefs.fontFamily;
    term.options.fontSize = prefs.fontSize;
    term.options.theme =
      prefs.theme === 'light'
        ? {
            background: '#ffffff',
            foreground: '#1d1d1f',
            cursor: '#007aff',
            selectionBackground: 'rgba(0, 122, 255, 0.22)',
          }
        : {
            background: '#141519',
            foreground: '#ededed',
            cursor: '#0a84ff',
            selectionBackground: 'rgba(10, 132, 255, 0.28)',
          };
    const raf = window.requestAnimationFrame(() => syncFitRef.current?.(true));
    return () => window.cancelAnimationFrame(raf);
  }, [prefs.fontFamily, prefs.fontSize, prefs.theme]);

  // Chat state sync
  useEffect(() => {
    if (!terminal.inChatMode) return;
    void window.maestri.chat.getState(terminal.id).then(setChatState);
    const unsub = window.maestri.chat.onEvent((ev) => {
      if (ev.terminalId === terminal.id) {
        void window.maestri.chat.getState(terminal.id).then(setChatState);
      }
    });
    return unsub;
  }, [terminal.id, terminal.inChatMode]);

  useEffect(() => {
    const el = nodeContainerRef.current;
    if (!el) return;
    const updateHeight = () => {
      const h = el.clientHeight;
      if (h > 0) {
        setNodeHeight((prev) => (Math.abs(prev - h) >= 4 ? h : prev));
      }
    };
    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleSendComposer = async (
    rawText: string,
    attachments: PromptImageAttachment[]
  ): Promise<boolean> => {
    const allNodes = workspace
      ? [...workspace.nodes, ...workspace.floors.flatMap((f) => f.nodes)]
      : [];
    const withNotes = injectNoteMentions(rawText, allNodes);
    const attachmentBlocks = attachments
      .filter((a) => Boolean(a.filePath))
      .map((a) => `<attached_image path="${a.filePath}" />`);
    const parts = [withNotes, ...attachmentBlocks].filter((p) => p.length > 0);
    const text = parts.join('\n\n');
    if (!text) return false;

    if (terminal.inChatMode) {
      const slot = chatState?.activeSlot ?? 'blue';
      await window.maestri.chat.send(terminal.id, slot, text);
      return true;
    }
    const delivered = await window.maestri.terminal.deliverPrompt(terminal.id, text);
    if (!delivered) {
      toast.error('Terminal is not running');
    }
    return delivered;
  };

  const toggleInspector = async () => {
    const next = !showInspector;
    setShowInspector(next);
    if (next) {
      const [info, p] = await Promise.all([
        window.maestri.terminal.inspect(terminal.id),
        window.maestri.interAgent.listPeers(workspaceId, terminal.id),
      ]);
      setInspectInfo(info);
      setPeers(p);
    }
  };

  const activeFloor = workspace?.activeFloorId
    ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
    : null;
  const workspaceDir =
    terminal.workingDirectory || activeFloor?.clonePath || workspace?.workingDirectory || '';

  return (
    <div
      ref={nodeContainerRef}
      className="flex h-full w-full flex-col overflow-hidden rounded-lg bg-[#141519]"
    >
      {/* Header (28px Maestri rail) */}
      {!hideHeader && (
        <div
          onPointerDown={startDrag}
          className="relative flex h-7 shrink-0 cursor-grab items-center justify-between gap-2 border-b border-[var(--border)] bg-white/[0.03] px-2.5 active:cursor-grabbing"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              title={statusTooltip}
              className="relative flex size-2 shrink-0 items-center justify-center"
            >
              {needsAttention && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--destructive)] opacity-55" />
              )}
              <span
                className={`relative size-2 rounded-full ${
                  needsAttention
                    ? 'bg-[var(--destructive)]'
                    : isWorking
                      ? 'bg-[var(--warning)]'
                      : isRunning
                        ? 'bg-[var(--success)]'
                        : 'bg-[var(--muted-foreground)]/40'
                }`}
              />
            </span>

            {editingName ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={() => {
                  setEditingName(false);
                  if (draftName.trim() && draftName !== terminal.name) {
                    void window.maestri.terminal.updateData(workspaceId, terminal.id, {
                      name: draftName.trim(),
                    });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="w-28 rounded bg-[var(--input)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--foreground)] outline-none"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingName(true);
                }}
                className="truncate text-[12px] font-medium text-[var(--foreground)] hover:underline"
                title="Double click to rename"
              >
                {terminal.name}
              </button>
            )}

            {terminal.isManager && <Crown className="size-3 shrink-0 text-[#ff9f0a]" />}

            {terminal.agentType !== 'shell' && (
              <span className="h-[18px] shrink-0 rounded-full bg-white/[0.06] px-2 text-[10px] font-medium leading-[18px] text-[var(--muted-foreground)] capitalize">
                {terminal.agentType === 'antigravity' ? 'Antigravity' : terminal.agentType}
              </span>
            )}

            {terminal.roleName && (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setShowRoleMenu((v) => !v)}
                className="h-[18px] shrink-0 rounded-full bg-white/[0.08] px-2 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                title="Change role"
              >
                {terminal.roleName}
              </button>
            )}

            {activeAskStatus && (
              <span className="truncate text-[10px] text-[var(--muted-foreground)]">
                {activeAskStatus}
              </span>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {tokenUsage && (
              <div
                ref={tokenPopoverRef}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseEnter={() => setTokenBadgeHovered(true)}
                onMouseLeave={() => setTokenBadgeHovered(false)}
                className="relative shrink-0"
              >
                <button
                  type="button"
                  onClick={() => {
                    setTokenPopoverPinned((v) => !v);
                    setShowInspector(false);
                    setShowRoleMenu(false);
                  }}
                  title={`${providerDisplayName(tokenUsage.provider)} context: ${formatExactTokenCount(tokenUsage.contextTokens)} (${contextPctRounded}%)`}
                  className={`flex h-5 items-center gap-1.5 rounded-[5px] border bg-white/[0.04] px-1.5 font-mono text-[10px] leading-none tabular-nums transition-colors hover:bg-[var(--bg-hover)] ${contextTone.borderClass}`}
                >
                  <span className={contextTone.textClass}>
                    {formatTokenCount(tokenUsage.contextTokens)}
                  </span>
                  <span
                    className={
                      contextPct > 70 ? contextTone.textClass : 'text-[var(--muted-foreground)]'
                    }
                  >
                    {contextPctRounded}%
                  </span>
                  <span className="h-1 w-6 overflow-hidden rounded-full bg-[var(--border-strong)]">
                    <span
                      className={`block h-full rounded-full ${contextTone.barClass}`}
                      style={{ width: `${contextBarWidth}%` }}
                    />
                  </span>
                </button>

                {showTokenPopover && (
                  <div className="absolute right-0 top-full z-40 pt-1">
                    <div className="glass-strong w-64 rounded-lg p-3 text-[11px] shadow-2xl">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--foreground)]">
                          {providerDisplayName(tokenUsage.provider)} tokens
                        </span>
                        {tokenPopoverPinned && (
                          <button
                            type="button"
                            onClick={() => {
                              setTokenPopoverPinned(false);
                              setTokenBadgeHovered(false);
                            }}
                            className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)]"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </div>
                      <TokenUsageBreakdown usage={tokenUsage} />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div
              onPointerDown={(e) => e.stopPropagation()}
              className={`relative flex shrink-0 items-center gap-0.5 transition-opacity ${
                showInspector || showRoleMenu || showFind
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100'
              }`}
            >
            <button
              type="button"
              onClick={() => {
                setShowRoleMenu((v) => !v);
                setShowInspector(false);
                setTokenPopoverPinned(false);
                setTokenBadgeHovered(false);
              }}
              title="Assign role"
              className={`flex size-5 items-center justify-center rounded transition-colors ${
                showRoleMenu
                  ? 'bg-[var(--bg-hover)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <Bot className="size-3" />
            </button>

            {showRoleMenu && (
              <div className="glass-strong absolute right-0 top-7 z-40 w-44 rounded-lg p-1 shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    setShowRoleMenu(false);
                    void window.maestri.terminal.updateData(workspaceId, terminal.id, {
                      roleId: null,
                      roleName: null,
                    });
                  }}
                  className="w-full rounded-md px-2 py-1 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)]"
                >
                  None
                </button>
                {roles.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setShowRoleMenu(false);
                      void window.maestri.terminal.updateData(workspaceId, terminal.id, {
                        roleId: r.id,
                        roleName: r.name,
                      });
                    }}
                    className="w-full truncate rounded-md px-2 py-1 text-left text-xs text-[var(--foreground)] hover:bg-[var(--bg-hover)]"
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}

            {/* Maestro Mode Toggle */}
            <button
              type="button"
              onClick={() =>
                void window.maestri.terminal.updateData(workspaceId, terminal.id, {
                  isManager: !terminal.isManager,
                })
              }
              title={terminal.isManager ? 'Maestro mode active' : 'Enable Maestro mode'}
              className={`flex size-5 items-center justify-center rounded transition-colors ${
                terminal.isManager
                  ? 'text-[#ff9f0a] hover:bg-[var(--bg-hover)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <Crown className="size-3" />
            </button>

            {/* Chat Mode Toggle */}
            <button
              type="button"
              onClick={() =>
                void window.maestri.terminal.updateData(workspaceId, terminal.id, {
                  inChatMode: !terminal.inChatMode,
                })
              }
              title={terminal.inChatMode ? 'Switch to shell' : 'Switch to chat'}
              className={`flex size-5 items-center justify-center rounded transition-colors ${
                terminal.inChatMode
                  ? 'bg-[var(--bg-hover)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <MessageSquare className="size-3" />
            </button>

            <button
              type="button"
              onClick={() => setShowFind((v) => !v)}
              title="Find"
              className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <Search className="size-3" />
            </button>

            <button
              type="button"
              onClick={() => {
                setShowRoleMenu(false);
                setTokenPopoverPinned(false);
                setTokenBadgeHovered(false);
                void toggleInspector();
              }}
              title="Inspect PTY"
              className={`flex size-5 items-center justify-center rounded transition-colors ${
                showInspector
                  ? 'bg-[var(--bg-hover)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
              }`}
            >
              <Info className="size-3" />
            </button>

            {showInspector && (
              <div className="glass-strong absolute right-0 top-7 z-40 max-h-72 w-72 overflow-y-auto rounded-lg p-3 text-[11px] shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-[var(--foreground)]">Terminal inspector</span>
                  <button
                    type="button"
                    onClick={() => setShowInspector(false)}
                    className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)]"
                  >
                    <X className="size-3" />
                  </button>
                </div>
                <div className="space-y-1 text-[var(--muted-foreground)]">
                  <div className="flex justify-between">
                    <span>Status:</span>
                    <span
                      className={`font-medium tabular-nums ${
                        needsAttention
                          ? 'text-[var(--destructive)]'
                          : 'text-[var(--foreground)]'
                      }`}
                    >
                      {needsAttention
                        ? 'Needs attention'
                        : isWorking
                          ? 'Working'
                          : isRunning
                            ? 'Running'
                            : 'Stopped'}
                      {inspectInfo?.pid ? ` (PID ${inspectInfo.pid})` : ''}
                    </span>
                  </div>
                  {needsAttention && attentionReason && (
                    <div className="truncate text-[10px] text-[var(--destructive)]" title={attentionReason}>
                      {attentionReason}
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>Grid:</span>
                    <span className="font-mono tabular-nums text-[var(--foreground)]">
                      {inspectInfo ? `${inspectInfo.cols}×${inspectInfo.rows}` : '—'}
                    </span>
                  </div>
                  <div>
                    <div className="opacity-75">CWD:</div>
                    <div className="truncate font-mono text-[10px] text-[var(--foreground)]">
                      {inspectInfo?.cwd || terminal.workingDirectory}
                    </div>
                  </div>
                  <div>
                    <div className="opacity-75">MAESTRI_PIPE:</div>
                    <div className="truncate font-mono text-[10px] text-[var(--foreground)]">
                      {inspectInfo?.pipeEnv || '—'}
                    </div>
                  </div>
                </div>

                <div className="my-2 border-t border-[var(--border)]" />
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Tokens
                  </span>
                  {tokenUsage && (
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      {providerDisplayName(tokenUsage.provider)}
                    </span>
                  )}
                </div>
                {tokenUsage ? (
                  <TokenUsageBreakdown usage={tokenUsage} />
                ) : (
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    No token usage recorded
                  </div>
                )}

                <div className="my-2 border-t border-[var(--border)]" />
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Connections
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void window.maestri.connection.removeAllFor(workspaceId, nodeId);
                      setShowInspector(false);
                    }}
                    className="text-[10px] text-[var(--destructive)] hover:underline"
                  >
                    Disconnect all
                  </button>
                </div>
                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {level.connections
                    .filter((c) => c.terminalIdA === terminal.id || c.terminalIdB === terminal.id)
                    .map((c) => {
                      const peerId = c.terminalIdA === terminal.id ? c.terminalIdB : c.terminalIdA;
                      const peerNode = level.nodes.find(
                        (n) =>
                          n.id === peerId ||
                          (n.content.kind === 'terminal' && n.content.terminal.id === peerId)
                      );
                      const peerLabel =
                        peerNode?.content.kind === 'terminal'
                          ? peerNode.content.terminal.name
                          : peerNode?.content.kind === 'band'
                            ? peerNode.content.band.name
                            : peerId.slice(0, 8);
                      return (
                        <div
                          key={c.id}
                          className="flex items-center justify-between rounded-md bg-[var(--secondary)] px-2 py-1"
                        >
                          <span className="truncate">{peerLabel}</span>
                          <button
                            type="button"
                            onClick={() => void window.maestri.connection.delete(workspaceId, c.id)}
                            title="Disconnect"
                            className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                          >
                            <Unlink className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                  {level.noteConnections
                    .filter((c) => c.terminalId === terminal.id)
                    .map((c) => {
                      const nn = level.nodes.find((n) => n.id === c.noteNodeId);
                      const label =
                        nn?.content.kind === 'stickyNote'
                          ? nn.content.stickyNote.customName || nn.content.stickyNote.fileName
                          : nn?.content.kind === 'noteStack'
                            ? nn.content.noteStack.name
                            : 'Note';
                      return (
                        <div
                          key={c.id}
                          className="flex items-center justify-between rounded-md bg-[var(--secondary)] px-2 py-1"
                        >
                          <span className="truncate text-[var(--muted-foreground)]">Note: {label}</span>
                          <button
                            type="button"
                            onClick={() => void window.maestri.connection.delete(workspaceId, c.id)}
                            title="Disconnect"
                            className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                          >
                            <Unlink className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                  {peers?.terminals.length === 0 && peers?.notes.length === 0 && (
                    <div className="text-[10px] text-[var(--muted-foreground)]">No connections</div>
                  )}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => void window.maestri.terminal.restart(workspaceId, terminal.id)}
              title="Restart"
              className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
            >
              <RotateCw className="size-3" />
            </button>

            {toggleLift && (
              <button
                type="button"
                onClick={toggleLift}
                title={isLifted ? 'Return to canvas' : 'Focus'}
                className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
              >
                {isLifted ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
              </button>
            )}

            <button
              type="button"
              onClick={() => void window.maestri.node.deleteMany(workspaceId, [nodeId])}
              title="Close"
              className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--destructive)]"
            >
              <X className="size-3" />
            </button>
            </div>
          </div>
        </div>
      )}

      {/* Find bar */}
      {showFind && !terminal.inChatMode && (
        <div
          className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Search className="size-3.5 text-[var(--muted-foreground)]" />
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              searchAddonRef.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') searchAddonRef.current?.findNext(findQuery);
              if (e.key === 'Escape') setShowFind(false);
            }}
            placeholder="Search scrollback..."
            className="flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none"
          />
          <button
            type="button"
            onClick={() => setShowFind(false)}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Body: XTerm OR ChatFace */}
      <div className="relative flex-1 overflow-hidden">
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            xtermRef.current?.focus();
          }}
          className={`h-full w-full overflow-hidden p-2 ${terminal.inChatMode ? 'hidden' : 'block'}`}
        >
          <div ref={termContainerRef} className="h-full w-full overflow-hidden" />
        </div>

        {terminal.inChatMode && chatState && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex h-full w-full flex-col bg-[var(--background)]"
          >
            {/* 7 Color Thread Dots */}
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                {CHAT_THREAD_COLORS.map((tc) => {
                  const active = chatState.activeSlot === tc.key;
                  const count = chatState.threads[tc.key]?.length ?? 0;
                  return (
                    <button
                      key={tc.key}
                      type="button"
                      onClick={() =>
                        void window.maestri.chat
                          .switchThread(terminal.id, tc.key as ChatThreadColor)
                          .then(setChatState)
                      }
                      title={`${tc.label} thread (${count} messages)`}
                      className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] transition-all ${
                        active ? 'ring-1 ring-[var(--foreground)]/50 bg-[var(--secondary)]' : 'opacity-65 hover:opacity-100'
                      }`}
                    >
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: tc.hex }}
                      />
                      {count > 0 && <span>{count}</span>}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() =>
                  void window.maestri.chat
                    .clearThread(terminal.id, chatState.activeSlot)
                    .then(() => window.maestri.chat.getState(terminal.id).then(setChatState))
                }
                className="text-[10px] text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
              >
                Clear
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-3 text-xs">
              {(chatState.threads[chatState.activeSlot] ?? []).length === 0 ? (
                <div className="flex h-full items-center justify-center text-center text-[var(--muted-foreground)]">
                  <div>
                    <p className="font-medium text-[var(--foreground)]">
                      Maestri Chat ({chatState.activeSlot} thread)
                    </p>
                    <p className="mt-1 text-[11px]">
                      Messages sent here carry the Maestri Chat header so agents reply with{' '}
                      <code>maestri say</code>.
                    </p>
                  </div>
                </div>
              ) : (
                chatState.threads[chatState.activeSlot].map((entry) => (
                  <div
                    key={entry.id}
                    className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[84%] whitespace-pre-wrap rounded-2xl px-3 py-2 ${
                        entry.role === 'user'
                          ? 'bg-[var(--accent)] text-white'
                          : 'bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)]'
                      }`}
                    >
                      {entry.text}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Prompt Composer */}
      <PromptComposer
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        terminalId={terminal.id}
        inChatMode={terminal.inChatMode}
        maxTextareaHeight={Math.max(48, Math.floor(nodeHeight * 0.4))}
        onSend={handleSendComposer}
      />
    </div>
  );
};

export const TerminalNode: React.FC<{ node: CanvasNode }> = ({ node }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  if (node.content.kind !== 'terminal' || !workspace) return null;
  const terminal = node.content.terminal;

  return (
    <NodeFrame node={node} minWidth={340} minHeight={240}>
      {({ startDrag, isLifted, toggleLift }) => (
        <TerminalContentBody
          workspaceId={workspace.id}
          terminal={terminal}
          nodeId={node.id}
          isLifted={isLifted}
          startDrag={startDrag}
          toggleLift={toggleLift}
        />
      )}
    </NodeFrame>
  );
};
