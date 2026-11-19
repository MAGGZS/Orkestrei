import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/main/workspace-store';
import type { CableTie, CanvasNode, Workspace } from '../src/shared/types';

describe('Disconnect corrections (B1 & C1)', () => {
  let tempRoot: string;
  let store: WorkspaceStore;

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orkestrei-disconnect-test-'));
    store = new WorkspaceStore(tempRoot);
    await store.init();
  });

  afterAll(async () => {
    try {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  function makeTerminalNode(name: string, termId: string): CanvasNode {
    return {
      id: `node-${termId}`,
      frame: { x: 0, y: 0, width: 200, height: 200 },
      zIndex: 1,
      groupId: null,
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
      content: {
        kind: 'terminal',
        terminal: {
          id: termId,
          name,
          command: null,
          workingDirectory: null,
          agentType: 'shell',
          presetId: 'preset-shell',
          roleId: null,
          roleName: null,
          isManager: false,
          inChatMode: false,
          color: '#fff',
          icon: 'terminal',
          accountName: 'default',
          isUnloaded: false,
        },
      },
    };
  }

  it('B1: disconnectAllForNode cleans up cableTies referencing removed crossFloorConnections', async () => {
    const ws = await store.createWorkspace({ name: 'B1 Test WS', workingDirectory: tempRoot });
    const floorRes = await store.createFloor(ws.id, { name: 'Floor B1', noGit: true });
    expect(floorRes.ok).toBe(true);
    const freshWs = store.getWorkspace(ws.id)!;
    const floor = freshWs.floors[0];

    const groundTermNode = await store.createNode(ws.id, makeTerminalNode('Ground Term', 'term-ground'), null);
    const groundOtherNode = await store.createNode(ws.id, makeTerminalNode('Other Ground', 'term-other'), null);
    const floorTermNode = await store.createNode(ws.id, makeTerminalNode('Floor Term', 'term-floor'), floor.id);

    expect(groundTermNode).not.toBeNull();
    expect(groundOtherNode).not.toBeNull();
    expect(floorTermNode).not.toBeNull();

    const groundTermId = 'term-ground';
    const groundOtherId = 'term-other';
    const floorTermId = 'term-floor';

    // Connect ground to floor (cross-floor connection)
    const cfcRes = await store.connectNodes(ws.id, groundTermId, floorTermId);
    expect(cfcRes.ok).toBe(true);
    const cfcId = (cfcRes as { ok: true; connectionId: string }).connectionId;

    // Connect ground to ground other (local connection)
    const localRes = await store.connectNodes(ws.id, groundTermId, groundOtherId);
    expect(localRes.ok).toBe(true);
    const localConnId = (localRes as { ok: true; connectionId: string }).connectionId;

    // Create a cable tie tying both ropes together on ground
    const tie: CableTie = {
      id: 'tie-b1',
      memberRopeIds: [cfcId, localConnId],
      position: { x: 100, y: 100 },
    };
    await store.createCableTie(ws.id, tie);

    const wsBefore = store.getWorkspace(ws.id)!;
    expect(wsBefore.cableTies.length).toBe(1);
    expect(wsBefore.cableTies[0].memberRopeIds).toContain(cfcId);

    // Disconnect all for floorTermId (removes cfcId)
    await store.disconnectAllForNode(ws.id, floorTermId);

    const wsAfter = store.getWorkspace(ws.id)!;
    // Cross-floor connection must be gone
    expect(wsAfter.crossFloorConnections.find((c) => c.id === cfcId)).toBeUndefined();
    // Cable tie must have cleaned up cfcId, and dissolved because fewer than 2 ropes remain
    expect(wsAfter.cableTies.length).toBe(0);
  });

  it('C1: disconnectAllForNode removes mirror edges from remote workspace crossWorkspaceConnections', async () => {
    const wsA = await store.createWorkspace({ name: 'Workspace A', workingDirectory: tempRoot });
    const wsB = await store.createWorkspace({ name: 'Workspace B', workingDirectory: tempRoot });

    await store.createNode(wsA.id, makeTerminalNode('Term A', 'term-A'), null);
    await store.createNode(wsB.id, makeTerminalNode('Term B', 'term-B'), null);

    const termAId = 'term-A';
    const termBId = 'term-B';

    const connectRes = await store.connectAcrossWorkspaces(wsA.id, termAId, wsB.id, termBId);
    expect(connectRes.ok).toBe(true);

    // Verify both workspaces have the edge
    const freshA = store.getWorkspace(wsA.id)!;
    const freshB = store.getWorkspace(wsB.id)!;
    expect(freshA.crossWorkspaceConnections.length).toBe(1);
    expect(freshB.crossWorkspaceConnections.length).toBe(1);

    // Disconnect all for Term A in Workspace A
    await store.disconnectAllForNode(wsA.id, termAId);

    // Verify Workspace A removed the connection
    const updatedA = store.getWorkspace(wsA.id)!;
    expect(updatedA.crossWorkspaceConnections.length).toBe(0);

    // Verify Workspace B mirror edge was also removed!
    const updatedB = store.getWorkspace(wsB.id)!;
    expect(updatedB.crossWorkspaceConnections.length).toBe(0);
  });

  it('A1/A2: disconnect cross-floor, undo restaura conexao, redo remove de novo', async () => {
    const ws = await store.createWorkspace({ name: 'Undo Cross-Floor Test', workingDirectory: tempRoot });
    const floorRes = await store.createFloor(ws.id, { name: 'Floor 1', noGit: true });
    expect(floorRes.ok).toBe(true);
    const freshWs = store.getWorkspace(ws.id)!;
    const floor = freshWs.floors[0];

    const termGround = 'term-g-1';
    const termFloor = 'term-f-1';
    await store.createNode(ws.id, makeTerminalNode('Term Ground', termGround), null);
    await store.createNode(ws.id, makeTerminalNode('Term Floor', termFloor), floor.id);

    // Connect ground to floor
    const connRes = await store.connectNodes(ws.id, termGround, termFloor);
    expect(connRes.ok).toBe(true);

    const wsWithConn = store.getWorkspace(ws.id)!;
    expect(wsWithConn.crossFloorConnections.length).toBe(1);
    const originalConnId = wsWithConn.crossFloorConnections[0].id;

    // Disconnect nodes
    const disconnRes = await store.disconnectNodes(ws.id, termGround, termFloor);
    expect(disconnRes.ok).toBe(true);
    expect((disconnRes as { ok: true; removed: number }).removed).toBe(1);

    const wsAfterDisconn = store.getWorkspace(ws.id)!;
    expect(wsAfterDisconn.crossFloorConnections.length).toBe(0);

    // Undo: should restore the cross-floor connection
    const undoRes = await store.undo(ws.id);
    expect(undoRes).toBe(true);

    const wsAfterUndo = store.getWorkspace(ws.id)!;
    expect(wsAfterUndo.crossFloorConnections.length).toBe(1);
    expect(wsAfterUndo.crossFloorConnections[0].id).toBe(originalConnId);
    expect(wsAfterUndo.crossFloorConnections[0].terminalIdA).toBe(termGround);
    expect(wsAfterUndo.crossFloorConnections[0].terminalIdB).toBe(termFloor);

    // Redo: should remove the cross-floor connection again
    const redoRes = await store.redo(ws.id);
    expect(redoRes).toBe(true);

    const wsAfterRedo = store.getWorkspace(ws.id)!;
    expect(wsAfterRedo.crossFloorConnections.length).toBe(0);

    // Undo again to verify idempotency / re-restoration
    const undoAgainRes = await store.undo(ws.id);
    expect(undoAgainRes).toBe(true);
    const wsAfterUndoAgain = store.getWorkspace(ws.id)!;
    expect(wsAfterUndoAgain.crossFloorConnections.length).toBe(1);
    expect(wsAfterUndoAgain.crossFloorConnections[0].id).toBe(originalConnId);
  });

  it('A1/A2: nos em floors distintos restaurando os dois niveis no undo', async () => {
    const ws = await store.createWorkspace({ name: 'Dual Floor Undo Test', workingDirectory: tempRoot });
    const floorAlphaRes = await store.createFloor(ws.id, { name: 'Floor Alpha', noGit: true });
    const floorBetaRes = await store.createFloor(ws.id, { name: 'Floor Beta', noGit: true });
    expect(floorAlphaRes.ok).toBe(true);
    expect(floorBetaRes.ok).toBe(true);

    const freshWs = store.getWorkspace(ws.id)!;
    const floorAlpha = freshWs.floors.find((f) => f.name === 'Floor Alpha')!;
    const floorBeta = freshWs.floors.find((f) => f.name === 'Floor Beta')!;

    // Create terminals on Floor Alpha
    await store.createNode(ws.id, makeTerminalNode('Term A1', 'term-a1'), floorAlpha.id);
    await store.createNode(ws.id, makeTerminalNode('Term A2', 'term-a2'), floorAlpha.id);

    // Create terminals on Floor Beta
    await store.createNode(ws.id, makeTerminalNode('Term B1', 'term-b1'), floorBeta.id);
    await store.createNode(ws.id, makeTerminalNode('Term B2', 'term-b2'), floorBeta.id);

    // Local connection on Floor Alpha
    const localARes = await store.connectNodes(ws.id, 'term-a1', 'term-a2');
    expect(localARes.ok).toBe(true);
    const localAId = (localARes as { ok: true; connectionId: string }).connectionId;

    // Local connection on Floor Beta
    const localBRes = await store.connectNodes(ws.id, 'term-b1', 'term-b2');
    expect(localBRes.ok).toBe(true);
    const localBId = (localBRes as { ok: true; connectionId: string }).connectionId;

    // Cross-floor connection between Floor Alpha and Floor Beta
    const crossRes = await store.connectNodes(ws.id, 'term-a1', 'term-b1');
    expect(crossRes.ok).toBe(true);
    const crossConnId = (crossRes as { ok: true; connectionId: string }).connectionId;

    // Add CableTie on Floor Alpha tying crossConnId and localAId
    await store.switchFloor(ws.id, floorAlpha.id);
    const tieAlpha: CableTie = {
      id: 'tie-alpha-1',
      memberRopeIds: [crossConnId, localAId],
      position: { x: 50, y: 50 },
    };
    await store.createCableTie(ws.id, tieAlpha);

    // Add CableTie on Floor Beta tying crossConnId and localBId
    await store.switchFloor(ws.id, floorBeta.id);
    const tieBeta: CableTie = {
      id: 'tie-beta-1',
      memberRopeIds: [crossConnId, localBId],
      position: { x: 60, y: 60 },
    };
    await store.createCableTie(ws.id, tieBeta);

    // Switch back to Floor Alpha as active floor
    await store.switchFloor(ws.id, floorAlpha.id);

    // Verify initial state
    const wsBefore = store.getWorkspace(ws.id)!;
    const fAlphaBefore = wsBefore.floors.find((f) => f.id === floorAlpha.id)!;
    const fBetaBefore = wsBefore.floors.find((f) => f.id === floorBeta.id)!;
    expect(wsBefore.crossFloorConnections.length).toBe(1);
    expect(fAlphaBefore.cableTies.length).toBe(1);
    expect(fBetaBefore.cableTies.length).toBe(1);

    // Disconnect cross-floor connection between term-a1 and term-b1
    const disconnRes = await store.disconnectNodes(ws.id, 'term-a1', 'term-b1');
    expect(disconnRes.ok).toBe(true);

    // In disconnected state:
    // - crossFloorConnection is removed
    // - both cable ties dissolved because crossConnId was removed, leaving only 1 rope (< 2)
    const wsDisconn = store.getWorkspace(ws.id)!;
    const fAlphaDisconn = wsDisconn.floors.find((f) => f.id === floorAlpha.id)!;
    const fBetaDisconn = wsDisconn.floors.find((f) => f.id === floorBeta.id)!;
    expect(wsDisconn.crossFloorConnections.length).toBe(0);
    expect(fAlphaDisconn.cableTies.length).toBe(0);
    expect(fBetaDisconn.cableTies.length).toBe(0);

    // Undo: should restore BOTH levels (Floor Alpha and Floor Beta) and crossFloorConnections
    const undoRes = await store.undo(ws.id);
    expect(undoRes).toBe(true);

    const wsRestored = store.getWorkspace(ws.id)!;
    const fAlphaRestored = wsRestored.floors.find((f) => f.id === floorAlpha.id)!;
    const fBetaRestored = wsRestored.floors.find((f) => f.id === floorBeta.id)!;

    expect(wsRestored.crossFloorConnections.length).toBe(1);
    expect(wsRestored.crossFloorConnections[0].id).toBe(crossConnId);

    // Floor Alpha restored
    expect(fAlphaRestored.cableTies.length).toBe(1);
    expect(fAlphaRestored.cableTies[0].id).toBe('tie-alpha-1');
    expect(fAlphaRestored.cableTies[0].memberRopeIds).toContain(crossConnId);
    expect(fAlphaRestored.cableTies[0].memberRopeIds).toContain(localAId);

    // Floor Beta restored
    expect(fBetaRestored.cableTies.length).toBe(1);
    expect(fBetaRestored.cableTies[0].id).toBe('tie-beta-1');
    expect(fBetaRestored.cableTies[0].memberRopeIds).toContain(crossConnId);
    expect(fBetaRestored.cableTies[0].memberRopeIds).toContain(localBId);

    // Redo: should remove the crossFloorConnection and dissolve cable ties on both levels again
    const redoRes = await store.redo(ws.id);
    expect(redoRes).toBe(true);

    const wsRedo = store.getWorkspace(ws.id)!;
    const fAlphaRedo = wsRedo.floors.find((f) => f.id === floorAlpha.id)!;
    const fBetaRedo = wsRedo.floors.find((f) => f.id === floorBeta.id)!;
    expect(wsRedo.crossFloorConnections.length).toBe(0);
    expect(fAlphaRedo.cableTies.length).toBe(0);
    expect(fBetaRedo.cableTies.length).toBe(0);
  });
});
