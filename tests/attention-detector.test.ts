import { describe, expect, it } from 'vitest';
import { AttentionTracker, detectAttention } from '../src/main/attention-detector';

describe('detectAttention', () => {
  const now = 100_000;

  it('detects Claude Code approval prompts and numbered menus', () => {
    const proceed = detectAttention({
      agentType: 'claude',
      visibleText: 'Edit src/app.ts\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel',
      lastOutputAt: now - 200,
      now,
      wasWorking: true,
    });
    expect(proceed.state).toBe('approval');
    expect(proceed.reason).toContain('Do you want to proceed?');

    const menuOnly = detectAttention({
      agentType: 'claude',
      visibleText: 'Run bash tool\n❯ 1. Yes\n  2. Yes, and always allow\n  3. No',
      lastOutputAt: now - 5000,
      now,
      wasWorking: false,
    });
    expect(menuOnly.state).toBe('approval');
  });

  it('detects Codex approval prompts', () => {
    const allowCmd = detectAttention({
      agentType: 'codex',
      visibleText: 'Proposed command: npm test\nAllow command?\n[y]es / [n]o',
      lastOutputAt: now - 4000,
      now,
      wasWorking: true,
    });
    expect(allowCmd.state).toBe('approval');
    expect(allowCmd.reason).toContain('Allow command?');

    const approveWord = detectAttention({
      agentType: 'codex',
      visibleText: 'Run git status\nPress Enter to approve',
      lastOutputAt: now - 4000,
      now,
      wasWorking: true,
    });
    expect(approveWord.state).toBe('approval');
  });

  it('detects Gemini / Antigravity approval prompts', () => {
    expect(
      detectAttention({
        agentType: 'gemini',
        visibleText: 'Tool call: write_file\nAllow execution? (y/n)',
        lastOutputAt: now - 500,
        now,
        wasWorking: true,
      }).state
    ).toBe('approval');

    expect(
      detectAttention({
        agentType: 'antigravity',
        visibleText: 'Step pending\nWaiting for user confirmation',
        lastOutputAt: now - 3000,
        now,
        wasWorking: true,
      }).state
    ).toBe('approval');
  });

  it('detects generic shell confirmations and password / input prompts', () => {
    expect(
      detectAttention({
        agentType: 'shell',
        visibleText: 'Do you want to continue? [Y/n]',
        lastOutputAt: now - 3000,
        now,
        wasWorking: true,
      }).state
    ).toBe('approval');

    const sudoPrompt = detectAttention({
      agentType: 'shell',
      visibleText: '[sudo] password for magdi:',
      lastOutputAt: now - 3000,
      now,
      wasWorking: true,
    });
    expect(sudoPrompt.state).toBe('needs-input');

    const sshPrompt = detectAttention({
      agentType: 'shell',
      visibleText: "Enter passphrase for key '/home/u/.ssh/id_ed25519':",
      lastOutputAt: now - 3000,
      now,
      wasWorking: true,
    });
    expect(sshPrompt.state).toBe('needs-input');

    const choicePrompt = detectAttention({
      agentType: 'claude',
      visibleText: 'Which approach?\nEnter to select · ↑/↓ to navigate',
      lastOutputAt: now - 3000,
      now,
      wasWorking: true,
    });
    expect(choicePrompt.state).toBe('needs-input');
  });

  it('treats active Claude TUI footer with esc to interrupt as working even when prompt box is visible', () => {
    const res = detectAttention({
      agentType: 'claude',
      visibleText: [
        '\x1b[36m✶ Spelunking… (59s · ↓ 2.7k tokens · thinking)\x1b[0m',
        '────────────────────────────────────────',
        '❯ ',
        '────────────────────────────────────────',
        '  auto mode on · esc to interrupt',
      ].join('\n'),
      lastOutputAt: now - 4000,
      now,
      wasWorking: true,
    });
    expect(res.state).toBe('working');
  });

  it('detects working via recent output timestamp', () => {
    const res = detectAttention({
      agentType: 'shell',
      visibleText: 'Compiling module 4 of 12...',
      lastOutputAt: now - 500,
      now,
      wasWorking: false,
    });
    expect(res.state).toBe('working');
  });

  it('detects terminal and API errors near the tail when stopped', () => {
    const apiErr = detectAttention({
      agentType: 'claude',
      visibleText: 'API Error: Rate limit exceeded\n❯ ',
      lastOutputAt: now - 5000,
      now,
      wasWorking: true,
    });
    expect(apiErr.state).toBe('error');

    const procErr = detectAttention({
      agentType: 'shell',
      visibleText: 'Error: ENOENT: no such file or directory\nPS C:\\proj> ',
      lastOutputAt: now - 5000,
      now,
      wasWorking: true,
    });
    expect(procErr.state).toBe('error');
  });

  it('returns done when wasWorking transitions cleanly to an idle prompt, and idle otherwise', () => {
    const claudeDone = detectAttention({
      agentType: 'claude',
      visibleText: [
        '● Tudo pronto.',
        '────────────────────────────────────────',
        '❯ ',
        '────────────────────────────────────────',
        '  shift+tab to cycle',
      ].join('\n'),
      lastOutputAt: now - 5000,
      now,
      wasWorking: true,
    });
    expect(claudeDone.state).toBe('done');

    const psDone = detectAttention({
      agentType: 'shell',
      visibleText: 'Build succeeded.\nPS C:\\Users\\magdi\\Orkestrei> ',
      lastOutputAt: now - 5000,
      now,
      wasWorking: true,
    });
    expect(psDone.state).toBe('done');

    // Long-running command paused between log lines without returning to a prompt -> not done
    const pausedBuild = detectAttention({
      agentType: 'shell',
      visibleText: 'Progress: 50 %\n</attached_note>',
      lastOutputAt: now - 5000,
      now,
      wasWorking: true,
    });
    expect(pausedBuild.state).toBe('idle');

    // Never working -> idle
    const alreadyIdle = detectAttention({
      agentType: 'shell',
      visibleText: 'PS C:\\Users\\magdi\\Orkestrei> ',
      lastOutputAt: now - 5000,
      now,
      wasWorking: false,
    });
    expect(alreadyIdle.state).toBe('idle');
  });
});

describe('AttentionTracker', () => {
  it('tracks per-terminal state, emits transitions, and tracks attention IDs', () => {
    const tracker = new AttentionTracker({ workingThresholdMs: 1800 });
    const transitions: Array<{ from: string; to: string }> = [];
    tracker.onTransition((ev) => {
      transitions.push({ from: ev.previousState, to: ev.nextState });
    });

    // 1. Working
    const s1 = tracker.evaluate({
      terminalId: 't1',
      agentType: 'claude',
      visibleText: 'Thinking...',
      lastOutputAt: 1000,
      running: true,
      now: 1500,
    });
    expect(s1.state).toBe('working');
    expect(tracker.getAttentionIds()).toEqual([]);

    // 2. Approval needed
    const s2 = tracker.evaluate({
      terminalId: 't1',
      agentType: 'claude',
      visibleText: 'Do you want to proceed?\n❯ 1. Yes\n  2. No',
      lastOutputAt: 1600,
      running: true,
      now: 2000,
    });
    expect(s2.state).toBe('approval');
    expect(tracker.getAttentionIds()).toEqual(['t1']);
    expect(tracker.getAttentionReasons().t1).toContain('Do you want to proceed?');

    // 3. Resume working
    tracker.evaluate({
      terminalId: 't1',
      agentType: 'claude',
      visibleText: 'Running tool...',
      lastOutputAt: 5000,
      running: true,
      now: 5200,
    });
    expect(tracker.getAttentionIds()).toEqual([]);

    // 4. Finish cleanly -> done (sticky until user input)
    const s4 = tracker.evaluate({
      terminalId: 't1',
      agentType: 'claude',
      visibleText: 'Completed.\n❯ ',
      lastOutputAt: 5000,
      running: true,
      now: 8000,
    });
    expect(s4.state).toBe('done');

    const s4Repeat = tracker.evaluate({
      terminalId: 't1',
      agentType: 'claude',
      visibleText: 'Completed.\n❯ ',
      lastOutputAt: 5000,
      running: true,
      now: 9000,
    });
    expect(s4Repeat.state).toBe('done');

    // 5. User types input -> clears sticky done to idle
    tracker.noteInput('t1', 9500);
    expect(tracker.getSnapshot('t1')?.state).toBe('idle');

    expect(transitions).toEqual([
      { from: 'idle', to: 'working' },
      { from: 'working', to: 'approval' },
      { from: 'approval', to: 'working' },
      { from: 'working', to: 'done' },
      { from: 'done', to: 'idle' },
    ]);

    tracker.remove('t1');
    expect(tracker.getSnapshot('t1')).toBeNull();
  });
});
