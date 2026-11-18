import path from 'node:path';
import type { ChatEntry, ChatThreadColor, ChatThreadsState } from '../shared/types';
import { newId, readJsonFile, writeJsonAtomic } from './utils';

const EMPTY_THREADS = (): ChatThreadsState => ({
  activeSlot: 'blue',
  threads: {
    blue: [],
    purple: [],
    pink: [],
    red: [],
    orange: [],
    yellow: [],
    green: [],
  },
});

export class ChatStore {
  private conversations = new Map<string, ChatThreadsState>();
  private eventListeners = new Set<
    (ev: { terminalId: string; slot: ChatThreadColor; entry?: ChatEntry; kind: 'append' | 'clear' | 'switch' }) => void
  >();

  constructor(private baseDir: string) {}

  private fileFor(terminalId: string): string {
    return path.join(this.baseDir, 'chats', `${terminalId}.json`);
  }

  async getState(terminalId: string): Promise<ChatThreadsState> {
    let state = this.conversations.get(terminalId);
    if (!state) {
      state = await readJsonFile<ChatThreadsState>(this.fileFor(terminalId), EMPTY_THREADS());
      this.conversations.set(terminalId, state);
    }
    return structuredClone(state);
  }

  async switchThread(terminalId: string, slot: ChatThreadColor): Promise<ChatThreadsState> {
    const state = await this.getState(terminalId);
    state.activeSlot = slot;
    this.conversations.set(terminalId, state);
    await writeJsonAtomic(this.fileFor(terminalId), state);
    for (const cb of this.eventListeners) cb({ terminalId, slot, kind: 'switch' });
    return structuredClone(state);
  }

  async appendEntry(
    terminalId: string,
    slot: ChatThreadColor | null,
    entry: Omit<ChatEntry, 'id' | 'timestamp'>
  ): Promise<ChatEntry> {
    const state = await this.getState(terminalId);
    const targetSlot = slot ?? state.activeSlot;
    const full: ChatEntry = {
      ...entry,
      id: newId(),
      timestamp: new Date().toISOString(),
    };
    state.threads[targetSlot].push(full);
    this.conversations.set(terminalId, state);
    await writeJsonAtomic(this.fileFor(terminalId), state);
    for (const cb of this.eventListeners) {
      cb({ terminalId, slot: targetSlot, entry: full, kind: 'append' });
    }
    return full;
  }

  async clearThread(terminalId: string, slot: ChatThreadColor): Promise<void> {
    const state = await this.getState(terminalId);
    state.threads[slot] = [];
    this.conversations.set(terminalId, state);
    await writeJsonAtomic(this.fileFor(terminalId), state);
    for (const cb of this.eventListeners) cb({ terminalId, slot, kind: 'clear' });
  }

  async recall(
    terminalId: string,
    slot?: ChatThreadColor,
    limit = 10
  ): Promise<{ slot: ChatThreadColor; entries: ChatEntry[] }> {
    const state = await this.getState(terminalId);
    const target = slot ?? state.activeSlot;
    const list = state.threads[target] ?? [];
    return { slot: target, entries: list.slice(-limit) };
  }

  onEvent(
    cb: (ev: { terminalId: string; slot: ChatThreadColor; entry?: ChatEntry; kind: 'append' | 'clear' | 'switch' }) => void
  ): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }
}
