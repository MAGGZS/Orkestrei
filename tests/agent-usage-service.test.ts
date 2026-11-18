import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentUsageProviderId, AgentUsageSnapshot } from '../src/shared/types';
import type { TokenTrackingTarget } from '../src/main/pty-manager';
import {
  AgentUsageService,
  ProviderTimeoutError,
  buildMinimalUsageEnv,
  resolveCliExecutable,
  runCommandJson,
  runStdioJsonExchange,
} from '../src/main/agent-usage-service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await sleep(5);
  }
}

function makeTarget(
  overrides: Partial<TokenTrackingTarget> & Pick<TokenTrackingTarget, 'terminalId' | 'agentType'>
): TokenTrackingTarget {
  return {
    cwd: process.cwd(),
    command: null,
    spawnedAt: 1_000,
    claudeSessionId: null,
    running: true,
    ...overrides,
  };
}

function claudeSuccessEnvelope(fiveHourPct = 42, sevenDayPct = 65): Record<string, unknown> {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'orkestrei-usage',
      response: {
        rate_limits_available: true,
        subscription_type: 'max',
        rate_limits: {
          five_hour: {
            utilization: fiveHourPct,
            resets_at: '2026-11-18T02:00:00Z',
          },
          seven_day: {
            utilization: sevenDayPct,
            resets_at: '2026-11-22T00:00:00Z',
          },
        },
      },
    },
  };
}

function codexSuccessEnvelope(primaryPct = 15, secondaryPct = 30): Record<string, unknown> {
  return {
    id: 2,
    result: {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        planType: 'prolite',
        primary: {
          usedPercent: primaryPct,
          resetsAt: 1_795_000_000,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: secondaryPct,
          resetsAt: 1_795_500_000,
          windowDurationMins: 10080,
        },
      },
    },
  };
}

function antigravitySuccessEnvelope(remainingFraction = 0.75): Record<string, unknown> {
  return {
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-5h',
                remaining_fraction: remainingFraction,
                reset_time: '2026-11-18T03:00:00Z',
                window: '5h',
              },
              {
                id: 'gemini-weekly',
                remaining_fraction: 0.9,
                reset_time: '2026-11-24T00:00:00Z',
                window: '7d',
              },
            ],
          },
        ],
      },
    },
  };
}

describe('AgentUsageService & CLI helpers', () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orkestrei-agent-usage-test-'));
  });

  afterAll(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });

  it('resolves binaries in PATH/usual dirs (including ~/.claude/local) and ignores .cmd/.bat/.ps1 wrappers on Windows', async () => {
    const fakeHome = path.join(tempRoot, 'home-exec');
    const localBin = path.join(fakeHome, '.local', 'bin');
    const claudeLocalDir = path.join(fakeHome, '.claude', 'local');
    const npmDir = path.join(tempRoot, 'appdata-npm');
    const pathDir = path.join(tempRoot, 'path-bin');
    await fsp.mkdir(localBin, { recursive: true });
    await fsp.mkdir(claudeLocalDir, { recursive: true });
    await fsp.mkdir(npmDir, { recursive: true });
    await fsp.mkdir(pathDir, { recursive: true });

    if (process.platform === 'win32') {
      await fsp.writeFile(path.join(localBin, 'claude.exe'), 'bin', 'utf8');
      await fsp.writeFile(path.join(npmDir, 'codex.cmd'), '@echo off\r\n', 'utf8');
      await fsp.writeFile(path.join(pathDir, 'agy.ps1'), 'Write-Host hi\n', 'utf8');

      const foundClaude = await resolveCliExecutable('claude', {
        env: { PATH: pathDir, APPDATA: tempRoot },
        homeDir: fakeHome,
        checkRegistryOnWindows: false,
      });
      expect(foundClaude?.toLowerCase()).toBe(path.join(localBin, 'claude.exe').toLowerCase());

      // Legacy ~/.claude/local fallback when ~/.local/bin has no binary
      await fsp.unlink(path.join(localBin, 'claude.exe'));
      await fsp.writeFile(path.join(claudeLocalDir, 'claude.exe'), 'bin', 'utf8');
      const foundClaudeLegacy = await resolveCliExecutable('claude', {
        env: { PATH: pathDir, APPDATA: tempRoot },
        homeDir: fakeHome,
        checkRegistryOnWindows: false,
      });
      expect(foundClaudeLegacy?.toLowerCase()).toBe(
        path.join(claudeLocalDir, 'claude.exe').toLowerCase()
      );

      const foundCodex = await resolveCliExecutable('codex', {
        env: { PATH: `${npmDir}${path.delimiter}${pathDir}`, APPDATA: tempRoot },
        homeDir: fakeHome,
        checkRegistryOnWindows: false,
      });
      expect(foundCodex).toBeNull();

      const foundAgy = await resolveCliExecutable('agy', {
        env: { PATH: pathDir },
        homeDir: fakeHome,
        checkRegistryOnWindows: false,
      });
      expect(foundAgy).toBeNull();
    } else {
      const binFile = path.join(localBin, 'claude');
      await fsp.writeFile(binFile, '#!/bin/sh\nexit 0\n', 'utf8');
      await fsp.chmod(binFile, 0o755);

      const found = await resolveCliExecutable('claude', {
        env: { PATH: pathDir },
        homeDir: fakeHome,
      });
      expect(found).toBe(binFile);
    }
  });

  it('builds minimal env without leaking sensitive Orkestrei or nested-session vars', () => {
    const env = buildMinimalUsageEnv(
      process.execPath,
      { CODEX_SQLITE_HOME: path.join(tempRoot, 'codex-cache') },
      {
        PATH: process.env.PATH ?? '',
        SystemRoot: 'C:\\Windows',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        MAESTRI_TOKEN: 'secret-token',
        MAESTRI_PIPE: 'http://127.0.0.1:9999',
        ELECTRON_RUN_AS_NODE: '1',
      },
      tempRoot
    );

    expect(env.HOME).toBe(tempRoot);
    expect(env.TERM).toBe('dumb');
    expect(env.NO_COLOR).toBe('1');
    expect(env.CODEX_SQLITE_HOME).toBe(path.join(tempRoot, 'codex-cache'));
    expect(env.PATH).toContain(path.dirname(process.execPath));
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.MAESTRI_TOKEN).toBeUndefined();
    expect(env.MAESTRI_PIPE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('runs real non-shell command JSON and stdio JSON-RPC exchanges and kills on timeout', async () => {
    const emptyCwd = path.join(tempRoot, 'empty-spawn-cwd');
    await fsp.mkdir(emptyCwd, { recursive: true });
    const ac = new AbortController();

    // 1. Command JSON ignoring stderr
    const cmdRes = await runCommandJson({
      executablePath: process.execPath,
      args: [
        '-e',
        'console.error("stderr noise"); process.stdout.write(JSON.stringify({ status: "SUCCESS", ok: true }));',
      ],
      cwd: emptyCwd,
      env: buildMinimalUsageEnv(process.execPath),
      timeoutMs: 5000,
      signal: ac.signal,
    });
    expect(cmdRes).toEqual({ status: 'SUCCESS', ok: true });

    // 2. Multi-step stdio exchange ignoring non-JSON lines and handling EOF without trailing newline
    const stdioRes = await runStdioJsonExchange({
      executablePath: process.execPath,
      args: [
        '-e',
        [
          'const rl = require("node:readline").createInterface({ input: process.stdin });',
          'console.log("NOT_JSON_BANNER");',
          'rl.on("line", (line) => {',
          '  const msg = JSON.parse(line);',
          '  if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { ok: true } }) + "\\n");',
          '  if (msg.id === 2) { process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { limitId: "codex" } } })); process.exit(0); }',
          '});',
        ].join(' '),
      ],
      cwd: emptyCwd,
      env: buildMinimalUsageEnv(process.execPath),
      timeoutMs: 5000,
      signal: ac.signal,
      exchange: async (writeJson, awaitJson) => {
        writeJson({ id: 1, method: 'initialize' });
        const r1 = await awaitJson((o) => o.id === 1);
        expect(r1.result).toEqual({ ok: true });
        writeJson({ method: 'initialized' });
        writeJson({ id: 2, method: 'account/rateLimits/read' });
        return awaitJson((o) => o.id === 2);
      },
    });
    expect(stdioRes).toEqual({ id: 2, result: { rateLimits: { limitId: 'codex' } } });

    // 3. Non-zero exit without JSON includes bounded stderr reason
    await expect(
      runCommandJson({
        executablePath: process.execPath,
        args: ['-e', 'console.error("Not signed in"); process.exit(1);'],
        cwd: emptyCwd,
        env: buildMinimalUsageEnv(process.execPath),
        timeoutMs: 5000,
        signal: ac.signal,
      })
    ).rejects.toThrow(/Not signed in/);

    // 4. Timeout aborts and kills hanging child process
    await expect(
      runCommandJson({
        executablePath: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000);'],
        cwd: emptyCwd,
        env: buildMinimalUsageEnv(process.execPath),
        timeoutMs: 120,
        signal: ac.signal,
      })
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('polls all configured providers even when only one provider has an active terminal, maps byTerminal, cleans temp cwds, and resets Codex cache on timeout', async () => {
    let nowMs = 1_000_000;
    const cacheDir = path.join(tempRoot, 'svc-cache');
    const seenCwds: string[] = [];
    const seenCodexEnvs: Array<string | undefined> = [];
    const targets: TokenTrackingTarget[] = [
      makeTarget({ terminalId: 't-claude-idle', agentType: 'claude', running: false }),
      makeTarget({ terminalId: 't-shell-agy', agentType: 'shell', command: 'agy --help', running: true }),
      makeTarget({ terminalId: 't-plain-shell', agentType: 'shell', command: null, running: true }),
    ];

    const calls: AgentUsageProviderId[] = [];
    let codexShouldTimeout = true;

    const svc = new AgentUsageService(
      { getTokenTargets: () => targets },
      {
        cacheDir,
        now: () => nowMs,
        minRequestGapMs: 60_000,
        manualMinGapMs: 10_000,
        resolveExecutable: async (id) => `/fake/${id}`,
        runProvider: async ({ providerId, cwd, env }) => {
          calls.push(providerId);
          seenCwds.push(cwd);
          // Temp cwd must exist and be empty during execution.
          expect(fs.readdirSync(cwd)).toEqual([]);
          if (providerId === 'claude') return claudeSuccessEnvelope(33, 77);
          if (providerId === 'antigravity') return antigravitySuccessEnvelope(0.6);
          seenCodexEnvs.push(env.CODEX_SQLITE_HOME);
          if (codexShouldTimeout) {
            await fsp.writeFile(path.join(env.CODEX_SQLITE_HOME, 'dirty.sqlite'), 'x', 'utf8');
            throw new ProviderTimeoutError(60_000);
          }
          return codexSuccessEnvelope(22, 44);
        },
      }
    );

    const snapshots: AgentUsageSnapshot[] = [];
    svc.onChanged((s) => snapshots.push(s));

    svc.syncTargets();
    await waitUntil(
      () =>
        svc.getSnapshot().providers.claude?.state === 'ready' &&
        svc.getSnapshot().providers.antigravity?.state === 'ready' &&
        svc.getSnapshot().providers.codex?.state === 'timeout'
    );

    // All configured providers are polled even when only Antigravity is running in a terminal.
    expect(calls.sort()).toEqual(['antigravity', 'claude', 'codex']);

    const snap1 = svc.getSnapshot();
    expect(snap1.byTerminal).toEqual({
      't-claude-idle': 'claude',
      't-shell-agy': 'antigravity',
    });
    expect(snap1.providers.claude?.state).toBe('ready');
    expect(snap1.providers.claude?.plan).toBe('max');
    expect(snap1.providers.claude?.meters[0].windows[0].usedPercent).toBe(33);
    expect(snap1.providers.antigravity?.state).toBe('ready');
    expect(snap1.providers.antigravity?.meters[0].windows[0].usedPercent).toBeCloseTo(40);
    expect(snap1.providers.codex?.state).toBe('timeout');
    expect(seenCodexEnvs[0]).toBe(path.join(cacheDir, 'codex'));
    expect(fs.existsSync(path.join(cacheDir, 'codex', 'dirty.sqlite'))).toBe(false);
    expect(snapshots.length).toBeGreaterThanOrEqual(3);

    // Temp cwds must be cleaned up after runs.
    for (const cwd of seenCwds) {
      expect(fs.existsSync(cwd)).toBe(false);
    }

    // Manual refresh bypasses timeout backoff and succeeds when codex recovers.
    codexShouldTimeout = false;
    nowMs += 2_000;
    await svc.refresh('codex');
    expect(svc.getSnapshot().providers.codex?.state).toBe('ready');
    expect(svc.getSnapshot().providers.codex?.plan).toBe('Pro Lite');

    svc.stop();
  });

  it('discovers logged-in Claude and missing/unlogged providers even with zero agent terminals open and refreshes all providers', async () => {
    const targets: TokenTrackingTarget[] = [
      makeTarget({ terminalId: 't-shell', agentType: 'shell', command: null, running: true }),
    ];

    const svc = new AgentUsageService(
      { getTokenTargets: () => targets },
      {
        resolveExecutable: async (id) => (id === 'codex' ? null : `C:\\mock\\${id}.exe`),
        runProvider: async ({ providerId }) => {
          if (providerId === 'claude') return claudeSuccessEnvelope(21, 90);
          return { status: 'ERROR', error: 'Not authenticated' };
        },
      }
    );

    svc.start();
    await waitUntil(
      () =>
        svc.getSnapshot().providers.claude?.state === 'ready' &&
        svc.getSnapshot().providers.codex?.state === 'executableNotFound' &&
        svc.getSnapshot().providers.antigravity?.state === 'error'
    );

    const snap = svc.getSnapshot();
    expect(snap.byTerminal).toEqual({});
    expect(snap.providers.claude?.state).toBe('ready');
    expect(snap.providers.claude?.meters[0].windows[0].usedPercent).toBe(21);
    expect(snap.providers.codex?.state).toBe('executableNotFound');
    expect(snap.providers.antigravity?.state).toBe('error');
    expect(snap.providers.antigravity?.error).toBe('Not authenticated');

    svc.stop();
  });

  it('enforces max 2 concurrency, dedupes in-flight refresh, respects 10s manual floor and 30m backoff', async () => {
    let nowMs = 5_000_000;
    let activeNow = 0;
    let peakConcurrent = 0;
    const runCounts: Record<AgentUsageProviderId, number> = {
      claude: 0,
      codex: 0,
      antigravity: 0,
    };

    const targets: TokenTrackingTarget[] = [
      makeTarget({ terminalId: 't1', agentType: 'claude', running: true }),
      makeTarget({ terminalId: 't2', agentType: 'codex', running: true }),
      makeTarget({ terminalId: 't3', agentType: 'antigravity', running: true }),
    ];

    let failClaude = false;

    const svc = new AgentUsageService(
      { getTokenTargets: () => targets },
      {
        now: () => nowMs,
        maxConcurrent: 2,
        minRequestGapMs: 60_000,
        manualMinGapMs: 10_000,
        baseBackoffMs: 60_000,
        maxBackoffMs: 30 * 60_000,
        pollIntervalMs: { claude: 300_000, codex: 300_000, antigravity: 600_000 },
        resolveExecutable: async (id) => `/bin/${id}`,
        runProvider: async ({ providerId }) => {
          runCounts[providerId] += 1;
          activeNow += 1;
          peakConcurrent = Math.max(peakConcurrent, activeNow);
          await sleep(25);
          activeNow -= 1;
          if (providerId === 'claude' && failClaude) {
            throw new Error('simulated failure');
          }
          if (providerId === 'claude') return claudeSuccessEnvelope();
          if (providerId === 'codex') return codexSuccessEnvelope();
          return antigravitySuccessEnvelope();
        },
      }
    );

    // 1. Trigger all 3 concurrently via manual refresh -> peak concurrency capped at 2.
    await svc.refresh();
    expect(peakConcurrent).toBe(2);
    expect(runCounts).toEqual({ claude: 1, codex: 1, antigravity: 1 });

    // 2. Manual refresh within 10s floor is skipped.
    nowMs += 5_000;
    await svc.refresh('claude');
    expect(runCounts.claude).toBe(1);

    // 3. Past 10s floor: two parallel refresh calls dedupe into a single execution.
    nowMs += 6_000; // +11s total from first manual refresh
    await Promise.all([svc.refresh('claude'), svc.refresh('claude')]);
    expect(runCounts.claude).toBe(2);

    // 4. Auto-poll before 300s/600s does not run; at +305s claude & codex run, antigravity waits for 600s.
    failClaude = true;
    nowMs += 305_000;
    svc.syncTargets();
    await waitUntil(
      () =>
        svc.getSnapshot().providers.claude?.state === 'error' &&
        svc.getSnapshot().providers.codex?.state === 'ready' &&
        runCounts.claude === 3 &&
        runCounts.codex === 2
    );
    expect(runCounts).toEqual({ claude: 3, codex: 2, antigravity: 1 });
    expect(svc.getSnapshot().providers.claude?.state).toBe('error');

    // 5. Exponential backoff on claude failures: 60s -> 120s -> 240s -> ... -> capped at 30m.
    nowMs += 30_000; // < 60s backoff
    svc.syncTargets();
    await sleep(40);
    expect(runCounts.claude).toBe(3);

    nowMs += 35_000; // >= 60s -> 2nd failure (next backoff = 120s)
    svc.syncTargets();
    await waitUntil(() => runCounts.claude === 4 && svc.getSnapshot().providers.claude?.state === 'error');

    nowMs += 90_000; // < 120s
    svc.syncTargets();
    await sleep(40);
    expect(runCounts.claude).toBe(4);

    nowMs += 35_000; // >= 120s -> 3rd failure
    svc.syncTargets();
    await waitUntil(() => runCounts.claude === 5 && svc.getSnapshot().providers.claude?.state === 'error');

    // 6. Manual refresh bypasses backoff and resets failure count on recovery.
    failClaude = false;
    nowMs += 15_000;
    await svc.refresh('claude');
    expect(runCounts.claude).toBe(6);
    expect(svc.getSnapshot().providers.claude?.state).toBe('ready');

    // 7. Antigravity runs once 600s elapsed since its first run.
    nowMs += 200_000;
    svc.syncTargets();
    await waitUntil(
      () => runCounts.antigravity === 2 && svc.getSnapshot().providers.antigravity?.state === 'ready'
    );
    expect(runCounts.antigravity).toBe(2);

    svc.stop();
  });

  it('reports executableNotFound when binary is missing', async () => {
    const svc = new AgentUsageService(
      {
        getTokenTargets: () => [
          makeTarget({ terminalId: 't-codex', agentType: 'codex', running: true }),
        ],
      },
      {
        resolveExecutable: async () => null,
      }
    );

    await svc.refresh('codex');
    const status = svc.getSnapshot().providers.codex;
    expect(status?.state).toBe('executableNotFound');
    expect(status?.executable).toBeNull();
    expect(status?.error).toContain('codex');
    svc.stop();
  });
});
