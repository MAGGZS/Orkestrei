#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const pipeUrl = process.env.MAESTRI_PIPE || process.env.ORKESTREI_PIPE || '';
const terminalId = process.env.MAESTRI_TERMINAL_ID || '';
const authToken = process.env.MAESTRI_TOKEN || '';

const BOOLEAN_FLAGS = new Set([
  'raw',
  'no-git',
  'delete-branch',
  'without-me',
  'existing-branch',
  'copy-ground',
  'keep-floor',
  'keep-folder',
  'reminder',
  'clear',
  'json',
  'none',
  'no-skip-if-busy',
  'no-notify',
  'disabled',
]);

function fail(msg, code = 1) {
  process.stderr.write(`maestri: error: ${msg}\n`);
  process.exit(code);
}

function parseFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        const key = a.slice(2, eqIdx);
        flags[key] = a.slice(eqIdx + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function request(method, pathname, body) {
  if (!pipeUrl) {
    fail('only available inside Orkestrei/Maestri terminals (MAESTRI_PIPE not set).');
  }
  if (!terminalId) {
    fail('MAESTRI_TERMINAL_ID is not set.');
  }
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, pipeUrl);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {
      'X-Terminal-ID': terminalId,
      ...(authToken ? { Authorization: `Bearer ${authToken}`, 'X-Maestri-Token': authToken } : {}),
      ...(data !== null
        ? {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(data),
          }
        : {}),
    };
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 500, body: text, contentType: res.headers['content-type'] || '' });
        });
      }
    );
    req.on('error', (err) => reject(err));
    if (data !== null) req.write(data);
    req.end();
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function printHelp() {
  process.stdout.write(`Orkestrei / Maestri Local Orchestration CLI

Usage:
  maestri list [--json]
  maestri ask "Agent" "prompt" [--raw] [--timeout 120]
  maestri ask --batch '{"Agent A": "prompt", "Agent B": "prompt"}'
  maestri check "Agent"
  maestri notify "message"

Team & Canvas:
  maestri recruit "Name" [--preset P] [--role R] [--floor F] [--workspace W] [--dir D] [--command C] [--icon I] [--color C] [--band B] [--replace Old]
  maestri dismiss "Name"
  maestri connect "From" "To"
  maestri arrange "Name" [--name N] [--icon I] [--color C]
  maestri band create "Band" ["Agent" ...] [--without-me] [--icon I] [--color C]
  maestri band add|remove|dissolve "Band" ["Agent"]

Roles, Presets & Partituras:
  maestri role list | show "Name" | create "Name" "Prompt" [--scope current|global] | write "Name" "Prompt" | edit "Name" "old" "new" [--scope current|global] | assign "Agent" "Role"
  maestri preset list | show "Name" | create "Name" --command "..." | set "Name" ... | delete "Name"
  maestri partitura list | insert "Name" | create "Name" | delete "Name"

Notes & Fichários:
  maestri note create ["content"] [--name "Name"] [--stack ["Fichário"]] [--color C]
  maestri note read "Name" [offset limit]
  maestri note write "Name" "content"
  maestri note edit "Name" "old" "new"
  maestri note stack "Name" ["Fichário"] | unstack "Name" | delete "Name"

Floors & Workspaces:
  maestri floor list | create "Name" [--branch B] [--existing-branch] [--no-git] [--copy-ground] | status ["Text"] [--state working|blocked|review|done] [--progress 2/5] [--floor F] [--clear] | land "Name" [--into B] [--delete-branch] [--keep-floor] | delete "Name"
  maestri workspace list | create "Name" --dir PATH [--from W] [--group G] [--folder F] | rename "Old" "New"

Portals, Routines & Chat:
  maestri portal create URL ["Name"] [--size WxH]
  maestri portal edit "Portal" --url URL | close "Portal"
  maestri portal snapshot|click|fill|type|key|scroll|scrollintoview|navigate|back|forward|reload|info|screenshot|text|html|evaluate|logs-start|logs|resize|ua "Portal" ...
  maestri routine list | show "Name" | create "Name" --command "..." (--every 30m | --daily 09:00 | --weekly mon@09:00 | --once "YYYY-MM-DD HH:mm") [--terminal T | --reminder] [--pre-run "..."] | enable|disable|run|delete "Name"
  maestri say ['text' | --file path | --progress 'text']
  maestri recall [thread] [--turns N]
  maestri debug
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'debug') {
    process.stdout.write(`MAESTRI_PIPE=${pipeUrl || '(unset)'}\n`);
    process.stdout.write(`MAESTRI_TERMINAL_ID=${terminalId || '(unset)'}\n`);
    process.stdout.write(`MAESTRI_TOKEN=${authToken ? '(set)' : '(unset)'}\n`);
    process.stdout.write(`MAESTRI_WORKSPACE_ID=${process.env.MAESTRI_WORKSPACE_ID || '(unset)'}\n`);
    process.stdout.write(`MAESTRI_CLI=${process.env.MAESTRI_CLI || '(unset)'}\n`);
    if (pipeUrl && terminalId) {
      const r = await request('GET', '/health');
      process.stdout.write(`Health: ${r.status} ${r.body}\n`);
    }
    return;
  }

  const rest = argv.slice(1);
  const { positionals, flags } = parseFlags(rest);

  if (cmd === 'list') {
    const r = await request('GET', '/list');
    if (r.status >= 400) fail(r.body);
    if (flags.json) {
      process.stdout.write(r.body + '\n');
      return;
    }
    const data = JSON.parse(r.body);
    const out = [];
    out.push(`You: ${data.self.name} (workspace: ${data.self.workspaceName}${data.self.floorName ? ` / floor: ${data.self.floorName}` : ' / Ground'}${data.self.isManager ? ', Maestro' : ''})`);
    out.push('');
    out.push('Connected Agents:');
    if (data.terminals.length === 0) {
      out.push('  (none)');
    } else {
      for (const t of data.terminals) {
        out.push(`  - ${t.name} [${t.running ? 'running' : 'stopped'}]${t.role ? ` — role: ${t.role}` : ''}${t.floorName ? ` (floor: ${t.floorName})` : ''}`);
        if (t.team) {
          if (t.team.notes?.length) {
            out.push(`      notes: ${t.team.notes.map((n) => n.name).join(', ')}`);
          }
          if (t.team.portals?.length) {
            out.push(`      portals: ${t.team.portals.map((p) => p.name).join(', ')}`);
          }
          if (t.team.peers?.length) {
            out.push(`      peers: ${t.team.peers.join(', ')}`);
          }
        }
      }
    }
    if (data.farPeers?.length) {
      out.push('');
      out.push('Far Agents (Cross-Workspace):');
      for (const fp of data.farPeers) {
        out.push(`  - ${fp.farAddress || `${fp.name} @ ${fp.workspaceName}`} [${fp.running ? 'running' : 'stopped'}]${fp.role ? ` — role: ${fp.role}` : ''}`);
      }
    }
    if (data.bands?.length) {
      out.push('');
      out.push('Bands:');
      for (const b of data.bands) {
        out.push(`  - ${b.name}${b.withCaller ? ' (you are in this band)' : ''} [${b.memberIds.length} members]`);
      }
    }
    out.push('');
    out.push('Connected Notes:');
    if (data.notes.length === 0) {
      out.push('  (none)');
    } else {
      for (const n of data.notes) {
        out.push(`  - ${n.name}${n.locked ? ' (locked: true)' : ''}${n.fichario ? ` [fichário: ${n.fichario}]` : ''}${n.depth > 0 ? ` (chained depth ${n.depth})` : ''}`);
      }
    }
    if (data.portals.length > 0) {
      out.push('');
      out.push('Connected Portals:');
      for (const p of data.portals) {
        out.push(`  - ${p.name} (${p.summary})`);
      }
    }
    process.stdout.write(out.join('\n') + '\n');
    return;
  }

  if (cmd === 'check') {
    const name = positionals[0];
    if (!name) fail('Usage: maestri check "Agent Name"');
    const r = await request('GET', `/check?name=${encodeURIComponent(name)}`);
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'ask') {
    if (typeof flags.batch === 'string') {
      let map;
      try {
        map = JSON.parse(flags.batch);
      } catch {
        fail('Invalid JSON passed to --batch');
      }
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 120_000;
      const r = await request('POST', '/ask/batch', { targets: map, timeoutMs });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    const target = positionals[0];
    const isRaw = flags.raw !== undefined;
    const prompt = typeof flags.raw === 'string' ? flags.raw : positionals.slice(1).join(' ');
    if (!target) fail('Usage: maestri ask "Agent Name" "prompt"');
    const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 60_000;
    const r = await request('POST', '/ask', { target, prompt, raw: isRaw, timeoutMs });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'notify') {
    const r = await request('POST', '/notify', { message: positionals.join(' ') });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'connect') {
    if (positionals.length < 2) fail('Usage: maestri connect "From" "To"');
    const r = await request('POST', '/connect', { from: positionals[0], to: positionals[1] });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'recruit') {
    const r = await request('POST', '/team/recruit', {
      name: positionals[0] || '',
      preset: flags.preset,
      role: flags.role,
      floor: flags.floor,
      workspace: flags.workspace,
      band: flags.band,
      command: flags.command,
      dir: flags.dir,
      icon: flags.icon,
      color: flags.color,
      replace: flags.replace,
    });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'dismiss') {
    const name = positionals[0];
    if (!name) fail('Usage: maestri dismiss "Name"');
    const r = await request('POST', '/team/dismiss', { name });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'arrange') {
    const r = await request('POST', '/team/arrange', {
      target: positionals[0] || '',
      newName: flags.name,
      icon: flags.icon,
      color: flags.color,
    });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'band') {
    const sub = positionals[0];
    const bandName = positionals[1];
    if (!sub || !bandName) fail('Usage: maestri band create|add|remove|dissolve "Name" ...');
    const r = await request('POST', '/team/band', {
      action: sub,
      name: bandName,
      agents: positionals.slice(2),
      agent: positionals[2],
      withoutMe: flags['without-me'] === true,
      icon: flags.icon,
      color: flags.color,
    });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'role') {
    const sub = positionals[0] || 'list';
    if (sub === 'list') {
      const r = await request('GET', '/role/list');
      if (r.status >= 400) fail(r.body);
      const roles = JSON.parse(r.body);
      for (const role of roles) {
        process.stdout.write(`- ${role.name} (${role.scope}): ${role.preview}\n`);
      }
      return;
    }
    if (sub === 'show') {
      const r = await request('GET', `/role/show?name=${encodeURIComponent(positionals[1] || '')}`);
      if (r.status >= 400) fail(r.body);
      const role = JSON.parse(r.body);
      process.stdout.write(`${role.name} [${role.scope}]\n\n${role.prompt}\n`);
      return;
    }
    if (sub === 'create') {
      const r = await request('POST', '/role/create', {
        name: positionals[1],
        prompt: positionals[2] ?? '',
        scope: flags.scope,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'write') {
      const r = await request('POST', '/role/write', {
        name: positionals[1],
        prompt: positionals[2] ?? '',
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'edit') {
      const r = await request('POST', '/role/edit', {
        name: positionals[1],
        oldText: positionals[2],
        newText: positionals[3],
        scope: flags.scope,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'assign') {
      const r = await request('POST', '/role/assign', {
        recruit: positionals[1],
        role: flags.none ? null : positionals[2],
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    fail(`Unknown role subcommand: ${sub}`);
  }

  if (cmd === 'preset') {
    const sub = positionals[0] || 'list';
    if (sub === 'list') {
      const r = await request('GET', '/preset/list');
      if (r.status >= 400) fail(r.body);
      for (const p of JSON.parse(r.body)) {
        process.stdout.write(`- ${p.name}: ${p.command || '(shell)'}${p.maestroMode ? ' [Maestro]' : ''}\n`);
      }
      return;
    }
    if (sub === 'show') {
      const r = await request('GET', `/preset/show?name=${encodeURIComponent(positionals[1] || '')}`);
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    const r = await request('POST', '/preset/edit', {
      action: sub,
      name: positionals[1],
      newName: flags.name,
      command: flags.command,
      maestro: flags.maestro === 'on' ? true : flags.maestro === 'off' ? false : undefined,
      chat: flags.chat === 'on' ? true : flags.chat === 'off' ? false : undefined,
      quickStart: flags['quick-start'] === 'on' ? true : flags['quick-start'] === 'off' ? false : undefined,
      account: flags.account,
    });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'partitura') {
    const sub = positionals[0] || 'list';
    const r = await request('POST', '/team/partitura', {
      command: sub,
      name: positionals[1],
      summary: flags.summary,
    });
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'note') {
    const sub = positionals[0];
    if (sub === 'create') {
      const r = await request('POST', '/note/create', {
        content: positionals[1] ?? '',
        name: flags.name,
        color: flags.color,
        stack: flags.stack !== undefined,
        stackName: typeof flags.stack === 'string' ? flags.stack : undefined,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'read') {
      const name = positionals[1] || '';
      const q = new URLSearchParams({ name });
      if (positionals[2]) q.set('offset', positionals[2]);
      if (positionals[3]) q.set('limit', positionals[3]);
      const r = await request('GET', `/note/read?${q.toString()}`);
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'write') {
      const r = await request('POST', '/note/write', { name: positionals[1], content: positionals[2] ?? '' });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'edit') {
      const r = await request('POST', '/note/edit', {
        name: positionals[1],
        oldText: positionals[2],
        newText: positionals[3],
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'stack' || sub === 'unstack' || sub === 'delete') {
      const r = await request('POST', `/note/${sub}`, {
        name: positionals[1],
        stackName: positionals[2],
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    fail(`Unknown note subcommand: ${sub}`);
  }

  if (cmd === 'floor') {
    const sub = positionals[0] || 'list';
    if (sub === 'list') {
      const r = await request('GET', '/floor/list');
      if (r.status >= 400) fail(r.body);
      for (const f of JSON.parse(r.body)) {
        const st = f.status ? ` [${f.status.state}] ${f.status.text}` : '';
        process.stdout.write(`- ${f.name}${f.branch ? ` (${f.branch})` : ''} — ${f.nodeCount} nodes — ${f.path}${f.active ? ' *active*' : ''}${st}\n`);
      }
      return;
    }
    if (sub === 'create') {
      const r = await request('POST', '/floor/create', {
        name: positionals[1],
        branch: flags.branch,
        existingBranch: flags['existing-branch'] === true,
        noGit: flags['no-git'] === true,
        copyGround: flags['copy-ground'] === true,
        dir: flags.dir,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'status') {
      let progress;
      if (typeof flags.progress === 'string') {
        if (flags.progress.includes('/')) {
          const [a, b] = flags.progress.split('/').map(Number);
          if (b > 0) progress = a / b;
        } else if (flags.progress.endsWith('%')) {
          progress = parseFloat(flags.progress) / 100;
        } else {
          progress = Number(flags.progress);
        }
      }
      const r = await request('POST', '/floor/status', {
        text: positionals[1] || '',
        state: flags.state,
        progress,
        floor: flags.floor,
        clear: flags.clear === true,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'land' || sub === 'delete') {
      const r = await request('POST', `/floor/${sub}`, {
        name: positionals[1],
        into: flags.into,
        deleteBranch: flags['delete-branch'] === true,
        keepFloor: flags['keep-floor'] === true,
        keepFolder: flags['keep-folder'] === true,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    fail(`Unknown floor subcommand: ${sub}`);
  }

  if (cmd === 'workspace') {
    const sub = positionals[0] || 'list';
    if (sub === 'list') {
      const r = await request('GET', '/workspace/list');
      if (r.status >= 400) fail(r.body);
      for (const w of JSON.parse(r.body)) {
        process.stdout.write(`- ${w.name} (${w.dir}, ${w.floors} floors)${w.current ? ' *current*' : ''}\n`);
      }
      return;
    }
    if (sub === 'create') {
      const r = await request('POST', '/workspace/create', {
        name: positionals[1],
        dir: flags.dir,
        from: flags.from,
        group: flags.group,
        folder: flags.folder,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'rename') {
      const r = await request('POST', '/workspace/rename', {
        currentName: positionals[1],
        newName: positionals[2],
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    fail(`Unknown workspace subcommand: ${sub}`);
  }

  if (cmd === 'portal') {
    const sub = positionals[0];
    if (sub === 'create') {
      const r = await request('POST', '/portal/create', {
        url: positionals[1],
        name: positionals[2],
        size: flags.size,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'edit') {
      const r = await request('POST', '/portal/edit', { name: positionals[1], url: flags.url });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'close') {
      const r = await request('POST', '/portal/close', { name: positionals[1] });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    const portalName = positionals[1];
    if (!portalName) fail('Usage: maestri portal <action> "Portal" ...');
    const payload = {
      name: portalName,
      action: sub,
      selector: positionals[2],
      text: sub === 'fill' ? positionals[3] : sub === 'type' ? (positionals[3] ?? positionals[2]) : undefined,
      url: sub === 'navigate' || sub === 'goto' ? positionals[2] : undefined,
      key: sub === 'key' || sub === 'press' ? positionals[2] : undefined,
      direction: sub === 'scroll' ? positionals[2] : undefined,
      amount: sub === 'scroll' && positionals[3] ? Number(positionals[3]) : undefined,
      expression: sub === 'evaluate' || sub === 'eval' ? positionals[2] : undefined,
      width: sub === 'resize' ? Number(positionals[2]) : undefined,
      height: sub === 'resize' ? Number(positionals[3]) : undefined,
      value: sub === 'ua' || sub === 'useragent' ? positionals[2] : sub === 'select' ? positionals[3] : undefined,
    };
    const r = await request('POST', '/portal/action', payload);
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  if (cmd === 'routine') {
    const sub = positionals[0] || 'list';
    if (sub === 'list') {
      const r = await request('GET', '/routine/list');
      if (r.status >= 400) fail(r.body);
      for (const item of JSON.parse(r.body)) {
        process.stdout.write(`- ${item.name} [${item.id.slice(0, 6)}] (${item.schedule.kind}:${item.schedule.value}) ${item.enabled ? 'enabled' : 'paused'}\n`);
      }
      return;
    }
    if (sub === 'show') {
      const r = await request('GET', `/routine/show?name=${encodeURIComponent(positionals[1] || '')}`);
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'create') {
      let schedule;
      if (flags.every) schedule = { kind: 'every', value: String(flags.every) };
      else if (flags.daily) schedule = { kind: 'daily', value: String(flags.daily) };
      else if (flags.weekly) schedule = { kind: 'weekly', value: String(flags.weekly) };
      else if (flags.once) schedule = { kind: 'once', value: String(flags.once) };
      else fail('Schedule required: --every, --daily, --weekly, or --once');
      const r = await request('POST', '/routine/create', {
        name: positionals[1],
        command: flags.command,
        schedule,
        terminal: flags.terminal,
        reminder: flags.reminder === true,
        preRun: flags['pre-run'],
        noSkipIfBusy: flags['no-skip-if-busy'] === true,
        noNotify: flags['no-notify'] === true,
        disabled: flags.disabled === true,
        count: flags.count ? Number(flags.count) : undefined,
        until: flags.until,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const r = await request('POST', '/routine/toggle', {
        target: positionals[1],
        id: flags.id,
        enabled: sub === 'enable',
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    if (sub === 'run' || sub === 'delete') {
      const r = await request('POST', `/routine/${sub}`, {
        target: positionals[1],
        id: flags.id,
      });
      if (r.status >= 400) fail(r.body);
      process.stdout.write(r.body + '\n');
      return;
    }
    fail(`Unknown routine subcommand: ${sub}`);
  }

  if (cmd === 'say') {
    let text = positionals.join(' ');
    if (typeof flags.file === 'string') {
      text = fs.readFileSync(path.resolve(flags.file), 'utf8');
    } else if (typeof flags.progress === 'string') {
      text = flags.progress;
    } else if (!text) {
      text = await readStdin();
    }
    const r = await request('POST', '/chat/say', {
      text,
      thread: typeof flags.thread === 'string' ? flags.thread : undefined,
      progress: flags.progress !== undefined,
    });
    if (r.status >= 400) fail(r.body);
    return;
  }

  if (cmd === 'recall') {
    const q = new URLSearchParams();
    if (positionals[0] && positionals[0] !== 'list') q.set('thread', positionals[0]);
    if (flags.turns) q.set('turns', String(flags.turns));
    const r = await request('GET', `/chat/recall?${q.toString()}`);
    if (r.status >= 400) fail(r.body);
    process.stdout.write(r.body + '\n');
    return;
  }

  fail(`Unknown command "${cmd}". Run "maestri help" for usage.`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
