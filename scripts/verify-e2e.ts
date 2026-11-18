import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ChatStore } from '../src/main/chat-store';
import { OrchestratorServer } from '../src/main/orchestrator-server';
import type { PortalBridge } from '../src/main/portal-bridge';
import { PTYManager } from '../src/main/pty-manager';
import { RoutineScheduler } from '../src/main/routine-scheduler';
import { idsEqual } from '../src/main/utils';
import { WorkspaceStore } from '../src/main/workspace-store';

const execFileAsync = promisify(execFile);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function runCli(
  cliPath: string,
  pipeUrl: string,
  terminalId: string,
  authToken: string,
  args: string[]
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      MAESTRI_PIPE: pipeUrl,
      MAESTRI_TERMINAL_ID: terminalId,
      MAESTRI_TOKEN: authToken,
    },
    timeout: 30_000,
  });
  if (stderr && stderr.trim()) {
    console.warn(`[CLI stderr for ${args.join(' ')}]:`, stderr.trim());
  }
  return stdout.trim();
}

async function main() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orkestrei-e2e-'));
  const binDir = path.resolve('bin');
  const cliPath = path.join(binDir, 'cli.mjs');

  console.log('1. Initializing WorkspaceStore in', tempDir);
  const store = new WorkspaceStore(tempDir);
  await store.init();

  const ptyManager = new PTYManager(binDir);
  const chatStore = new ChatStore(tempDir);
  const portalBridge = {
    register: () => undefined,
    unregister: () => undefined,
    onWakeRequested: () => () => undefined,
    executeAction: async () => ({ ok: true, result: 'ok' }),
  } as unknown as PortalBridge;

  const ensureSpawned = async (workspaceId: string, terminalId: string): Promise<boolean> => {
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return false;
    const found = store.findTerminal(ws, terminalId);
    if (!found) return false;
    if (ptyManager.isRunning(found.terminal.id)) return true;
    const role = found.terminal.roleId ? store.getRole(found.terminal.roleId, ws.id) : null;
    const res = await ptyManager.spawn({
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceDir: ws.workingDirectory,
      terminal: found.terminal,
      role,
    });
    return res.ok;
  };

  const routineScheduler = new RoutineScheduler({
    baseDir: tempDir,
    deliverToTerminal: (tid, cmd) => ptyManager.deliverPrompt(tid, cmd),
    isTerminalBusy: (tid) => Date.now() - ptyManager.getLastOutputAt(tid) < 1800,
    ensureTerminalRunning: ensureSpawned,
    getWorkspaceEnv: () => ({}),
    notifyUser: () => undefined,
  });
  await routineScheduler.init();

  const orchestrator = new OrchestratorServer({
    store,
    ptyManager,
    chatStore,
    portalBridge,
    routineScheduler,
    ensureTerminalSpawned: ensureSpawned,
    notifyUser: () => undefined,
  });

  const port = await orchestrator.start(0);
  const pipeUrl = orchestrator.getUrl();
  const authToken = orchestrator.getAuthToken();
  ptyManager.setPipeUrl(pipeUrl);
  ptyManager.setAuthToken(authToken);
  console.log('2. OrchestratorServer listening at', pipeUrl, `(port=${port})`);

  const ws = store.getActiveWorkspace();
  assert(ws, 'Starter workspace should exist');
  const maestroNode = ws.nodes.find(
    (n) => n.content.kind === 'terminal' && n.content.terminal.name === 'Maestro'
  );
  assert(maestroNode && maestroNode.content.kind === 'terminal', 'Maestro terminal node should exist');
  const maestroId = maestroNode.content.terminal.id;

  const transferEvents: string[] = [];
  orchestrator.onTransferActive((ev) => {
    transferEvents.push(`${ev.fromTerminalId}->${ev.toTerminalId}`);
  });

  try {
    console.log('3. Testing `maestri list`...');
    const listOut = await runCli(cliPath, pipeUrl, maestroId, authToken, ['list']);
    console.log(listOut);
    assert(listOut.includes('Maestro'), 'list output must include Maestro');
    assert(listOut.includes('Builder'), 'list output must include Builder');
    assert(listOut.includes('Guia Rápido do Orkestrei'), 'list output must include starter note');

    console.log('4. Testing `maestri role create`...');
    const roleOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'role',
      'create',
      'QA Engineer',
      'Verify all features and report back',
    ]);
    console.log(roleOut);
    assert(roleOut.includes('QA Engineer'), 'role create should acknowledge QA Engineer');

    console.log('5. Testing `maestri recruit "Falcon" --role "QA Engineer"`...');
    const recruitOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'recruit',
      'Falcon',
      '--role',
      'QA Engineer',
    ]);
    console.log(recruitOut);
    assert(recruitOut.includes('Recruited "Falcon"'), 'recruit should spawn Falcon');

    const updatedWs = store.getWorkspace(ws.id)!;
    const falcon = updatedWs.nodes.find(
      (n) => n.content.kind === 'terminal' && n.content.terminal.name === 'Falcon'
    );
    assert(falcon && falcon.content.kind === 'terminal', 'Falcon node must exist in store');
    assert(ptyManager.isRunning(falcon.content.terminal.id), 'Falcon PTY must be running');

    console.log('6. Testing `maestri note create` with `--stack`...');
    const noteOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'note',
      'create',
      'Especificação do Sistema v1',
      '--name',
      'sys-spec',
      '--stack',
      'Specs',
    ]);
    console.log(noteOut);
    assert(noteOut.includes('Created note "sys-spec"'), 'note create should confirm sys-spec');

    console.log('7. Testing `maestri connect "sys-spec" "Falcon"`...');
    const connOut = await runCli(cliPath, pipeUrl, maestroId, authToken, ['connect', 'sys-spec', 'Falcon']);
    console.log(connOut);
    assert(connOut.includes('Connected'), 'connect should link sys-spec and Falcon');

    // Allow PowerShell prompt to settle inside Falcon before delivering echo
    await new Promise((r) => setTimeout(r, 1500));

    console.log('8. Testing `maestri ask "Falcon" "echo HELLO_FROM_FALCON_AGENT"`...');
    const askOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'ask',
      'Falcon',
      'echo HELLO_FROM_FALCON_AGENT',
    ]);
    console.log('ask output:', JSON.stringify(askOut));
    assert(
      askOut.includes('HELLO_FROM_FALCON_AGENT'),
      'ask output should capture Falcon PTY response'
    );
    assert(
      transferEvents.some((e) => idsEqual(e, `${maestroId}->${falcon.content.kind === 'terminal' ? falcon.content.terminal.id : ''}`)),
      'transferActive event must fire during ask'
    );

    console.log('9. Testing `maestri check "Falcon"`...');
    const checkOut = await runCli(cliPath, pipeUrl, maestroId, authToken, ['check', 'Falcon']);
    assert(checkOut.includes('HELLO_FROM_FALCON_AGENT'), 'check should read Falcon screen');

    console.log('10. Testing `maestri band create "Core Squad"`...');
    const bandOut = await runCli(cliPath, pipeUrl, maestroId, authToken, ['band', 'create', 'Core Squad']);
    console.log(bandOut);
    assert(bandOut.includes('Created band "Core Squad"'), 'band create should succeed');

    console.log('11. Testing `maestri floor status`...');
    const statusOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'floor',
      'status',
      'Orquestração 100% validada',
      '--progress',
      '5/5',
      '--state',
      'done',
      '--floor',
      'Ground',
    ]);
    console.log(statusOut);
    assert(statusOut.includes('[done]'), 'floor status should update Ground status');

    console.log('12. Testing cross-floor orchestration (`floor create` + `recruit --floor` + `ask`)...');
    const floorCreateOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'floor',
      'create',
      'FeatureLab',
      '--no-git',
    ]);
    console.log(floorCreateOut);
    assert(floorCreateOut.includes('Created floor "FeatureLab"'), 'FeatureLab floor must be created');

    const recruitFloorOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'recruit',
      'LabAgent',
      '--floor',
      'FeatureLab',
    ]);
    console.log(recruitFloorOut);
    assert(recruitFloorOut.includes('Recruited "LabAgent"'), 'LabAgent must be recruited on FeatureLab');

    const wsWithFloor = store.getWorkspace(ws.id)!;
    const labFloor = wsWithFloor.floors.find((f) => f.name === 'FeatureLab');
    assert(labFloor, 'FeatureLab must exist in workspace.floors');
    const labAgentNode = labFloor.nodes.find(
      (n) => n.content.kind === 'terminal' && n.content.terminal.name === 'LabAgent'
    );
    assert(labAgentNode, 'LabAgent node must live inside FeatureLab.nodes');
    assert(
      wsWithFloor.crossFloorConnections.length >= 1,
      'crossFloorConnections must link Maestro on Ground to LabAgent on FeatureLab'
    );

    await new Promise((r) => setTimeout(r, 1500));
    const askFloorOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'ask',
      'LabAgent',
      'echo CROSS_FLOOR_OK',
    ]);
    console.log('cross-floor ask output:', JSON.stringify(askFloorOut));
    assert(askFloorOut.includes('CROSS_FLOOR_OK'), 'cross-floor ask to LabAgent must echo CROSS_FLOOR_OK');

    console.log('13. Testing cross-workspace orchestration (`workspace create` + `recruit --workspace` + `ask Name @ Workspace`)...');
    const backendDir = path.join(tempDir, 'backend-svc');
    await fsp.mkdir(backendDir, { recursive: true });
    const wsCreateOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'workspace',
      'create',
      'BackendSvc',
      '--dir',
      backendDir,
    ]);
    console.log(wsCreateOut);
    assert(wsCreateOut.includes('Created workspace "BackendSvc"'), 'BackendSvc workspace must be created');

    const recruitWsOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'recruit',
      'ApiBot',
      '--workspace',
      'BackendSvc',
    ]);
    console.log(recruitWsOut);
    assert(
      recruitWsOut.includes('BackendSvc') && recruitWsOut.includes('ApiBot @ BackendSvc'),
      'recruit --workspace must spawn ApiBot in BackendSvc'
    );

    const listFarOut = await runCli(cliPath, pipeUrl, maestroId, authToken, ['list']);
    console.log(listFarOut);
    assert(listFarOut.includes('ApiBot @ BackendSvc'), 'list must display far peer ApiBot @ BackendSvc');

    await new Promise((r) => setTimeout(r, 1500));
    const askFarOut = await runCli(cliPath, pipeUrl, maestroId, authToken, [
      'ask',
      'ApiBot @ BackendSvc',
      'echo CROSS_WS_OK',
    ]);
    console.log('cross-workspace ask output:', JSON.stringify(askFarOut));
    assert(
      askFarOut.includes('CROSS_WS_OK'),
      'cross-workspace ask to ApiBot @ BackendSvc must echo CROSS_WS_OK'
    );

    console.log('\nALL END-TO-END ORCHESTRATION CHECKS PASSED (1-13)!');
  } finally {
    routineScheduler.stop();
    ptyManager.terminateAll();
    await orchestrator.stop();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
