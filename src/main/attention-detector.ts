import type { AgentType } from '../shared/types';

export type AttentionState =
  | 'working'
  | 'needs-input'
  | 'approval'
  | 'error'
  | 'done'
  | 'idle';

export interface DetectAttentionInput {
  agentType: AgentType;
  visibleText: string;
  lastOutputAt: number;
  now?: number;
  wasWorking?: boolean;
  /** Threshold in ms for treating recent PTY output as active streaming (matches PTYManager). */
  workingThresholdMs?: number;
}

export interface AttentionDetection {
  state: AttentionState;
  reason: string | null;
}

export interface TerminalAttentionSnapshot {
  terminalId: string;
  state: AttentionState;
  reason: string | null;
  updatedAt: number;
}

export interface AttentionTransitionEvent {
  terminalId: string;
  previousState: AttentionState;
  nextState: AttentionState;
  reason: string | null;
  timestamp: number;
}

export interface EvaluateTerminalAttentionInput {
  terminalId: string;
  agentType: AgentType;
  visibleText: string;
  lastOutputAt: number;
  running?: boolean;
  now?: number;
}

export interface AttentionTrackerOptions {
  workingThresholdMs?: number;
  /**
   * States considered as requiring user attention in `getAttentionIds()`.
   * Defaults to `['approval', 'needs-input', 'error']`.
   */
  attentionStates?: AttentionState[];
}

interface PatternRule {
  pattern: RegExp;
  reason: string;
}

const DEFAULT_WORKING_THRESHOLD_MS = 1800;
const ANSI_CSI_RX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SINGLE_RX = /\x1b[@-Z\\-_]/g;

/**
 * Claude Code approval patterns.
 * Source/assumption: observed Claude Code Ink TUI permission prompts ("Do you want to proceed?",
 * "Do you want to make this edit/run/create...?", numbered selector "❯ 1. Yes" / "1. Yes ... 2. No").
 */
const CLAUDE_APPROVAL_RULES: PatternRule[] = [
  {
    pattern: /\bDo you want to proceed\?/i,
    reason: 'Claude Code waiting for confirmation ("Do you want to proceed?")',
  },
  {
    pattern: /\bDo you want to (?:make this edit|create|delete|run|execute|overwrite|continue)\b[^\n]*\?/i,
    reason: 'Claude Code permission prompt',
  },
  {
    pattern: /^[❯>]\s*1\.\s*Yes\b/m,
    reason: 'Claude Code approval menu ("❯ 1. Yes")',
  },
  {
    pattern: /\b1\.\s*Yes\b[\s\S]{0,160}\b2\.\s*(?:Yes|No)\b/i,
    reason: 'Claude Code numbered approval menu ("1. Yes")',
  },
  {
    pattern: /\bYes,\s*(?:and\s+)?always\s+allow\b|\bYes,\s*allow\s+once\b/i,
    reason: 'Claude Code tool allowance menu',
  },
];

/**
 * Codex CLI approval patterns.
 * Source/assumption: Codex CLI command execution confirmation modal ("Allow command?",
 * "Would you like to run...", and explicit approve prompts such as "approve?", "(a)pprove",
 * "approve/deny", or "Press Enter to approve").
 */
const CODEX_APPROVAL_RULES: PatternRule[] = [
  {
    pattern: /\bAllow command\??/i,
    reason: 'Codex waiting for command approval ("Allow command?")',
  },
  {
    pattern: /\bWould you like to run\b[^\n]*\?/i,
    reason: 'Codex command confirmation prompt',
  },
  {
    pattern:
      /\b(?:press\s+\S+\s+to\s+approve|\(a\)pprove|approve\s*\/\s*(?:deny|reject))\b|\bapprove\b(?:\s*[:?]|\s+(?:command|action|execution|changes?|this)\b|\s*$)/im,
    reason: 'Codex approval prompt ("approve")',
  },
];

/**
 * Gemini CLI & Antigravity approval patterns.
 * Source/assumption: Gemini CLI tool confirmation ("Allow execution", "(y/n)") and
 * Antigravity confirmation status ("Waiting for user confirmation").
 */
const GEMINI_APPROVAL_RULES: PatternRule[] = [
  {
    pattern: /\bAllow execution\b/i,
    reason: 'Gemini/Antigravity waiting for execution approval ("Allow execution")',
  },
  {
    pattern: /\bWaiting for user confirmation\b/i,
    reason: 'Waiting for user confirmation',
  },
  {
    pattern: /\bConfirm execution\b|\bApply this change\?/i,
    reason: 'Gemini/Antigravity confirmation prompt',
  },
];

/**
 * Shared / generic shell confirmation prompts.
 * Source/assumption: POSIX/Windows CLI conventions (apt, git, npm, pip, rm -i, interactive confirm).
 */
const GENERIC_APPROVAL_RULES: PatternRule[] = [
  {
    pattern: /\[(?:Y\/n|y\/N|y\/n|yes\/no)\]\s*\??\s*$/im,
    reason: 'Shell confirmation prompt ([Y/n])',
  },
  {
    pattern: /\((?:y\/n|Y\/n|y\/N|yes\/no)\)\s*:?\s*\??\s*$/im,
    reason: 'CLI confirmation prompt ((y/n))',
  },
  {
    pattern: /\((?:y\/n|Y\/n|y\/N)\)/,
    reason: 'CLI confirmation prompt ((y/n))',
  },
  {
    pattern: /\bAre you sure\b[^\n]*\?/i,
    reason: 'Confirmation prompt ("Are you sure?")',
  },
];

/**
 * Interactive input / credential prompts across shells and agent CLIs.
 * Source/assumption: sudo/ssh/git/npm password & passphrase prompts, plus CLI selection prompts
 * ("Enter to select", "Waiting for user input", "Enter your choice").
 */
const NEEDS_INPUT_TAIL_RULES: PatternRule[] = [
  {
    pattern: /^\[sudo\]\s+password\s+for\b/im,
    reason: 'Sudo password prompt',
  },
  {
    pattern: /\bEnter passphrase for key\b/i,
    reason: 'SSH key passphrase prompt',
  },
  {
    pattern: /\b(?:password|passphrase|pin|passcode|otp|verification code)\b[^:\n]*:\s*$/im,
    reason: 'Password or verification input prompt',
  },
  {
    pattern: /\benter\s+(?:your\s+)?(?:api[_ ]?key|token|secret|credentials?|username)\b[^:\n]*:\s*$/im,
    reason: 'Credential input prompt',
  },
  {
    pattern: /^Username\s*(?:for\s+[^:\n]+)?:\s*$/im,
    reason: 'Username prompt',
  },
];

const NEEDS_INPUT_SELECTION_RULES: PatternRule[] = [
  {
    pattern:
      /\b(?:Waiting for (?:user )?input|Input required|Enter your choice|Select an option|Choose an option|Type your answer)\b/i,
    reason: 'CLI waiting for user input',
  },
  {
    pattern: /\bEnter to select\b[\s\S]{0,120}\bto navigate\b/i,
    reason: 'Interactive option selector waiting for input',
  },
];

/**
 * Active TUI processing indicators (observed in Claude Code / Codex / Gemini status footers).
 * Source/assumption: Claude Code renders "esc to interrupt" and spinner glyphs (⠋..⠏, ✶, ✻, ✢)
 * while streaming/thinking even though the input box "❯" stays visible above the footer.
 */
const WORKING_INDICATOR_RULES: PatternRule[] = [
  {
    pattern: /\besc\s+to\s+interrupt\b/i,
    reason: 'Agent actively running (esc to interrupt)',
  },
  {
    pattern: /\bctrl\+c\s+to\s+interrupt\b/i,
    reason: 'Process actively running (ctrl+c to interrupt)',
  },
  {
    pattern: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✶✻✢✽◐◓◑◒]\s+\S+(?:\.\.\.|…)/m,
    reason: 'Active progress spinner',
  },
  {
    pattern: /\([^\n)]*\btokens\b[^\n)]*\bthinking\b|\(\d+(?:m\s+\d+)?s\s*·\s*[↓↑]\s*[\d.]+[kM]?\s+tokens/i,
    reason: 'Model streaming/thinking',
  },
  {
    pattern: /^(?:Thinking|Generating|Searching|Working|Executing|Running command)(?:\.\.\.|…)\s*$/im,
    reason: 'Agent processing',
  },
];

/**
 * Fatal CLI / API / runtime errors near the tail when output has stopped.
 * Source/assumption: API error strings from Claude/Codex/Gemini CLIs and standard Node/Python/Go/Rust
 * stderr failure headers. Kept anchored to high-signal prefixes to avoid matching prose.
 */
const ERROR_RULES: PatternRule[] = [
  {
    pattern:
      /\b(?:API Error|Authentication failed|Invalid API key|Rate limit(?:ed| exceeded)?|Quota exceeded|Insufficient quota|Context length exceeded|Prompt is too long|overloaded_error)\b/i,
    reason: 'Agent API or quota error',
  },
  {
    pattern:
      /^(?:Fatal error|FATAL|Panic|PANIC|UnhandledPromiseRejection|ERR!|Error|TypeError|SyntaxError|ReferenceError|RangeError|EACCES|ENOENT|ECONNREFUSED|ETIMEDOUT):\s+\S/m,
    reason: 'Fatal or unhandled runtime error',
  },
  {
    pattern: /^\s*Traceback \(most recent call last\):/m,
    reason: 'Python traceback error',
  },
  {
    pattern: /^\s*panic:\s+\S/m,
    reason: 'Process panic error',
  },
  {
    pattern: /\b(?:command|process)\s+(?:failed|exited)\s+with\s+(?:exit\s+)?code\s+[1-9]\d*\b/i,
    reason: 'Command exited with non-zero status',
  },
];

function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI_OSC_RX, '')
    .replace(ANSI_CSI_RX, '')
    .replace(ANSI_SINGLE_RX, '');
}

function getNonEmptyLines(text: string): string[] {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

function isIdlePromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('<')) return false;

  // Claude / Codex / Gemini bare or placeholder prompt
  if (/^[❯›>]\s*(?:Type your message.*|Ask anything.*)?$/i.test(trimmed)) return true;
  if (/^(?:claude|codex|gemini)>\s*$/i.test(trimmed)) return true;

  // PowerShell & Windows cmd prompts
  if (/^PS\s+[^\r\n>]+>\s*$/.test(trimmed)) return true;
  if (/^[A-Za-z]:\\[^\r\n<>|"]*>\s*$/.test(trimmed)) return true;

  // POSIX shell prompts (avoid matching prices like "$100" or percentages like "100 %")
  if (/^[$#]\s*$/.test(trimmed)) return true;
  if (/^[^\r\n]{1,120}(?:@[^\s]+|\/[^\s]*|~[^\s]*)\s*[$#%]\s*$/.test(trimmed)) return true;
  if (/^[a-zA-Z_][\w.-]*\s+%\s*$/.test(trimmed)) return true;

  return false;
}

function matchFirstRule(rules: PatternRule[], text: string): PatternRule | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

function approvalRulesForAgent(agentType: AgentType): PatternRule[] {
  if (agentType === 'claude') {
    return [...CLAUDE_APPROVAL_RULES, ...GEMINI_APPROVAL_RULES, ...GENERIC_APPROVAL_RULES];
  }
  if (agentType === 'codex') {
    return [...CODEX_APPROVAL_RULES, ...GENERIC_APPROVAL_RULES];
  }
  if (agentType === 'gemini' || agentType === 'antigravity') {
    return [...GEMINI_APPROVAL_RULES, ...GENERIC_APPROVAL_RULES];
  }
  // Shells and custom terminals can launch any CLI interactively, so check all CLI rules too.
  return [
    ...CLAUDE_APPROVAL_RULES,
    ...CODEX_APPROVAL_RULES,
    ...GEMINI_APPROVAL_RULES,
    ...GENERIC_APPROVAL_RULES,
  ];
}

function isClaudeMenuOption(tailLines: string[]): boolean {
  const tailText = tailLines.join('\n');
  if (!/\bEsc(?:ape)?\s+to\s+cancel\b/i.test(tailText)) return false;
  return /^[❯>]\s*\d+\.\s+\S+/m.test(tailText);
}

export function detectAttention(input: DetectAttentionInput): AttentionDetection {
  const now = input.now ?? Date.now();
  const workingThresholdMs = input.workingThresholdMs ?? DEFAULT_WORKING_THRESHOLD_MS;
  const wasWorking = Boolean(input.wasWorking);

  const lines = getNonEmptyLines(input.visibleText);
  const tailLines = lines.slice(-12);
  const tailText = tailLines.join('\n');
  const bottom5Text = lines.slice(-5).join('\n');
  const bottom3Text = lines.slice(-3).join('\n');

  // 1. Approval prompts take highest priority so user is notified immediately.
  const approvalRule = matchFirstRule(approvalRulesForAgent(input.agentType), tailText);
  if (approvalRule) {
    return { state: 'approval', reason: approvalRule.reason };
  }
  if (
    (input.agentType === 'claude' ||
      input.agentType === 'shell' ||
      input.agentType === 'custom') &&
    isClaudeMenuOption(tailLines)
  ) {
    return {
      state: 'approval',
      reason: 'Claude Code interactive confirmation menu',
    };
  }

  // 2. Interactive password / credential / input prompts.
  const inputTailRule = matchFirstRule(NEEDS_INPUT_TAIL_RULES, bottom3Text);
  if (inputTailRule) {
    return { state: 'needs-input', reason: inputTailRule.reason };
  }
  const inputSelectionRule = matchFirstRule(NEEDS_INPUT_SELECTION_RULES, tailText);
  if (inputSelectionRule) {
    return { state: 'needs-input', reason: inputSelectionRule.reason };
  }

  // 3. Active streaming or TUI progress footer.
  const isRecentlyStreaming =
    input.lastOutputAt > 0 && now - input.lastOutputAt < workingThresholdMs;
  const workingRule = matchFirstRule(WORKING_INDICATOR_RULES, bottom5Text);
  if (isRecentlyStreaming || workingRule) {
    return {
      state: 'working',
      reason: workingRule?.reason ?? 'Recent terminal output',
    };
  }

  // 4. Errors near the tail (strip a final bare shell/CLI prompt line so command errors right above
  // the returned prompt are still surfaced).
  const errorWindowLines = lines.slice(-6);
  if (errorWindowLines.length > 0 && isIdlePromptLine(errorWindowLines[errorWindowLines.length - 1])) {
    errorWindowLines.pop();
  }
  const errorRule = matchFirstRule(ERROR_RULES, errorWindowLines.join('\n'));
  if (errorRule) {
    return { state: 'error', reason: errorRule.reason };
  }

  // 5. Returned cleanly from working to an idle input prompt -> 'done'.
  // Check last 5 non-empty lines so TUI status footers below Claude's "❯" box don't mask the prompt.
  const hasIdlePrompt = lines.slice(-5).some(isIdlePromptLine);
  if (wasWorking && hasIdlePrompt) {
    return {
      state: 'done',
      reason: 'Returned to idle input prompt',
    };
  }

  return { state: 'idle', reason: null };
}

export class AttentionTracker {
  private workingThresholdMs: number;
  private attentionStates: Set<AttentionState>;
  private snapshots = new Map<string, TerminalAttentionSnapshot>();
  private transitionListeners = new Set<(ev: AttentionTransitionEvent) => void>();

  constructor(options: AttentionTrackerOptions = {}) {
    this.workingThresholdMs = options.workingThresholdMs ?? DEFAULT_WORKING_THRESHOLD_MS;
    this.attentionStates = new Set(
      options.attentionStates ?? ['approval', 'needs-input', 'error']
    );
  }

  evaluate(input: EvaluateTerminalAttentionInput): TerminalAttentionSnapshot {
    const now = input.now ?? Date.now();
    const prev = this.snapshots.get(input.terminalId);
    const wasWorking = prev?.state === 'working';

    let detected = detectAttention({
      agentType: input.agentType,
      visibleText: input.visibleText,
      lastOutputAt: input.lastOutputAt,
      now,
      wasWorking,
      workingThresholdMs: this.workingThresholdMs,
    });

    // Preserve one-shot 'done' state until user provides input or terminal resumes working/alerts.
    if (prev?.state === 'done' && detected.state === 'idle') {
      detected = { state: 'done', reason: prev.reason };
    }

    // Exited terminals cannot actively stream or wait for approval/input.
    if (input.running === false && detected.state !== 'error') {
      detected = { state: 'idle', reason: null };
    }

    const prevState: AttentionState = prev?.state ?? 'idle';
    const nextSnap: TerminalAttentionSnapshot = {
      terminalId: input.terminalId,
      state: detected.state,
      reason: detected.reason,
      updatedAt: now,
    };

    if (!prev || prev.state !== nextSnap.state || prev.reason !== nextSnap.reason) {
      this.snapshots.set(input.terminalId, nextSnap);
      if (prevState !== nextSnap.state) {
        const ev: AttentionTransitionEvent = {
          terminalId: input.terminalId,
          previousState: prevState,
          nextState: nextSnap.state,
          reason: nextSnap.reason,
          timestamp: now,
        };
        for (const cb of this.transitionListeners) {
          cb(ev);
        }
      }
    }

    return nextSnap;
  }

  /** Clears a sticky 'done' state (e.g., when the user sends input to the terminal). */
  noteInput(terminalId: string, now = Date.now()): void {
    const prev = this.snapshots.get(terminalId);
    if (!prev || prev.state !== 'done') return;
    const nextSnap: TerminalAttentionSnapshot = {
      terminalId,
      state: 'idle',
      reason: null,
      updatedAt: now,
    };
    this.snapshots.set(terminalId, nextSnap);
    const ev: AttentionTransitionEvent = {
      terminalId,
      previousState: 'done',
      nextState: 'idle',
      reason: null,
      timestamp: now,
    };
    for (const cb of this.transitionListeners) {
      cb(ev);
    }
  }

  getSnapshot(terminalId: string): TerminalAttentionSnapshot | null {
    return this.snapshots.get(terminalId) ?? null;
  }

  getAttentionIds(): string[] {
    const ids: string[] = [];
    for (const snap of this.snapshots.values()) {
      if (this.attentionStates.has(snap.state)) {
        ids.push(snap.terminalId);
      }
    }
    return ids;
  }

  getAttentionReasons(): Record<string, string> {
    const reasons: Record<string, string> = {};
    for (const snap of this.snapshots.values()) {
      if (this.attentionStates.has(snap.state) && snap.reason) {
        reasons[snap.terminalId] = snap.reason;
      }
    }
    return reasons;
  }

  remove(terminalId: string): void {
    this.snapshots.delete(terminalId);
  }

  clear(): void {
    this.snapshots.clear();
  }

  onTransition(cb: (ev: AttentionTransitionEvent) => void): () => void {
    this.transitionListeners.add(cb);
    return () => this.transitionListeners.delete(cb);
  }
}
