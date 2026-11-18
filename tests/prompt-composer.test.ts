import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import {
  extractMentionQuery,
  formatMentionToken,
  injectNoteMentions,
} from '../src/renderer/src/components/PromptComposer';
import type { CanvasNode } from '../src/shared/types';

function makeNoteNode(
  id: string,
  fileName: string,
  customName: string | null,
  text: string
): CanvasNode {
  return {
    id,
    frame: { x: 0, y: 0, width: 240, height: 220 },
    zIndex: 1,
    groupId: null,
    createdAt: '',
    lastModifiedAt: '',
    content: {
      kind: 'stickyNote',
      stickyNote: {
        fileName,
        customName,
        color: 'yellow',
        customColor: null,
        isContentLocked: false,
        fontFamily: null,
        text,
        storageMode: { kind: 'managed' },
      },
    },
  };
}

describe('PromptComposer mention helpers', () => {
  it('formats mentions with quotes only when name contains whitespace', () => {
    expect(formatMentionToken('Builder')).toBe('@Builder ');
    expect(formatMentionToken('Agent 1')).toBe('@"Agent 1" ');
    expect(formatMentionToken('Guia Rápido do Orkestrei')).toBe('@"Guia Rápido do Orkestrei" ');
  });

  it('extracts active @mention query at cursor and ignores email addresses', () => {
    expect(extractMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(extractMentionQuery('oi @bui', 7)).toEqual({ start: 3, end: 7, query: 'bui' });
    expect(extractMentionQuery('oi @"Guia R', 11)).toEqual({
      start: 3,
      end: 11,
      query: 'guia r',
    });
    expect(extractMentionQuery('email@example.com', 17)).toBeNull();
  });

  it('injects both unquoted and quoted @"..." note mentions without duplicating', () => {
    const notes = [
      makeNoteNode('n1', 'Notas.md', null, 'conteudo notas'),
      makeNoteNode('n2', 'guia-rapido.md', 'Guia Rápido', 'conteudo guia'),
      makeNoteNode('n3', 'Plano.md', null, 'conteudo plano'),
    ];

    const out = injectNoteMentions('Ver @Notas, @"Guia Rápido", @Notas e @Plano.', notes);
    expect(out).toContain('<attached_note name="Notas.md">\nconteudo notas\n</attached_note>');
    expect(out).toContain('<attached_note name="Guia Rápido">\nconteudo guia\n</attached_note>');
    expect(out).toContain('<attached_note name="Plano.md">\nconteudo plano\n</attached_note>');
    expect(out.match(/name="Notas\.md"/g)).toHaveLength(1);
  });

  it('persists prompt drafts per terminalId via promptDraftsAtom and localStorage', async () => {
    const backing = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => backing.get(k) ?? null,
        setItem: (k: string, v: string) => {
          backing.set(k, v);
        },
      },
    });
    try {
      vi.resetModules();
      const mod = await import('../src/renderer/src/state/atoms');
      const store = createStore();
      store.set(mod.promptDraftsAtom, { 'term-a': 'draft line 1\nline 2' });
      expect(store.get(mod.promptDraftsAtom)['term-a']).toBe('draft line 1\nline 2');

      // Re-import module to simulate app restart reading from localStorage
      vi.resetModules();
      const modRestart = await import('../src/renderer/src/state/atoms');
      const storeRestart = createStore();
      expect(storeRestart.get(modRestart.promptDraftsAtom)['term-a']).toBe('draft line 1\nline 2');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
