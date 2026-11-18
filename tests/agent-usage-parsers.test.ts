import { describe, expect, it } from 'vitest';
import {
  parseAntigravityUsage,
  parseClaudeUsage,
  parseCodexUsage,
  resolveUsageProvider,
} from '../src/main/agent-usage-parsers';

describe('resolveUsageProvider', () => {
  it('resolves direct agentType values and agy alias', () => {
    expect(resolveUsageProvider('claude')).toBe('claude');
    expect(resolveUsageProvider('codex')).toBe('codex');
    expect(resolveUsageProvider('antigravity')).toBe('antigravity');
    expect(resolveUsageProvider('agy')).toBe('antigravity');
  });

  it('infers provider from command first token for shell/custom terminals', () => {
    expect(resolveUsageProvider('shell', 'claude --model sonnet')).toBe('claude');
    expect(resolveUsageProvider('custom', '"C:\\Program Files\\Codex\\codex.exe" --no-daemon')).toBe('codex');
    expect(resolveUsageProvider('shell', 'C:\\Users\\magdi\\AppData\\Local\\agy\\bin\\agy.exe')).toBe(
      'antigravity'
    );
    expect(resolveUsageProvider('shell', '/usr/local/bin/antigravity -p /usage')).toBe('antigravity');
    expect(resolveUsageProvider('custom', "'/home/dev/.local/bin/claude.cmd' --verbose")).toBe('claude');
  });

  it('returns null for unsupported agents, empty commands, or non-leading mentions', () => {
    expect(resolveUsageProvider('gemini', 'gemini')).toBeNull();
    expect(resolveUsageProvider('opencode', 'opencode')).toBeNull();
    expect(resolveUsageProvider('cursor', 'cursor')).toBeNull();
    expect(resolveUsageProvider('shell', 'pwsh.exe')).toBeNull();
    expect(resolveUsageProvider('shell', 'echo claude codex agy')).toBeNull();
    expect(resolveUsageProvider('shell', '')).toBeNull();
    expect(resolveUsageProvider('shell', null)).toBeNull();
    expect(resolveUsageProvider(null, undefined)).toBeNull();
  });
});

describe('parseClaudeUsage', () => {
  it('parses full control_response envelope with five_hour and seven_day limits', () => {
    const raw = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orkestrei-usage',
        response: {
          rate_limits_available: true,
          subscription_type: 'pro',
          rate_limits: {
            five_hour: {
              utilization: 69,
              resets_at: '2026-11-17T16:19:59Z',
            },
            seven_day: {
              utilization: 85,
              resets_at: '2026-11-19T12:59:59Z',
            },
          },
        },
      },
    };

    const parsed = parseClaudeUsage(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.plan).toBe('pro');
    expect(parsed.limitReached).toBe(false);
    expect(parsed.meters).toEqual([
      {
        id: 'plan',
        label: 'Limites do plano',
        windows: [
          {
            id: 'five_hour',
            title: 'Sessão',
            ring: 'session',
            usedPercent: 69,
            resetsAt: '2026-11-17T16:19:59Z',
            durationSeconds: 18_000,
          },
          {
            id: 'seven_day',
            title: 'Semanal',
            ring: 'weekly',
            usedPercent: 85,
            resetsAt: '2026-11-19T12:59:59Z',
            durationSeconds: 604_800,
          },
        ],
      },
    ]);
  });

  it('parses NDJSON stream-json output and maps model_scoped rings (first -> special, rest -> null)', () => {
    const ndjson = [
      '{"type":"system","subtype":"init","session_id":"abc"}',
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'maestri-usage',
          response: {
            subscription_type: 'max',
            rate_limits: {
              five_hour: { utilization: 12, resets_at: '2026-11-17T23:00:00Z' },
              seven_day: { utilization: 34, resets_at: '2026-11-24T00:00:00Z' },
              model_scoped: [
                { display_name: 'Sonnet 4.5', utilization: 41.5, resets_at: '2026-11-24T00:00:00Z' },
                { display_name: 'Opus 4.6', utilization: 10, resets_at: '2026-11-24T00:00:00Z' },
              ],
            },
          },
        },
      }),
      '{"type":"result","subtype":"success"}',
    ].join('\n');

    const parsed = parseClaudeUsage(ndjson);
    expect(parsed.error).toBeUndefined();
    expect(parsed.plan).toBe('max');
    expect(parsed.limitReached).toBe(false);
    expect(parsed.meters).toHaveLength(3);
    expect(parsed.meters[1]).toEqual({
      id: 'Sonnet 4.5',
      label: 'Sonnet 4.5',
      windows: [
        {
          id: 'limit',
          title: 'Semanal',
          ring: 'special',
          usedPercent: 41.5,
          resetsAt: '2026-11-24T00:00:00Z',
          durationSeconds: 604_800,
        },
      ],
    });
    expect(parsed.meters[2].windows[0].ring).toBeNull();
  });

  it('keeps model_scoped on special ring even when plan windows are absent', () => {
    const parsed = parseClaudeUsage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orkestrei-usage',
        response: {
          rate_limits: {
            model_scoped: [{ display_name: 'Sonnet', utilization: 25 }],
          },
        },
      },
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.meters[0].windows[0].ring).toBe('special');
    expect(parsed.meters[0].windows[0].resetsAt).toBeNull();
  });

  it('sets limitReached only for >=100% windows or rejected status', () => {
    const overage = parseClaudeUsage({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          rate_limits: {
            five_hour: { utilization: 105, resets_at: '2026-11-17T23:00:00Z' },
          },
        },
      },
    });
    expect(overage.limitReached).toBe(true);
    expect(overage.meters[0].windows[0].usedPercent).toBe(105);

    const rejected = parseClaudeUsage({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          rate_limits: {
            five_hour: { status: 'rejected', utilization: 95, resets_at: '2026-11-17T23:00:00Z' },
          },
        },
      },
    });
    expect(rejected.limitReached).toBe(true);

    const partialAvailableFlag = parseClaudeUsage({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          rate_limits_available: false,
          subscription_type: 'pro',
          rate_limits: {
            five_hour: { utilization: 50, resets_at: '2026-11-17T23:00:00Z' },
          },
        },
      },
    });
    expect(partialAvailableFlag.error).toBeUndefined();
    expect(partialAvailableFlag.limitReached).toBe(false);
    expect(partialAvailableFlag.meters).toHaveLength(1);
  });

  it('returns Plan limits unavailable when rate_limits_available is false and rate_limits is null or missing', () => {
    for (const rateLimitsValue of [null, undefined]) {
      const res = parseClaudeUsage({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'orkestrei-usage',
          response: {
            subscription_type: null,
            rate_limits_available: false,
            ...(rateLimitsValue !== undefined ? { rate_limits: rateLimitsValue } : {}),
          },
        },
      });
      expect(res).toEqual({
        plan: null,
        limitReached: false,
        meters: [],
        error: 'Plan limits unavailable',
      });
    }
  });

  it('parses real anonymized live Claude get_usage payload including extra_usage and breakdown fields', () => {
    const liveClaudeRaw = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orkestrei-usage',
        response: {
          session: null,
          subscription_type: 'pro',
          rate_limits_available: true,
          rate_limits: {
            five_hour: {
              utilization: 17,
              resets_at: '2026-11-18T02:19:59.781708+00:00',
              limit_dollars: null,
              used_dollars: null,
              remaining_dollars: null,
              locked_reason: null,
            },
            seven_day: {
              utilization: 89,
              resets_at: '2026-11-19T12:59:59.781731+00:00',
              limit_dollars: null,
              used_dollars: null,
              remaining_dollars: null,
              locked_reason: null,
            },
            extra_usage: {
              is_enabled: false,
              monthly_limit: 4000,
              used_credits: 3292,
              utilization: 82.3,
              currency: 'BRL',
              disabled_reason: 'out_of_credits',
              spend_limit_reached: false,
            },
            limits: [
              {
                kind: 'session',
                group: 'session',
                percent: 17,
                resets_at: '2026-11-18T02:19:59.781708+00:00',
                severity: 'normal',
                is_active: false,
                scope: null,
              },
              {
                kind: 'weekly_all',
                group: 'weekly',
                percent: 89,
                resets_at: '2026-11-19T12:59:59.781731+00:00',
                severity: 'warning',
                is_active: true,
                scope: null,
              },
            ],
            spend: {
              percent: 82,
              severity: 'warning',
              enabled: false,
              disabled_reason: 'out_of_credits',
            },
            seven_day_breakdown: {
              as_of: '2026-11-18T01:16:45.834732+00:00',
              window_started_at: '2026-11-12T12:59:59.781731+00:00',
              rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 88 }],
            },
            model_scoped: [],
          },
          behaviors: null,
        },
      },
    };

    const parsed = parseClaudeUsage(liveClaudeRaw);
    expect(parsed).toEqual({
      plan: 'pro',
      limitReached: false,
      meters: [
        {
          id: 'plan',
          label: 'Limites do plano',
          windows: [
            {
              id: 'five_hour',
              title: 'Sessão',
              ring: 'session',
              usedPercent: 17,
              resetsAt: '2026-11-18T02:19:59.781708+00:00',
              durationSeconds: 18_000,
            },
            {
              id: 'seven_day',
              title: 'Semanal',
              ring: 'weekly',
              usedPercent: 89,
              resetsAt: '2026-11-19T12:59:59.781731+00:00',
              durationSeconds: 604_800,
            },
          ],
        },
      ],
    });
  });

  it('tolerates missing optional fields inside valid response without throwing', () => {
    const parsed = parseClaudeUsage({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          rate_limits: {
            five_hour: {},
            seven_day: null,
          },
        },
      },
    });
    expect(parsed).toEqual({
      plan: null,
      limitReached: false,
      meters: [],
    });
  });

  it('returns error result without throwing on error envelopes and invalid payloads', () => {
    const errEnvelope = parseClaudeUsage({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'orkestrei-usage',
        error: 'Not signed in',
      },
    });
    expect(errEnvelope).toEqual({
      plan: null,
      limitReached: false,
      meters: [],
      error: 'Not signed in',
    });

    for (const bad of [
      null,
      undefined,
      '',
      'not json',
      123,
      {},
      { type: 'system', subtype: 'init' },
      { type: 'control_response', response: { subtype: 'success' } },
    ]) {
      const res = parseClaudeUsage(bad);
      expect(res.plan).toBeNull();
      expect(res.limitReached).toBe(false);
      expect(res.meters).toEqual([]);
      expect(typeof res.error).toBe('string');
      expect(res.error!.length).toBeGreaterThan(0);
    }
  });

  it('parses Claude NDJSON preceded by SessionStart hook events', () => {
    const ndjson = [
      JSON.stringify({
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'SessionStart:startup',
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'SessionStart:startup',
        output: 'hook banner',
      }),
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'orkestrei-usage',
          response: {
            subscription_type: 'pro',
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 21, resets_at: '2026-11-18T02:19:59.700351+00:00' },
              seven_day: { utilization: 90, resets_at: '2026-11-19T12:59:59.700372+00:00' },
            },
          },
        },
      }),
    ].join('\n');

    const parsed = parseClaudeUsage(ndjson);
    expect(parsed.error).toBeUndefined();
    expect(parsed.plan).toBe('pro');
    expect(parsed.meters[0].windows.map((w) => w.usedPercent)).toEqual([21, 90]);
  });
});

describe('parseCodexUsage', () => {
  it('parses JSON-RPC rateLimits + rateLimitsByLimitId, dedupes primary id, and maps plan names', () => {
    const raw = [
      JSON.stringify({ id: 1, result: { userAgent: 'codex-cli' } }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          ordinaryUsageAllowed: true,
          rateLimits: {
            limitId: 'codex',
            limitName: 'Codex',
            planType: 'prolite',
            rateLimitReachedType: null,
            primary: {
              usedPercent: 22,
              resetsAt: 1794960000,
              windowDurationMins: 300,
            },
            secondary: {
              usedPercent: 48,
              resetsAt: '1795478400',
              windowDurationMins: 10080,
            },
          },
          rateLimitsByLimitId: {
            codex: {
              limitName: 'Duplicate Codex',
              primary: { usedPercent: 99, resetsAt: 1794960000, windowDurationMins: 300 },
            },
            codex_bengalfox: {
              limitName: 'GPT-5.3-Codex-Spark',
              primary: { usedPercent: 15, resetsAt: 1794960000, windowDurationMins: 300 },
              secondary: { usedPercent: 60, resetsAt: 1795478400, windowDurationMins: 10080 },
            },
          },
        },
      }),
    ].join('\n');

    const parsed = parseCodexUsage(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.plan).toBe('Pro Lite');
    expect(parsed.limitReached).toBe(false);
    expect(parsed.meters).toHaveLength(2);
    expect(parsed.meters[0]).toEqual({
      id: 'codex',
      label: 'Codex',
      windows: [
        {
          id: 'primary',
          title: 'Sessão',
          ring: 'session',
          usedPercent: 22,
          resetsAt: new Date(1794960000 * 1000).toISOString(),
          durationSeconds: 18_000,
        },
        {
          id: 'secondary',
          title: 'Semanal',
          ring: 'weekly',
          usedPercent: 48,
          resetsAt: new Date(1795478400 * 1000).toISOString(),
          durationSeconds: 604_800,
        },
      ],
    });
    expect(parsed.meters[1]).toEqual({
      id: 'codex_bengalfox',
      label: 'GPT-5.3-Codex-Spark',
      windows: [
        {
          id: 'primary',
          title: 'Sessão',
          ring: null,
          usedPercent: 15,
          resetsAt: new Date(1794960000 * 1000).toISOString(),
          durationSeconds: 18_000,
        },
        {
          id: 'secondary',
          title: 'Semanal',
          ring: 'special',
          usedPercent: 60,
          resetsAt: new Date(1795478400 * 1000).toISOString(),
          durationSeconds: 604_800,
        },
      ],
    });
  });

  it('sets limitReached when ordinaryUsageAllowed is false, rateLimitReachedType is non-null, or window >= 100%', () => {
    const blocked = parseCodexUsage({
      id: 2,
      result: {
        ordinaryUsageAllowed: false,
        rateLimits: {
          limitId: 'codex',
          planType: 'ent26',
          primary: { usedPercent: 80, resetsAt: 1794960000, windowDurationMins: 300 },
        },
      },
    });
    expect(blocked.plan).toBe('Enterprise');
    expect(blocked.limitReached).toBe(true);

    const byReason = parseCodexUsage({
      id: 2,
      result: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          limitId: 'codex',
          planType: 'plus',
          rateLimitReachedType: 'secondary',
          secondary: { usedPercent: 100, resetsAt: 1795478400, windowDurationMins: 10080 },
        },
      },
    });
    expect(byReason.plan).toBe('plus');
    expect(byReason.limitReached).toBe(true);
  });

  it('handles JSON-RPC error envelopes and malformed inputs without throwing', () => {
    expect(
      parseCodexUsage({
        id: 2,
        error: { code: -32601, message: 'Method not found' },
      })
    ).toEqual({
      plan: null,
      limitReached: false,
      meters: [],
      error: 'Update the CLI to see usage',
    });

    expect(
      parseCodexUsage({
        id: 2,
        error: { code: 'notSignedIn', message: 'Login required' },
      })
    ).toEqual({
      plan: null,
      limitReached: false,
      meters: [],
      error: 'Not signed in',
    });

    for (const bad of [
      null,
      undefined,
      '',
      '{bad json',
      {},
      { id: 1, result: { userAgent: 'codex' } },
    ]) {
      const res = parseCodexUsage(bad);
      expect(res.plan).toBeNull();
      expect(res.limitReached).toBe(false);
      expect(res.meters).toEqual([]);
      expect(typeof res.error).toBe('string');
      expect(res.error!.length).toBeGreaterThan(0);
    }
  });
});

describe('parseAntigravityUsage', () => {
  it('parses full agy /usage JSON matching real .status.json ring assignment and percentages', () => {
    const raw = {
      status: 'SUCCESS',
      command: {
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  remaining_fraction: 1,
                  reset_time: '2026-11-24T13:01:21Z',
                  window: 'weekly',
                },
                {
                  id: 'gemini-5h',
                  remaining_fraction: 1,
                  reset_time: '2026-11-17T18:01:21Z',
                  window: '5h',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                {
                  id: '3p-weekly',
                  remaining_fraction: 1,
                  reset_time: '2026-11-24T13:01:21Z',
                  window: 'USAGE_PERIOD_TYPE_WEEKLY',
                },
                {
                  id: '3p-5h',
                  remaining_fraction: 1,
                  reset_time: '2026-11-17T18:01:21Z',
                  window: 'five_hour',
                },
              ],
            },
            {
              name: 'Gemini 4 Argon',
              buckets: [
                {
                  id: 'gemini-argon-wtu-weekly',
                  remaining_fraction: 0.8203657269477844,
                  reset_time: '2026-11-24T12:31:16Z',
                  window: '7d',
                },
              ],
            },
          ],
        },
      },
    };

    const parsed = parseAntigravityUsage(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.plan).toBeNull();
    expect(parsed.limitReached).toBe(false);
    expect(parsed.meters).toEqual([
      {
        id: 'Gemini Models',
        label: 'Gemini Models',
        windows: [
          {
            id: 'gemini-weekly',
            title: 'Semanal',
            ring: 'weekly',
            usedPercent: 0,
            resetsAt: '2026-11-24T13:01:21Z',
            durationSeconds: 604_800,
          },
          {
            id: 'gemini-5h',
            title: 'Sessão',
            ring: 'session',
            usedPercent: 0,
            resetsAt: '2026-11-17T18:01:21Z',
            durationSeconds: 18_000,
          },
        ],
      },
      {
        id: 'Claude and GPT models',
        label: 'Claude and GPT models',
        windows: [
          {
            id: '3p-weekly',
            title: 'Semanal',
            ring: 'special',
            usedPercent: 0,
            resetsAt: '2026-11-24T13:01:21Z',
            durationSeconds: 604_800,
          },
          {
            id: '3p-5h',
            title: 'Sessão',
            ring: null,
            usedPercent: 0,
            resetsAt: '2026-11-17T18:01:21Z',
            durationSeconds: 18_000,
          },
        ],
      },
      {
        id: 'Gemini 4 Argon',
        label: 'Gemini 4 Argon',
        windows: [
          {
            id: 'gemini-argon-wtu-weekly',
            title: 'Semanal',
            ring: null,
            usedPercent: 17.963427305221558,
            resetsAt: '2026-11-24T12:31:16Z',
            durationSeconds: 604_800,
          },
        ],
      },
    ]);
  });

  it('parses string JSON preceded by CLI log lines, protobuf omitted zero, and monthly windows', () => {
    const rawText = [
      'I1117 21:56:46.395128 server.go:2581] Starting language server',
      JSON.stringify(
        {
          status: 'SUCCESS',
          command: {
            data: {
              groups: [
                {
                  name: 'Monthly Pool',
                  buckets: [
                    {
                      id: 'm1',
                      remaining_fraction: 0,
                      reset_time: '2026-12-01T00:00:00Z',
                      window: 'USAGE_PERIOD_TYPE_MONTHLY',
                    },
                    {
                      id: 'm2',
                      reset_time: '2026-11-18T00:00:00Z',
                      window: 'daily',
                    },
                    {
                      id: 'empty-bucket',
                      window: '5h',
                    },
                  ],
                },
              ],
            },
          },
        },
        null,
        2
      ),
    ].join('\n');

    const parsed = parseAntigravityUsage(rawText);
    expect(parsed.error).toBeUndefined();
    expect(parsed.limitReached).toBe(true);
    expect(parsed.meters).toEqual([
      {
        id: 'Monthly Pool',
        label: 'Monthly Pool',
        windows: [
          {
            id: 'm1',
            title: 'Mensal',
            ring: 'weekly',
            usedPercent: 100,
            resetsAt: '2026-12-01T00:00:00Z',
            durationSeconds: 2_592_000,
          },
          {
            id: 'm2',
            title: 'Diário',
            ring: 'session',
            usedPercent: null,
            resetsAt: '2026-11-18T00:00:00Z',
            durationSeconds: 86_400,
          },
        ],
      },
    ]);
  });

  it('handles empty groups on SUCCESS and rejects non-SUCCESS status or missing structure', () => {
    expect(
      parseAntigravityUsage({
        status: 'SUCCESS',
        command: { data: { groups: [] } },
      })
    ).toEqual({
      plan: null,
      limitReached: false,
      meters: [],
    });

    expect(
      parseAntigravityUsage({
        status: 'ERROR',
        error: 'Not authenticated',
      })
    ).toEqual({
      plan: null,
      limitReached: false,
      meters: [],
      error: 'Not authenticated',
    });

    for (const bad of [
      null,
      undefined,
      '',
      'not json',
      {},
      { status: 'FAILED', command: { data: { groups: [] } } },
      { status: 'SUCCESS', command: {} },
    ]) {
      const res = parseAntigravityUsage(bad);
      expect(res.plan).toBeNull();
      expect(res.limitReached).toBe(false);
      expect(res.meters).toEqual([]);
      expect(typeof res.error).toBe('string');
      expect(res.error!.length).toBeGreaterThan(0);
    }
  });

  it('parses real anonymized live agy /usage payload across all three groups', () => {
    const liveAgyRaw = {
      conversation_id: '',
      status: 'SUCCESS',
      response: 'Gemini Models\tWeekly Limit Remaining\t91%\t2026-11-25T00:51:30Z\n',
      duration_seconds: 0,
      num_turns: 0,
      usage: {
        input_tokens: null,
        output_tokens: null,
        thinking_tokens: null,
        cache_read_tokens: null,
        total_tokens: null,
      },
      command: {
        name: 'usage',
        data: {
          description: 'Within each group, models share a weekly limit and a 5-hour limit.',
          groups: [
            {
              name: 'Gemini Models',
              description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.9094488620758057,
                  reset_time: '2026-11-25T00:51:30Z',
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.724284291267395,
                  reset_time: '2026-11-18T05:51:30Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
              buckets: [
                {
                  id: '3p-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 1,
                  reset_time: '2026-11-25T01:16:53Z',
                },
                {
                  id: '3p-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 1,
                  reset_time: '2026-11-18T06:16:53Z',
                },
              ],
            },
            {
              name: 'Gemini 4 Argon',
              buckets: [
                {
                  id: 'gemini-argon-wtu-weekly',
                  name: 'Gemini 4 Argon Weekly Limit',
                  window: 'weekly',
                  remaining_fraction: 1,
                  reset_time: '2026-11-25T01:16:53Z',
                },
              ],
            },
          ],
        },
      },
    };

    const parsed = parseAntigravityUsage(liveAgyRaw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.plan).toBeNull();
    expect(parsed.limitReached).toBe(false);
    expect(parsed.meters).toHaveLength(3);
    expect(parsed.meters[0].windows[0]).toMatchObject({
      id: 'gemini-weekly',
      title: 'Semanal',
      ring: 'weekly',
      resetsAt: '2026-11-25T00:51:30Z',
      durationSeconds: 604_800,
    });
    expect(parsed.meters[0].windows[0].usedPercent).toBeCloseTo(9.055113792419434, 10);
    expect(parsed.meters[0].windows[1]).toMatchObject({
      id: 'gemini-5h',
      title: 'Sessão',
      ring: 'session',
      resetsAt: '2026-11-18T05:51:30Z',
      durationSeconds: 18_000,
    });
    expect(parsed.meters[0].windows[1].usedPercent).toBeCloseTo(27.5715708732605, 10);
    expect(parsed.meters[1].windows[0].ring).toBe('special');
    expect(parsed.meters[1].windows[1].ring).toBeNull();
    expect(parsed.meters[2].windows[0]).toEqual({
      id: 'gemini-argon-wtu-weekly',
      title: 'Semanal',
      ring: null,
      usedPercent: 0,
      resetsAt: '2026-11-25T01:16:53Z',
      durationSeconds: 604_800,
    });
  });
});
