import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Bookmark, Bot, Globe, Send, StickyNote, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { CanvasNode, ReachableListResponse } from '../../../shared/types';
import {
  promptAttachmentsAtom,
  promptDraftsAtom,
  savedPromptsAtom,
  type PromptImageAttachment,
} from '../state/atoms';

export interface SavePastedImageRequest {
  workspaceId: string;
  workspaceDir: string;
  terminalId: string;
  fileName: string;
  mimeType: 'image/png';
  base64Data: string;
}

export interface SavePastedImageResponse {
  ok: boolean;
  filePath?: string;
  error?: string;
  pendingMainIpc?: boolean;
}

interface OrkestreiBridgeWithPastedImage {
  terminal?: {
    savePastedImage?: (req: SavePastedImageRequest) => Promise<SavePastedImageResponse>;
  };
}

let notifiedMissingImageIpc = false;

async function savePastedImageViaMainIpc(
  req: SavePastedImageRequest
): Promise<SavePastedImageResponse> {
  const bridge = window.orkestrei as unknown as OrkestreiBridgeWithPastedImage;
  if (typeof bridge.terminal?.savePastedImage === 'function') {
    return bridge.terminal.savePastedImage(req);
  }
  // Typed stub: saving binary PNG files into workspace temp requires main/preload IPC
  // `orkestrei:terminal:savePastedImage` (src/main/** is outside UI Dev scope).
  return {
    ok: false,
    pendingMainIpc: true,
    error: 'IPC orkestrei:terminal:savePastedImage not wired in main yet',
  };
}

interface MentionCandidate {
  key: string;
  kind: 'agent' | 'note' | 'portal';
  name: string;
  detail: string;
}

export interface ActiveMentionQuery {
  start: number;
  end: number;
  query: string;
}

export function extractMentionQuery(value: string, cursorPos: number): ActiveMentionQuery | null {
  const before = value.slice(0, cursorPos);
  const match = before.match(/(?:^|\s)@(?:"([^"\n]*)|([^\s@\n"]*))$/);
  if (!match || match.index === undefined) return null;
  const leadingSpace = /^\s/.test(match[0]) ? 1 : 0;
  const start = match.index + leadingSpace;
  const query = (match[1] ?? match[2] ?? '').toLowerCase();
  return { start, end: cursorPos, query };
}

export function formatMentionToken(name: string): string {
  return /\s/.test(name) ? `@"${name}" ` : `@${name} `;
}

export function injectNoteMentions(rawPrompt: string, nodes: CanvasNode[]): string {
  if (!rawPrompt.includes('@')) return rawPrompt;
  const allNotes = nodes.filter((n) => n.content.kind === 'stickyNote');
  if (allNotes.length === 0) return rawPrompt;

  const mentionedNames: string[] = [];
  const rx = /@"([^"]+)"|@([^\s@",;!?()[\]{}<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(rawPrompt)) !== null) {
    const captured = (m[1] || m[2] || '').trim().toLowerCase();
    if (captured) mentionedNames.push(captured);
  }
  if (mentionedNames.length === 0) return rawPrompt;

  const attachedIds = new Set<string>();
  const blocks: string[] = [];
  for (const token of mentionedNames) {
    const candidates = token.endsWith('.') ? [token, token.slice(0, -1)] : [token];
    const matched = allNotes.find((n) => {
      if (n.content.kind !== 'stickyNote') return false;
      const sn = n.content.stickyNote;
      const disp = (
        sn.customName || sn.fileName.replace(/\.(?:md|markdown|txt)$/i, '')
      ).toLowerCase();
      const fileLower = sn.fileName.toLowerCase();
      return candidates.some(
        (cand) => disp === cand || fileLower === cand || fileLower === `${cand}.md`
      );
    });
    if (matched && matched.content.kind === 'stickyNote' && !attachedIds.has(matched.id)) {
      attachedIds.add(matched.id);
      const sn = matched.content.stickyNote;
      const label = sn.customName || sn.fileName;
      blocks.push(`<attached_note name="${label}">\n${sn.text}\n</attached_note>`);
    }
  }
  return blocks.length > 0 ? `${rawPrompt}\n\n${blocks.join('\n\n')}` : rawPrompt;
}

function buildMentionCandidates(peers: ReachableListResponse | null): MentionCandidate[] {
  if (!peers) return [];
  const items: MentionCandidate[] = [];

  for (const t of peers.terminals) {
    const label = t.farAddress ?? t.name;
    items.push({
      key: `agent:${t.id}`,
      kind: 'agent',
      name: label,
      detail: t.role || (t.agentType !== 'shell' ? t.agentType : 'Agent'),
    });
  }
  for (const fp of peers.farPeers ?? []) {
    const label = fp.farAddress ?? fp.name;
    items.push({
      key: `far:${fp.id}`,
      kind: 'agent',
      name: label,
      detail: fp.workspaceName ? `Agent · ${fp.workspaceName}` : 'Remote agent',
    });
  }
  for (const n of peers.notes) {
    items.push({
      key: `note:${n.id}`,
      kind: 'note',
      name: n.name,
      detail: n.fichario ? `Note · ${n.fichario}` : 'Note',
    });
  }
  for (const p of peers.portals) {
    items.push({
      key: `portal:${p.id}`,
      kind: 'portal',
      name: p.name,
      detail: p.summary || 'Portal',
    });
  }
  return items;
}

async function blobToPngPayload(
  blob: Blob
): Promise<{ dataUrl: string; base64Data: string; width: number; height: number }> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode pasted image'));
      el.src = objectUrl;
    });
    const width = Math.max(1, img.naturalWidth || 1);
    const height = Math.max(1, img.naturalHeight || 1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      return { dataUrl, base64Data, width, height };
    }
  } catch {
    // fallback to FileReader below
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read pasted image'));
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(',');
  const base64Data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { dataUrl, base64Data, width: 0, height: 0 };
}

export interface PromptComposerProps {
  workspaceId: string;
  workspaceDir: string;
  terminalId: string;
  inChatMode: boolean;
  maxTextareaHeight: number;
  onSend: (rawText: string, attachments: PromptImageAttachment[]) => Promise<boolean>;
}

export const PromptComposer: React.FC<PromptComposerProps> = ({
  workspaceId,
  workspaceDir,
  terminalId,
  inChatMode,
  maxTextareaHeight,
  onSend,
}) => {
  const savedPrompts = useAtomValue(savedPromptsAtom);
  const [drafts, setDrafts] = useAtom(promptDraftsAtom);
  const [attachmentsByTerminal, setAttachmentsByTerminal] = useAtom(promptAttachmentsAtom);

  const draft = drafts[terminalId] ?? '';
  const attachments = attachmentsByTerminal[terminalId] ?? [];

  const [mentionQuery, setMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [peers, setPeers] = useState<ReachableListResponse | null>(null);
  const [activeMentionIdx, setActiveMentionIdx] = useState(0);
  const [showPromptsMenu, setShowPromptsMenu] = useState(false);
  const [newPromptTitle, setNewPromptTitle] = useState('');
  const [sending, setSending] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionListRef = useRef<HTMLDivElement | null>(null);
  const pasteSeqRef = useRef(0);

  const setDraft = (updater: string | ((prev: string) => string)) => {
    setDrafts((prev) => {
      const current = prev[terminalId] ?? '';
      const nextVal = typeof updater === 'function' ? updater(current) : updater;
      if (nextVal === current) return prev;
      const next = { ...prev };
      if (nextVal.length === 0) {
        delete next[terminalId];
      } else {
        next[terminalId] = nextVal;
      }
      return next;
    });
  };

  const setTerminalAttachments = (
    updater:
      | PromptImageAttachment[]
      | ((prev: PromptImageAttachment[]) => PromptImageAttachment[])
  ) => {
    setAttachmentsByTerminal((prev) => {
      const current = prev[terminalId] ?? [];
      const nextList = typeof updater === 'function' ? updater(current) : updater;
      const next = { ...prev };
      if (nextList.length === 0) {
        delete next[terminalId];
      } else {
        next[terminalId] = nextList;
      }
      return next;
    });
  };

  const allCandidates = useMemo(() => buildMentionCandidates(peers), [peers]);

  const filteredMentions = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query;
    if (!q) return allCandidates;
    return allCandidates.filter(
      (item) =>
        item.name.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q)
    );
  }, [allCandidates, mentionQuery]);

  const showMentionsPopup = mentionQuery !== null && filteredMentions.length > 0;

  useEffect(() => {
    setActiveMentionIdx(0);
  }, [mentionQuery?.query, filteredMentions.length]);

  useEffect(() => {
    if (!showMentionsPopup || !mentionListRef.current) return;
    const activeEl = mentionListRef.current.querySelector<HTMLElement>(
      `[data-mention-idx="${activeMentionIdx}"]`
    );
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeMentionIdx, showMentionsPopup]);

  useEffect(() => {
    if (!showPromptsMenu && !mentionQuery) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setShowPromptsMenu(false);
        setMentionQuery(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [showPromptsMenu, mentionQuery]);

  // Auto-expand textarea up to ~40% of node height
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cappedMax = Math.max(48, maxTextareaHeight);
    el.style.height = '0px';
    const nextHeight = Math.max(20, Math.min(el.scrollHeight, cappedMax));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > cappedMax ? 'auto' : 'hidden';
  }, [draft, maxTextareaHeight, attachments.length]);

  const refreshMentionState = (nextText: string, cursorPos: number) => {
    const extracted = extractMentionQuery(nextText, cursorPos);
    if (!extracted) {
      setMentionQuery(null);
      return;
    }
    const wasClosed = mentionQuery === null;
    setMentionQuery(extracted);
    if (wasClosed || peers === null) {
      void window.orkestrei.interAgent.listPeers(workspaceId, terminalId).then(setPeers);
    }
  };

  const insertMention = (candidate: MentionCandidate) => {
    if (!mentionQuery) return;
    const token = formatMentionToken(candidate.name);
    const current = draft;
    const nextValue =
      current.slice(0, mentionQuery.start) + token + current.slice(mentionQuery.end);
    const nextCursor = mentionQuery.start + token.length;
    setDraft(nextValue);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    const fallbackFiles =
      imageItems.length === 0
        ? Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
        : [];
    const blobs: Array<{ blob: Blob; rawName?: string }> = [
      ...imageItems
        .map((item) => {
          const f = item.getAsFile();
          return f ? { blob: f, rawName: f.name } : null;
        })
        .filter((x): x is { blob: File; rawName: string } => x !== null),
      ...fallbackFiles.map((f) => ({ blob: f, rawName: f.name })),
    ];

    if (blobs.length === 0) return;
    e.preventDefault();

    for (const { blob, rawName } of blobs) {
      const id = crypto.randomUUID();
      const seq = ++pasteSeqRef.current;
      const safeStem = (rawName || `pasted-${Date.now()}-${seq}`)
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .slice(0, 48);
      const fileName = `${safeStem || `pasted-${seq}`}.png`;

      try {
        const payload = await blobToPngPayload(blob);
        const initialChip: PromptImageAttachment = {
          id,
          name: fileName,
          mimeType: 'image/png',
          previewUrl: payload.dataUrl,
          width: payload.width,
          height: payload.height,
          filePath: null,
          pendingMainIpc: false,
        };
        setTerminalAttachments((prev) => [...prev, initialChip]);

        const res = await savePastedImageViaMainIpc({
          workspaceId,
          workspaceDir,
          terminalId,
          fileName,
          mimeType: 'image/png',
          base64Data: payload.base64Data,
        });

        setTerminalAttachments((prev) =>
          prev.map((att) =>
            att.id === id
              ? {
                  ...att,
                  filePath: res.ok && res.filePath ? res.filePath : null,
                  pendingMainIpc: Boolean(res.pendingMainIpc),
                  error: res.ok ? undefined : res.error,
                }
              : att
          )
        );

        if (res.pendingMainIpc && !notifiedMissingImageIpc) {
          notifiedMissingImageIpc = true;
          toast.info(
            'Image preview attached; saving PNG to workspace temp requires main IPC orkestrei:terminal:savePastedImage.'
          );
        } else if (!res.ok && !res.pendingMainIpc && res.error) {
          toast.error(`Failed to save pasted image: ${res.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Could not read pasted image: ${msg}`);
      }
    }
  };

  const handleSubmit = async () => {
    if (sending) return;
    const trimmed = draft.trim();
    const savedAttachments = attachments.filter((a) => Boolean(a.filePath));
    const unsavedAttachments = attachments.filter((a) => !a.filePath);

    if (!trimmed && savedAttachments.length === 0) {
      if (unsavedAttachments.length > 0) {
        toast.warning(
          'Pasted image is awaiting main IPC orkestrei:terminal:savePastedImage before it can be sent as a file path.'
        );
      }
      return;
    }

    setSending(true);
    try {
      const sent = await onSend(trimmed, savedAttachments);
      if (sent) {
        setDraft('');
        setMentionQuery(null);
        setShowPromptsMenu(false);
        setTerminalAttachments((prev) => prev.filter((a) => !a.filePath));
      }
    } finally {
      setSending(false);
    }
  };

  const canSend =
    draft.trim().length > 0 || attachments.some((a) => Boolean(a.filePath));

  const renderMentionIcon = (kind: MentionCandidate['kind']) => {
    if (kind === 'agent') {
      return <Bot className="size-3.5 shrink-0 text-[var(--muted-foreground)]" strokeWidth={1.5} />;
    }
    if (kind === 'note') {
      return (
        <StickyNote className="size-3.5 shrink-0 text-[var(--muted-foreground)]" strokeWidth={1.5} />
      );
    }
    return <Globe className="size-3.5 shrink-0 text-[var(--muted-foreground)]" strokeWidth={1.5} />;
  };

  return (
    <div
      ref={rootRef}
      onPointerDown={(e) => e.stopPropagation()}
      className="relative shrink-0 px-2 pb-2 pt-0.5"
    >
      {showMentionsPopup && (
        <div
          ref={mentionListRef}
          className="glass-strong absolute bottom-full left-2 right-2 z-40 mb-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] p-1 text-xs shadow-2xl"
        >
          <div className="px-2 py-1 text-[11px] font-medium text-[var(--muted-foreground)]">
            Mention agent, note, or portal
          </div>
          {filteredMentions.map((item, idx) => {
            const active = idx === activeMentionIdx;
            return (
              <button
                key={item.key}
                type="button"
                data-mention-idx={idx}
                onMouseEnter={() => setActiveMentionIdx(idx)}
                onClick={() => insertMention(item)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  active
                    ? 'bg-[var(--bg-hover)] text-[var(--foreground)]'
                    : 'text-[var(--foreground)]/90 hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {renderMentionIcon(item.kind)}
                  <span className="truncate font-medium">@{item.name}</span>
                </span>
                <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">
                  {item.detail}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showPromptsMenu && (
        <div className="glass-strong absolute bottom-full left-2 z-40 mb-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-[var(--border)] p-2 text-xs shadow-2xl">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
              Saved prompts
            </span>
            <button
              type="button"
              onClick={() => setShowPromptsMenu(false)}
              className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)]"
            >
              <X className="size-3" />
            </button>
          </div>
          {draft.trim() && (
            <div className="mb-2 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)] p-1">
              <input
                value={newPromptTitle}
                onChange={(e) => setNewPromptTitle(e.target.value)}
                placeholder="Title for current draft"
                className="min-w-0 flex-1 bg-transparent px-1.5 py-0.5 text-[11px] text-[var(--foreground)] outline-none"
              />
              <button
                type="button"
                onClick={async () => {
                  await window.orkestrei.savedPrompts.save({
                    title: newPromptTitle.trim() || draft.trim().slice(0, 28),
                    prompt: draft.trim(),
                  });
                  setNewPromptTitle('');
                }}
                className="rounded bg-[var(--accent)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-foreground)]"
              >
                Save
              </button>
            </div>
          )}
          <div className="space-y-1">
            {savedPrompts.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-[var(--muted-foreground)]">
                No saved prompts
              </div>
            ) : (
              savedPrompts.map((sp) => (
                <div
                  key={sp.id}
                  className="flex items-start justify-between gap-1 rounded-md px-2 py-1.5 hover:bg-[var(--bg-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((prev) => (prev ? `${prev}\n${sp.prompt}` : sp.prompt));
                      setShowPromptsMenu(false);
                      window.requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate font-medium text-[var(--foreground)]">{sp.title}</div>
                    <div className="line-clamp-2 text-[10px] text-[var(--muted-foreground)]">
                      {sp.prompt}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.orkestrei.savedPrompts.delete(sp.id)}
                    className="p-0.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                    title="Delete prompt"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--card)]/95 px-2 py-1.5 transition-colors focus-within:border-[var(--foreground)]/25">
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {attachments.map((att) => (
              <div
                key={att.id}
                title={
                  att.filePath
                    ? att.filePath
                    : att.error || 'Pending main IPC orkestrei:terminal:savePastedImage'
                }
                className={`flex h-6 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] ${
                  att.pendingMainIpc
                    ? 'border-[var(--warning)]/40 bg-[var(--secondary)] text-[var(--foreground)]'
                    : 'border-[var(--border)] bg-[var(--secondary)] text-[var(--foreground)]'
                }`}
              >
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="size-4 shrink-0 rounded-[3px] object-cover"
                />
                <span className="max-w-[120px] truncate font-mono text-[10px]">{att.name}</span>
                {att.width > 0 && att.height > 0 && (
                  <span className="font-mono text-[10px] tabular-nums text-[var(--muted-foreground)]">
                    {att.width}×{att.height}
                  </span>
                )}
                {att.pendingMainIpc && (
                  <span className="text-[10px] text-[var(--warning)]">pending IPC</span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setTerminalAttachments((prev) => prev.filter((item) => item.id !== att.id))
                  }
                  title="Remove attachment"
                  className="rounded p-0.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--destructive)]"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5">
          <button
            type="button"
            onClick={() => {
              setShowPromptsMenu((v) => !v);
              setMentionQuery(null);
            }}
            title="Saved prompts"
            className={`flex size-6 shrink-0 items-center justify-center rounded-md transition-colors ${
              showPromptsMenu
                ? 'bg-[var(--bg-hover)] text-[var(--foreground)]'
                : 'text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]'
            }`}
          >
            <Bookmark className="size-3.5" strokeWidth={1.5} />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(e) => {
              const val = e.target.value;
              const pos = e.target.selectionStart ?? val.length;
              setDraft(val);
              refreshMentionState(val, pos);
            }}
            onClick={(e) => {
              const el = e.currentTarget;
              refreshMentionState(el.value, el.selectionStart ?? el.value.length);
            }}
            onKeyUp={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const el = e.currentTarget;
                refreshMentionState(el.value, el.selectionStart ?? el.value.length);
              }
            }}
            onPaste={(e) => void handlePaste(e)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key === 'Process') return;

              if (showMentionsPopup) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveMentionIdx((idx) => (idx + 1) % filteredMentions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveMentionIdx(
                    (idx) => (idx - 1 + filteredMentions.length) % filteredMentions.length
                  );
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  const target = filteredMentions[activeMentionIdx] ?? filteredMentions[0];
                  if (target) insertMention(target);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionQuery(null);
                  return;
                }
              }

              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              } else if (e.key === 'Escape') {
                setMentionQuery(null);
                setShowPromptsMenu(false);
              }
            }}
            placeholder={inChatMode ? 'Chat prompt' : 'Prompt or @mention'}
            className="min-h-5 flex-1 resize-none bg-transparent py-0.5 text-[12px] leading-5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]/60 outline-none"
          />

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={sending || !canSend}
            title="Send"
            className={`flex size-6 shrink-0 items-center justify-center rounded-md transition-colors ${
              canSend && !sending
                ? 'bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90'
                : 'text-[var(--muted-foreground)]/50 hover:bg-[var(--bg-hover)] hover:text-[var(--muted-foreground)]'
            }`}
          >
            <Send className="size-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
};
