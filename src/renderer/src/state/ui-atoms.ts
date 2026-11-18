import { atom } from 'jotai';

export type TmuxPrefixOption = 'ctrl+b' | 'ctrl+a' | 'alt+b' | 'ctrl+space' | 'off';

const TMUX_PREFIX_STORAGE_KEY = 'orkestrei:tmux-prefix';

const VALID_PREFIXES: ReadonlySet<TmuxPrefixOption> = new Set([
  'ctrl+b',
  'ctrl+a',
  'alt+b',
  'ctrl+space',
  'off',
]);

function readInitialTmuxPrefix(): TmuxPrefixOption {
  try {
    const raw = window.localStorage.getItem(TMUX_PREFIX_STORAGE_KEY);
    if (raw && VALID_PREFIXES.has(raw as TmuxPrefixOption)) {
      return raw as TmuxPrefixOption;
    }
  } catch {
    // ignore storage read failures
  }
  return 'ctrl+b';
}

const baseTmuxPrefixAtom = atom<TmuxPrefixOption>(readInitialTmuxPrefix());

export const tmuxPrefixSettingAtom = atom(
  (get) => get(baseTmuxPrefixAtom),
  (_get, set, next: TmuxPrefixOption) => {
    set(baseTmuxPrefixAtom, next);
    try {
      window.localStorage.setItem(TMUX_PREFIX_STORAGE_KEY, next);
    } catch {
      // ignore storage write failures
    }
  }
);

export const tmuxPrefixActiveAtom = atom<boolean>(false);

export interface PendingTerminalFocusRequest {
  terminalId: string;
  nodeId: string | null;
  workspaceId: string | null;
  floorId: string | null;
}

export const pendingTerminalFocusAtom = atom<PendingTerminalFocusRequest | null>(null);

export function matchesTmuxPrefix(e: KeyboardEvent, setting: TmuxPrefixOption): boolean {
  if (setting === 'off') return false;
  if (e.repeat || e.metaKey || e.shiftKey) return false;

  const key = e.key.toLowerCase();
  switch (setting) {
    case 'ctrl+b':
      return e.ctrlKey && !e.altKey && key === 'b';
    case 'ctrl+a':
      return e.ctrlKey && !e.altKey && key === 'a';
    case 'alt+b':
      return e.altKey && !e.ctrlKey && key === 'b';
    case 'ctrl+space':
      return e.ctrlKey && !e.altKey && (e.code === 'Space' || e.key === ' ');
    default:
      return false;
  }
}

export function getTmuxPrefixLabel(setting: TmuxPrefixOption): string {
  switch (setting) {
    case 'ctrl+b':
      return 'Ctrl+B';
    case 'ctrl+a':
      return 'Ctrl+A';
    case 'alt+b':
      return 'Alt+B';
    case 'ctrl+space':
      return 'Ctrl+Space';
    case 'off':
      return 'Off';
  }
}

/** Control sequence forwarded to PTY when pressing the prefix twice inside xterm. */
export function getTmuxPrefixControlChar(setting: TmuxPrefixOption): string | null {
  switch (setting) {
    case 'ctrl+b':
      return '\x02';
    case 'ctrl+a':
      return '\x01';
    case 'alt+b':
      return '\x1bb';
    case 'ctrl+space':
      return '\x00';
    case 'off':
      return null;
  }
}
