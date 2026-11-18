import type { AgentPreset, NoteColor, Preferences } from './types';

export const CELL_WORLD_SIZE = 20;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.2;
export const DEFAULT_ZOOM = 1;

export const DEFAULT_TERMINAL_SIZE = { width: 560, height: 390 };
export const DEFAULT_NOTE_SIZE = { width: 260, height: 240 };
export const DEFAULT_PORTAL_SIZE = { width: 640, height: 460 };
export const DEFAULT_FILE_TREE_SIZE = { width: 280, height: 420 };
export const DEFAULT_BAND_SIZE = { width: 760, height: 460 };
export const DEFAULT_FICHARIO_SIZE = { width: 320, height: 300 };

export const STICKY_COLORS: NoteColor[] = [
  'yellow',
  'pink',
  'blue',
  'green',
  'orange',
  'purple',
  'white',
  'charcoal',
  'slate',
  'midnight',
];

export const STICKY_COLOR_HEX: Record<NoteColor, string> = {
  yellow: '#FFF9C4',
  pink: '#F8BBD0',
  blue: '#BBDEFB',
  green: '#C8E6C9',
  orange: '#FFE0B2',
  purple: '#E1BEE7',
  white: '#FFFFFF',
  charcoal: '#2D2D2D',
  slate: '#37474F',
  midnight: '#1A237E',
};

export const STICKY_TEXT_COLOR: Record<NoteColor, string> = {
  yellow: '#5D4037',
  pink: '#880E4F',
  blue: '#0D47A1',
  green: '#1B5E20',
  orange: '#E65100',
  purple: '#4A148C',
  white: '#333333',
  charcoal: '#FFFFFF',
  slate: '#FFFFFF',
  midnight: '#FFFFFF',
};

export const NODE_ACCENT_COLORS = [
  '#0a84ff',
  '#30d158',
  '#bf5af2',
  '#ff9f0a',
  '#ff375f',
  '#64d2ff',
  '#ffd60a',
  '#5e5ce6',
];

export const CHAT_THREAD_COLORS = [
  { key: 'blue', hex: '#0a84ff', label: 'Blue' },
  { key: 'purple', hex: '#bf5af2', label: 'Purple' },
  { key: 'pink', hex: '#ff375f', label: 'Pink' },
  { key: 'red', hex: '#ff453a', label: 'Red' },
  { key: 'orange', hex: '#ff9f0a', label: 'Orange' },
  { key: 'yellow', hex: '#ffd60a', label: 'Yellow' },
  { key: 'green', hex: '#30d158', label: 'Green' },
] as const;

export const DEFAULT_AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'preset-antigravity',
    name: 'Antigravity',
    command: 'agy',
    agentType: 'antigravity',
    icon: 'sparkles',
    color: '#4285f4',
    isActive: true,
    maestroMode: false,
    startInChatMode: false,
    showInQuickStart: true,
    account: 'Default',
  },
  {
    id: 'preset-claude-code',
    name: 'Claude Code',
    command: 'claude',
    agentType: 'claude',
    icon: 'seal',
    color: '#d97757',
    isActive: true,
    maestroMode: false,
    startInChatMode: false,
    showInQuickStart: true,
    account: 'Default',
  },
  {
    id: 'preset-codex',
    name: 'Codex',
    command: 'codex --no-daemon',
    agentType: 'codex',
    icon: 'brain',
    color: '#30d158',
    isActive: true,
    maestroMode: false,
    startInChatMode: false,
    showInQuickStart: true,
    account: 'Default',
  },
  {
    id: 'preset-gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    agentType: 'gemini',
    icon: 'sparkle',
    color: '#0a84ff',
    isActive: true,
    maestroMode: false,
    startInChatMode: false,
    showInQuickStart: true,
    account: 'Default',
  },
  {
    id: 'preset-opencode',
    name: 'OpenCode',
    command: 'opencode',
    agentType: 'opencode',
    icon: 'cpu',
    color: '#bf5af2',
    isActive: true,
    maestroMode: false,
    startInChatMode: false,
    showInQuickStart: true,
    account: 'Default',
  },
  {
    id: 'preset-shell',
    name: 'Shell',
    command: '',
    agentType: 'shell',
    icon: 'terminal',
    color: '#8e8e93',
    isActive: true,
    maestroMode: false,
    startInChatMode: false,
    showInQuickStart: true,
    account: 'Default',
  },
];

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  canvasBackground: 'grid',
  fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace',
  fontSize: 13,
  confirmBeforeQuitting: false,
  defaultNoteColor: 'yellow',
  agentPresets: DEFAULT_AGENT_PRESETS,
};

export const PORTAL_UA_PRESETS: Record<string, { label: string; userAgent: string }> = {
  desktop: {
    label: 'Desktop (Default)',
    userAgent: '',
  },
  ios: {
    label: 'iPhone / iOS Safari',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  android: {
    label: 'Android Chrome',
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
  chrome: {
    label: 'Chrome Desktop',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
};
