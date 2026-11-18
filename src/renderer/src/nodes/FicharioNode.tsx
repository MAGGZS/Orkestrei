import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ArrowUpRight, Eye, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { STICKY_COLOR_HEX, STICKY_TEXT_COLOR } from '../../../shared/constants';
import type { CanvasNode, StickyNoteData } from '../../../shared/types';
import { MarkdownSurface } from '../components/MarkdownSurface';
import { activeLevelAtom, activeWorkspaceAtom } from '../state/atoms';
import { NodeFrame } from './NodeFrame';

export const FicharioNode: React.FC<{ node: CanvasNode }> = ({ node }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const [previewMode, setPreviewMode] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<{ workspaceId: string; nodeId: string; text: string } | null>(
    null
  );

  const stack = node.content.kind === 'noteStack' ? node.content.noteStack : null;
  const memberNotes = stack
    ? stack.memberNodeIds
        .map((id) => level.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => Boolean(n && n.content.kind === 'stickyNote'))
    : [];

  const frontNode = stack
    ? memberNotes.find((n) => n.id === stack.frontNoteId) ?? memberNotes[0] ?? null
    : null;
  const frontNote = frontNode?.content.kind === 'stickyNote' ? frontNode.content.stickyNote : null;
  const frontNodeId = frontNode?.id ?? null;

  const [draftText, setDraftText] = useState(frontNote?.text ?? '');
  const prevFrontIdRef = useRef<string | null>(frontNodeId);

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingWriteRef.current;
    if (pending) {
      pendingWriteRef.current = null;
      void window.maestri.note.write(pending.workspaceId, pending.nodeId, pending.text);
    }
  }, []);

  const cancelPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingWriteRef.current = null;
  }, []);

  useEffect(() => {
    return () => flushPendingSave();
  }, [flushPendingSave]);

  useEffect(() => {
    if (prevFrontIdRef.current !== frontNodeId) {
      flushPendingSave();
      prevFrontIdRef.current = frontNodeId;
      setDraftText(frontNote?.text ?? '');
      return;
    }
    if (pendingWriteRef.current && pendingWriteRef.current.nodeId === frontNodeId) {
      return;
    }
    setDraftText(frontNote?.text ?? '');
  }, [frontNodeId, frontNote?.text, flushPendingSave]);

  if (!stack || !workspace) return null;

  const bg = frontNote ? STICKY_COLOR_HEX[frontNote.color] : STICKY_COLOR_HEX[stack.color];
  const fg = frontNote ? STICKY_TEXT_COLOR[frontNote.color] : STICKY_TEXT_COLOR[stack.color];

  const handleAddPage = async () => {
    flushPendingSave();
    const now = new Date().toISOString();
    const pageNum = memberNotes.length + 1;
    const newNoteId = crypto.randomUUID();
    const noteData: StickyNoteData = {
      fileName: `${stack.name} - Page ${pageNum}.md`,
      customName: `Page ${pageNum}`,
      color: stack.color,
      customColor: null,
      isContentLocked: false,
      fontFamily: null,
      text: `# Page ${pageNum}\n\n`,
      storageMode: { kind: 'managed' },
    };
    await window.maestri.node.create(workspace.id, {
      id: newNoteId,
      frame: { x: node.frame.x + 20, y: node.frame.y + 20, width: 260, height: 240 },
      zIndex: 1,
      groupId: null,
      createdAt: now,
      lastModifiedAt: now,
      content: { kind: 'stickyNote', stickyNote: noteData },
    });
    await window.maestri.noteStack.fileNote(workspace.id, newNoteId, stack.name);
  };

  return (
    <NodeFrame node={node} minWidth={240} minHeight={200}>
      {({ startDrag }) => (
        <div
          className="flex h-full w-full flex-col overflow-hidden rounded-lg"
          style={{ backgroundColor: bg, color: fg }}
        >
          <div
            onPointerDown={startDrag}
            className="flex h-8 shrink-0 cursor-grab items-center justify-between px-3 active:cursor-grabbing"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <FolderOpen className="size-3.5 shrink-0 opacity-75" />
              <span className="truncate text-xs font-medium">{stack.name}</span>
              <span className="font-mono text-[11px] tabular-nums opacity-60">
                {memberNotes.length}
              </span>
            </div>

            <div
              className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  flushPendingSave();
                  setPreviewMode((v) => !v);
                }}
                title={previewMode ? 'Edit Markdown Source' : 'Preview Markdown'}
                className="rounded p-1 opacity-70 hover:bg-black/10 hover:opacity-100"
              >
                {previewMode ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => void handleAddPage()}
                title="Add page"
                className="rounded p-1 opacity-70 hover:bg-black/10 hover:opacity-100"
              >
                <Plus className="size-3.5" />
              </button>
              {frontNode && (
                <button
                  type="button"
                  onClick={() => {
                    flushPendingSave();
                    void window.maestri.noteStack.unstack(workspace.id, frontNode.id);
                  }}
                  title="Spill current page back onto canvas"
                  className="rounded p-1 opacity-70 hover:bg-black/10 hover:opacity-100"
                >
                  <ArrowUpRight className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  cancelPendingSave();
                  void window.maestri.node.deleteMany(workspace.id, [node.id]);
                }}
                title="Delete fichário"
                className="rounded p-1 opacity-70 hover:bg-black/10 hover:text-red-600 hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Page Tabs Rail */}
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="flex w-24 shrink-0 flex-col gap-1 overflow-y-auto border-r border-black/10 bg-black/5 p-1.5"
            >
              {memberNotes.map((mn) => {
                const sn = (mn.content as { kind: 'stickyNote'; stickyNote: StickyNoteData }).stickyNote;
                const label = sn.customName || sn.fileName.replace(/\.md$/i, '');
                const active = frontNode?.id === mn.id;
                return (
                  <button
                    key={mn.id}
                    type="button"
                    onClick={() => {
                      flushPendingSave();
                      void window.maestri.node.patch(workspace.id, node.id, {
                        content: {
                          kind: 'noteStack',
                          noteStack: { ...stack, frontNoteId: mn.id },
                        },
                      });
                    }}
                    className={`truncate rounded-md px-2 py-1 text-left text-[11px] font-medium transition-colors ${
                      active ? 'bg-black/15 font-semibold' : 'opacity-70 hover:bg-black/10'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {frontNode && frontNote ? (
              previewMode ? (
                <div
                  className="flex min-h-0 flex-1 flex-col"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!frontNote.isContentLocked) setPreviewMode(false);
                  }}
                >
                  <MarkdownSurface
                    text={draftText}
                    foregroundColor={fg}
                    readOnly={frontNote.isContentLocked}
                    onChangeText={(val) => {
                      setDraftText(val);
                      cancelPendingSave();
                      void window.maestri.note.write(workspace.id, frontNode.id, val);
                    }}
                  />
                </div>
              ) : (
                <textarea
                  autoFocus
                  value={draftText}
                  readOnly={frontNote.isContentLocked}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (frontNote.isContentLocked) return;
                    const val = e.target.value;
                    setDraftText(val);
                    pendingWriteRef.current = {
                      workspaceId: workspace.id,
                      nodeId: frontNode.id,
                      text: val,
                    };
                    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                    saveTimerRef.current = setTimeout(() => {
                      saveTimerRef.current = null;
                      const pending = pendingWriteRef.current;
                      if (pending) {
                        pendingWriteRef.current = null;
                        void window.maestri.note.write(
                          pending.workspaceId,
                          pending.nodeId,
                          pending.text
                        );
                      }
                    }, 300);
                  }}
                  onBlur={flushPendingSave}
                  className="flex-1 resize-none bg-transparent p-2.5 font-mono text-[12px] leading-relaxed outline-none"
                  style={{ color: fg }}
                />
              )
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs opacity-60">
                Empty Fichário
              </div>
            )}
          </div>
        </div>
      )}
    </NodeFrame>
  );
};
