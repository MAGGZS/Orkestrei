import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Eye, FolderPlus, Lock, Palette, Pencil, Trash2, Unlock } from 'lucide-react';
import {
  STICKY_COLORS,
  STICKY_COLOR_HEX,
  STICKY_TEXT_COLOR,
} from '../../../shared/constants';
import type { CanvasNode, NoteColor } from '../../../shared/types';
import { MarkdownSurface } from '../components/MarkdownSurface';
import { useDismissable } from '../components/useDismissable';
import { activeWorkspaceAtom } from '../state/atoms';
import { NodeFrame } from './NodeFrame';

export const StickyNoteNode: React.FC<{ node: CanvasNode }> = ({ node }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const note = node.content.kind === 'stickyNote' ? node.content.stickyNote : null;
  const [text, setText] = useState(note?.text ?? '');
  const [showColors, setShowColors] = useState(false);
  const [previewMode, setPreviewMode] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<{ workspaceId: string; nodeId: string; text: string } | null>(
    null
  );
  const colorMenuRef = useRef<HTMLDivElement | null>(null);

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

  useDismissable(showColors, colorMenuRef, () => setShowColors(false));

  useEffect(() => {
    return () => flushPendingSave();
  }, [flushPendingSave]);

  useEffect(() => {
    if (pendingWriteRef.current && pendingWriteRef.current.nodeId === node.id) {
      return;
    }
    if (note && note.text !== text) {
      setText(note.text);
    }
  }, [node.id, note?.text]);

  if (!note || !workspace) return null;

  const bg = note.customColor || STICKY_COLOR_HEX[note.color];
  const fg = STICKY_TEXT_COLOR[note.color];
  const displayName = note.customName || note.fileName.replace(/\.(?:md|markdown|txt)$/i, '');

  const handleChange = (val: string) => {
    if (note.isContentLocked) return;
    setText(val);
    pendingWriteRef.current = { workspaceId: workspace.id, nodeId: node.id, text: val };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const pending = pendingWriteRef.current;
      if (pending) {
        pendingWriteRef.current = null;
        void window.maestri.note.write(pending.workspaceId, pending.nodeId, pending.text);
      }
    }, 300);
  };

  const handleImmediateSave = (val: string) => {
    if (note.isContentLocked) return;
    setText(val);
    cancelPendingSave();
    void window.maestri.note.write(workspace.id, node.id, val);
  };

  const hasMarkdownH1 = text.trimStart().startsWith('# ');

  return (
    <NodeFrame
      node={node}
      minWidth={190}
      minHeight={160}
      className="overflow-hidden"
      style={{ backgroundColor: bg, color: fg }}
    >
      {({ startDrag }) => (
        <div className="flex h-full w-full flex-col rounded-lg" style={{ backgroundColor: bg, color: fg }}>
          <div
            onPointerDown={startDrag}
            className="flex h-6 shrink-0 cursor-grab items-center justify-between px-2.5 active:cursor-grabbing"
          >
            {hasMarkdownH1 ? (
              <span />
            ) : (
              <span className="truncate text-[11px] font-medium opacity-75">{displayName}</span>
            )}
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className={`relative flex items-center gap-0.5 transition-opacity ${
                showColors ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  flushPendingSave();
                  setPreviewMode((v) => !v);
                }}
                className="rounded p-1 opacity-65 hover:bg-black/10 hover:opacity-100"
                title={previewMode ? 'Edit Markdown Source' : 'Preview Rendered Markdown'}
              >
                {previewMode ? <Pencil className="size-3" /> : <Eye className="size-3" />}
              </button>
              <div ref={colorMenuRef} className="relative flex items-center">
                <button
                  type="button"
                  onClick={() => setShowColors((v) => !v)}
                  className="rounded p-1 opacity-65 hover:bg-black/10 hover:opacity-100"
                  title="Note Color"
                >
                  <Palette className="size-3" />
                </button>
                {showColors && (
                  <div className="glass-strong absolute right-0 top-7 z-40 grid grid-cols-5 gap-2 rounded-lg border border-[var(--border)] p-2 shadow-xl">
                    {STICKY_COLORS.map((c: NoteColor) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => {
                          setShowColors(false);
                          void window.maestri.note.setColor(workspace.id, node.id, c);
                        }}
                        className={`size-5 rounded-full border border-black/20 transition-opacity hover:opacity-85 ${
                          note.color === c ? 'ring-2 ring-[var(--accent)]' : ''
                        }`}
                        style={{ backgroundColor: STICKY_COLOR_HEX[c] }}
                        title={c}
                      />
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  flushPendingSave();
                  void window.maestri.noteStack.fileNote(workspace.id, node.id, 'Fichário');
                }}
                className="rounded p-1 opacity-65 hover:bg-black/10 hover:opacity-100"
                title="File into Fichário"
              >
                <FolderPlus className="size-3" />
              </button>
              <button
                type="button"
                onClick={() =>
                  void window.maestri.node.patch(workspace.id, node.id, {
                    content: {
                      kind: 'stickyNote',
                      stickyNote: { ...note, isContentLocked: !note.isContentLocked },
                    },
                  })
                }
                className="rounded p-1 opacity-65 hover:bg-black/10 hover:opacity-100"
                title={note.isContentLocked ? 'Unlock note' : 'Lock read-only'}
              >
                {note.isContentLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  cancelPendingSave();
                  void window.maestri.node.deleteMany(workspace.id, [node.id]);
                }}
                className="rounded p-1 opacity-65 hover:bg-black/10 hover:text-red-600 hover:opacity-100"
                title="Delete note"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          </div>

          {previewMode ? (
            <div
              className="flex min-h-0 flex-1 flex-col"
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!note.isContentLocked) setPreviewMode(false);
              }}
              title={note.isContentLocked ? undefined : 'Double-click to edit markdown'}
            >
              <MarkdownSurface
                text={text}
                foregroundColor={fg}
                readOnly={note.isContentLocked}
                onChangeText={handleImmediateSave}
              />
            </div>
          ) : (
            <textarea
              autoFocus
              value={text}
              readOnly={note.isContentLocked}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={flushPendingSave}
              placeholder="Write markdown note…"
              className="flex-1 resize-none bg-transparent p-2.5 font-mono text-[12.5px] leading-relaxed outline-none placeholder:opacity-40"
              style={{ color: fg }}
            />
          )}
        </div>
      )}
    </NodeFrame>
  );
};
