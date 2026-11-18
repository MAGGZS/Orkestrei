import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TokenTrackingTarget } from '../src/main/pty-manager';
import {
  TokenUsageService,
  claudeProjectSlug,
  resolveTokenProvider,
} from '../src/main/token-usage-service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function todayLocalRelDir(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(String(y), m, d);
}

describe('TokenUsageService', () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orkestrei-tokens-vitest-'));
  });

  afterAll(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('infers provider from agentType or command first token', () => {
    const base: TokenTrackingTarget = {
      terminalId: 't-prov',
      cwd: process.cwd(),
      agentType: 'shell',
      command: null,
      spawnedAt: Date.now(),
      claudeSessionId: null,
      running: true,
    };

    expect(resolveTokenProvider({ ...base, agentType: 'claude' })).toBe('claude');
    expect(resolveTokenProvider({ ...base, agentType: 'codex' })).toBe('codex');
    expect(resolveTokenProvider({ ...base, agentType: 'gemini' })).toBe('gemini');
    expect(resolveTokenProvider({ ...base, command: 'claude --model sonnet' })).toBe('claude');
    expect(
      resolveTokenProvider({
        ...base,
        agentType: 'custom',
        command: '"C:\\Program Files\\codex\\codex.exe" --no-daemon',
      })
    ).toBe('codex');
    expect(resolveTokenProvider({ ...base, command: 'gemini.cmd -y' })).toBe('gemini');
    expect(resolveTokenProvider({ ...base, command: 'pwsh.exe' })).toBeNull();
    expect(resolveTokenProvider(base)).toBeNull();
  });

  it('parses Claude JSONL incrementally with message.id dedupe, partial lines, shrink reset, and 1M window', async () => {
    const claudeDir = path.join(tempRoot, 'claude');
    const cwd = path.join(tempRoot, 'WorkRepo');
    await fsp.mkdir(cwd, { recursive: true });

    const slug = claudeProjectSlug(cwd);
    const projectDir = path.join(claudeDir, 'projects', slug);
    await fsp.mkdir(projectDir, { recursive: true });

    const sessionId = '11111111-1111-4111-8111-111111111111';
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: 100,
            output_tokens: 15,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 2000,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: 100,
            output_tokens: 120,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 2000,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_2',
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: 50,
            output_tokens: 80,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 3000,
          },
        },
      }),
    ];
    await fsp.writeFile(sessionFile, `${lines.join('\n')}\n`, 'utf8');

    const targets: TokenTrackingTarget[] = [
      {
        terminalId: 'claude-1',
        cwd,
        agentType: 'claude',
        command: 'claude',
        spawnedAt: Date.now() - 1000,
        claudeSessionId: sessionId,
        running: true,
      },
    ];

    const svc = new TokenUsageService(
      { getTokenTargets: () => targets },
      { claudeConfigDir: claudeDir }
    );

    let changeEvents = 0;
    svc.onChanged(() => {
      changeEvents += 1;
    });

    const m1 = await svc.poll();
    const u1 = m1['claude-1'];
    expect(u1).toBeDefined();
    expect(u1.provider).toBe('claude');
    expect(u1.model).toBe('claude-sonnet-4-5-20250929');
    expect(u1.turns).toBe(2);
    expect(u1.inputTokens).toBe(150);
    expect(u1.outputTokens).toBe(200);
    expect(u1.cacheReadTokens).toBe(5000);
    expect(u1.cacheWriteTokens).toBe(700);
    expect(u1.totalTokens).toBe(6050);
    expect(u1.contextTokens).toBe(50 + 3000 + 200 + 80);
    expect(u1.contextWindow).toBe(200_000);
    expect(changeEvents).toBe(1);

    await svc.poll();
    expect(changeEvents).toBe(1);

    const turn3 = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_3',
        model: 'claude-opus-4-6[1m]',
        usage: {
          input_tokens: 40,
          output_tokens: 60,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4000,
        },
      },
    });
    await fsp.appendFile(sessionFile, turn3.slice(0, 35), 'utf8');
    await svc.poll();
    expect(svc.getSnapshot()['claude-1']?.turns).toBe(2);

    await fsp.appendFile(sessionFile, `${turn3.slice(35)}\n`, 'utf8');
    const m2 = await svc.poll();
    const u2 = m2['claude-1'];
    expect(u2.turns).toBe(3);
    expect(u2.model).toBe('claude-opus-4-6[1m]');
    expect(u2.contextWindow).toBe(1_000_000);
    expect(u2.inputTokens).toBe(190);
    expect(u2.outputTokens).toBe(260);
    expect(u2.cacheReadTokens).toBe(9000);
    expect(u2.contextTokens).toBe(4100);
    expect(changeEvents).toBe(2);

    const shrunk = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_shrunk',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 210_000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    await fsp.writeFile(sessionFile, shrunk, 'utf8');
    const m3 = await svc.poll();
    const u3 = m3['claude-1'];
    expect(u3.turns).toBe(1);
    expect(u3.inputTokens).toBe(210_000);
    expect(u3.contextTokens).toBe(210_500);
    expect(u3.contextWindow).toBe(1_000_000);

    svc.stop();
  });

  it('ignores sidechain and <synthetic> turns for Claude contextTokens/model while keeping sidechain totals', async () => {
    const claudeDir = path.join(tempRoot, 'claude-sidechain');
    const cwd = path.join(tempRoot, 'SidechainRepo');
    await fsp.mkdir(cwd, { recursive: true });
    const projectDir = path.join(claudeDir, 'projects', claudeProjectSlug(cwd));
    await fsp.mkdir(projectDir, { recursive: true });

    const sid = '22222222-2222-4222-8222-222222222222';
    const sessionFile = path.join(projectDir, `${sid}.jsonl`);
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'main_1',
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 4000,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          id: 'side_1',
          model: 'claude-haiku-4-5',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 200,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'syn_1',
          model: '<synthetic>',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ];
    await fsp.writeFile(sessionFile, `${lines.join('\n')}\n`, 'utf8');

    const svc = new TokenUsageService(
      {
        getTokenTargets: () => [
          {
            terminalId: 't-side',
            cwd,
            agentType: 'claude',
            command: 'claude',
            spawnedAt: Date.now() - 1000,
            claudeSessionId: sid,
            running: true,
          },
        ],
      },
      { claudeConfigDir: claudeDir }
    );

    const map = await svc.poll();
    const u = map['t-side'];
    expect(u).toBeDefined();
    expect(u.model).toBe('claude-sonnet-4-5');
    expect(u.contextTokens).toBe(5500);
    expect(u.inputTokens).toBe(1100);
    expect(u.outputTokens).toBe(250);
    expect(u.cacheReadTokens).toBe(4200);
    expect(u.cacheWriteTokens).toBe(300);
    expect(u.totalTokens).toBe(5850);
    expect(u.turns).toBe(3);
    svc.stop();
  });

  it('rebinds exact --session-id Claude terminal to newer unclaimed file after /clear', async () => {
    const claudeDir = path.join(tempRoot, 'claude-exact-clear');
    const cwd = path.join(tempRoot, 'ExactClearRepo');
    await fsp.mkdir(cwd, { recursive: true });
    const projectDir = path.join(claudeDir, 'projects', claudeProjectSlug(cwd));
    await fsp.mkdir(projectDir, { recursive: true });

    const sid = '33333333-3333-4333-8333-333333333333';
    const exactFile = path.join(projectDir, `${sid}.jsonl`);
    await fsp.writeFile(
      exactFile,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm_exact',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 5000, output_tokens: 400 },
        },
      })}\n`,
      'utf8'
    );

    const svc = new TokenUsageService(
      {
        getTokenTargets: () => [
          {
            terminalId: 't-exact-clear',
            cwd,
            agentType: 'claude',
            command: 'claude',
            spawnedAt: Date.now() - 1000,
            claudeSessionId: sid,
            running: true,
          },
        ],
      },
      { claudeConfigDir: claudeDir }
    );

    const m1 = await svc.poll();
    expect(m1['t-exact-clear']?.sessionFile).toBe(exactFile);
    expect(m1['t-exact-clear']?.contextTokens).toBe(5400);

    await sleep(40);
    const clearedFile = path.join(projectDir, '44444444-4444-4444-8444-444444444444.jsonl');
    await fsp.writeFile(
      clearedFile,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm_cleared',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 120, output_tokens: 30 },
        },
      })}\n`,
      'utf8'
    );

    const m2 = await svc.poll();
    expect(m2['t-exact-clear']?.sessionFile).toBe(clearedFile);
    expect(m2['t-exact-clear']?.contextTokens).toBe(150);

    const m3 = await svc.poll();
    expect(m3['t-exact-clear']?.sessionFile).toBe(clearedFile);
    svc.stop();
  });

  it('parses Codex rollout sessions, filters cwd case-insensitively, and rebinds on /clear', async () => {
    const codexDir = path.join(tempRoot, 'codex');
    const cwd = path.join(tempRoot, 'CodexProj');
    const otherCwd = path.join(tempRoot, 'OtherProj');
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.mkdir(otherCwd, { recursive: true });

    const dayDir = path.join(codexDir, 'sessions', todayLocalRelDir());
    await fsp.mkdir(dayDir, { recursive: true });

    const oldFile = path.join(dayDir, 'rollout-001.jsonl');
    await fsp.writeFile(
      oldFile,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 50 },
            last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 50 },
            model_context_window: 200_000,
          },
        },
      })}\n`,
      'utf8'
    );
    const oldStat = await fsp.stat(oldFile);

    const staleCheckSvc = new TokenUsageService(
      {
        getTokenTargets: () => [
          {
            terminalId: 'codex-stale-check',
            cwd,
            agentType: 'codex',
            command: 'codex',
            spawnedAt: oldStat.birthtimeMs + 10_000,
            claudeSessionId: null,
            running: true,
          },
        ],
      },
      { codexHomeDir: codexDir }
    );
    const staleMap = await staleCheckSvc.poll();
    expect(staleMap['codex-stale-check']).toBeUndefined();
    staleCheckSvc.stop();

    await sleep(30);
    const spawnedAt = Date.now();

    const otherFile = path.join(dayDir, 'rollout-other.jsonl');
    await fsp.writeFile(
      otherFile,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: otherCwd } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 99999,
                cached_input_tokens: 0,
                output_tokens: 999,
                reasoning_output_tokens: 0,
              },
              last_token_usage: { input_tokens: 99999, cached_input_tokens: 0, output_tokens: 999 },
              model_context_window: 128_000,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const cwdForTarget = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    const cwdInMeta = process.platform === 'win32' ? cwd.toUpperCase() : cwd;

    const activeFile = path.join(dayDir, 'rollout-002.jsonl');
    const tokenCountEvent = {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 12_000,
            cached_input_tokens: 8_000,
            output_tokens: 500,
            reasoning_output_tokens: 150,
          },
          last_token_usage: {
            input_tokens: 6_000,
            cached_input_tokens: 4_500,
            output_tokens: 300,
            reasoning_output_tokens: 100,
          },
          model_context_window: 258_400,
        },
      },
    };
    await fsp.writeFile(
      activeFile,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: cwdInMeta } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
        JSON.stringify(tokenCountEvent),
        JSON.stringify(tokenCountEvent),
      ].join('\n') + '\n',
      'utf8'
    );

    const svc = new TokenUsageService(
      {
        getTokenTargets: () => [
          {
            terminalId: 'codex-1',
            cwd: cwdForTarget,
            agentType: 'codex',
            command: 'codex --no-daemon',
            spawnedAt,
            claudeSessionId: null,
            running: true,
          },
        ],
      },
      { codexHomeDir: codexDir }
    );

    const m1 = await svc.poll();
    const u1 = m1['codex-1'];
    expect(u1).toBeDefined();
    expect(u1.provider).toBe('codex');
    expect(u1.model).toBe('gpt-5-codex');
    expect(u1.inputTokens).toBe(4_000);
    expect(u1.cacheReadTokens).toBe(8_000);
    expect(u1.cacheWriteTokens).toBe(0);
    expect(u1.outputTokens).toBe(500);
    expect(u1.totalTokens).toBe(12_500);
    expect(u1.contextTokens).toBe(6_300);
    expect(u1.contextWindow).toBe(258_400);
    expect(u1.turns).toBe(1);
    expect(u1.sessionFile).toBe(activeFile);

    await sleep(35);
    const clearedFile = path.join(dayDir, 'rollout-003.jsonl');
    await fsp.writeFile(
      clearedFile,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: cwdInMeta } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 900,
                cached_input_tokens: 200,
                output_tokens: 100,
                reasoning_output_tokens: 0,
              },
              last_token_usage: { input_tokens: 900, cached_input_tokens: 200, output_tokens: 100 },
              model_context_window: 258_400,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const m2 = await svc.poll();
    const u2 = m2['codex-1'];
    expect(u2.sessionFile).toBe(clearedFile);
    expect(u2.inputTokens).toBe(700);
    expect(u2.cacheReadTokens).toBe(200);
    expect(u2.outputTokens).toBe(100);
    expect(u2.totalTokens).toBe(1_000);

    svc.stop();
  });

  it('parses Gemini JSONL, legacy JSON, projects.json, and sha256 project dirs', async () => {
    const geminiDir = path.join(tempRoot, 'gemini');
    const cwdNamed = path.join(tempRoot, 'GeminiNamed');
    const cwdHashed = path.join(tempRoot, 'GeminiHashed');
    await fsp.mkdir(cwdNamed, { recursive: true });
    await fsp.mkdir(cwdHashed, { recursive: true });

    await fsp.mkdir(geminiDir, { recursive: true });
    await fsp.writeFile(
      path.join(geminiDir, 'projects.json'),
      JSON.stringify({
        projects: {
          [cwdNamed.toLowerCase()]: 'my-named-project',
        },
      }),
      'utf8'
    );

    const namedChats = path.join(geminiDir, 'tmp', 'my-named-project', 'chats');
    await fsp.mkdir(namedChats, { recursive: true });
    const jsonlFile = path.join(namedChats, 'session-2026-11-17.jsonl');
    await fsp.writeFile(
      jsonlFile,
      [
        JSON.stringify({ id: 'u1', type: 'user', content: 'hello' }),
        JSON.stringify({
          id: 'g1',
          type: 'gemini',
          model: 'gemini-2.5-pro',
          tokens: { input: 5000, output: 300, cached: 3000, thoughts: 100, tool: 50, total: 5450 },
        }),
        JSON.stringify({
          id: 'g1',
          type: 'gemini',
          model: 'gemini-2.5-pro',
          tokens: { input: 5000, output: 400, cached: 3000, thoughts: 150, tool: 50, total: 5600 },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const sha = createHash('sha256').update(cwdHashed).digest('hex');
    const hashedChats = path.join(geminiDir, 'tmp', sha, 'chats');
    await fsp.mkdir(hashedChats, { recursive: true });
    const legacyFile = path.join(hashedChats, 'session-legacy.json');
    await fsp.writeFile(
      legacyFile,
      JSON.stringify({
        sessionId: 'legacy-1',
        messages: [
          {
            id: 'm1',
            model: 'gemini-2.5-flash',
            tokens: { input: 1000, output: 200, cached: 600, thoughts: 50, tool: 0, total: 1250 },
          },
          {
            id: 'm2',
            model: 'gemini-2.5-flash',
            tokens: { input: 2000, output: 300, cached: 1200, thoughts: 0, tool: 0, total: 2300 },
          },
        ],
      }),
      'utf8'
    );

    const svc = new TokenUsageService(
      {
        getTokenTargets: () => [
          {
            terminalId: 'gem-named',
            cwd: cwdNamed,
            agentType: 'gemini',
            command: 'gemini',
            spawnedAt: Date.now() - 1000,
            claudeSessionId: null,
            running: true,
          },
          {
            terminalId: 'gem-hashed',
            cwd: cwdHashed,
            agentType: 'gemini',
            command: 'gemini',
            spawnedAt: Date.now() - 1000,
            claudeSessionId: null,
            running: true,
          },
        ],
      },
      { geminiHomeDir: geminiDir }
    );

    const map = await svc.poll();
    const uNamed = map['gem-named'];
    expect(uNamed).toBeDefined();
    expect(uNamed.provider).toBe('gemini');
    expect(uNamed.model).toBe('gemini-2.5-pro');
    expect(uNamed.inputTokens).toBe(2050);
    expect(uNamed.outputTokens).toBe(550);
    expect(uNamed.cacheReadTokens).toBe(3000);
    expect(uNamed.totalTokens).toBe(5600);
    expect(uNamed.contextTokens).toBe(5600);
    expect(uNamed.contextWindow).toBe(1_048_576);
    expect(uNamed.turns).toBe(1);

    const uHashed = map['gem-hashed'];
    expect(uHashed).toBeDefined();
    expect(uHashed.model).toBe('gemini-2.5-flash');
    expect(uHashed.turns).toBe(2);
    expect(uHashed.inputTokens).toBe(1200);
    expect(uHashed.cacheReadTokens).toBe(1800);
    expect(uHashed.outputTokens).toBe(550);
    expect(uHashed.totalTokens).toBe(3550);
    expect(uHashed.contextTokens).toBe(2300);
    expect(uHashed.contextWindow).toBe(1_048_576);

    svc.stop();
  });

  it('prevents two heuristic terminals in the same cwd from stealing bound session files', async () => {
    const claudeDir = path.join(tempRoot, 'claude-multi');
    const cwd = path.join(tempRoot, 'SharedRepo');
    await fsp.mkdir(cwd, { recursive: true });
    const projectDir = path.join(claudeDir, 'projects', claudeProjectSlug(cwd));
    await fsp.mkdir(projectDir, { recursive: true });

    const fileA = path.join(projectDir, 'aaa.jsonl');
    await fsp.writeFile(
      fileA,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm_a',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 111, output_tokens: 10 },
        },
      })}\n`,
      'utf8'
    );
    const spawn1 = Date.now() - 500;

    let targets: TokenTrackingTarget[] = [
      {
        terminalId: 't1',
        cwd,
        agentType: 'claude',
        command: 'claude -c',
        spawnedAt: spawn1,
        claudeSessionId: null,
        running: true,
      },
    ];

    const svc = new TokenUsageService(
      { getTokenTargets: () => targets },
      { claudeConfigDir: claudeDir }
    );

    const m1 = await svc.poll();
    expect(m1['t1']?.sessionFile).toBe(fileA);

    await sleep(30);
    const spawn2 = Date.now();
    const fileB = path.join(projectDir, 'bbb.jsonl');
    await fsp.writeFile(
      fileB,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm_b',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 222, output_tokens: 20 },
        },
      })}\n`,
      'utf8'
    );

    targets = [
      ...targets,
      {
        terminalId: 't2',
        cwd,
        agentType: 'claude',
        command: 'claude -c',
        spawnedAt: spawn2,
        claudeSessionId: null,
        running: true,
      },
    ];

    const m2 = await svc.poll();
    expect(m2['t1']?.sessionFile).toBe(fileA);
    expect(m2['t2']?.sessionFile).toBe(fileB);
    svc.stop();
  });

  it('logs poll errors via console.warn once per distinct error message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let errMsg = 'boom-1';
      const svc = new TokenUsageService({
        getTokenTargets: () => {
          throw new Error(errMsg);
        },
      });
      await svc.poll();
      await svc.poll();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      errMsg = 'boom-2';
      await svc.poll();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      svc.stop();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
