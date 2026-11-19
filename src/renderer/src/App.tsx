import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { Toaster, toast } from 'sonner';
import type { AskInFlight, TransferActiveEvent } from '../../shared/types';
import { CanvasViewport } from './canvas/CanvasViewport';
import { CommandPalette } from './components/CommandPalette';
import { DockedSidebar } from './components/DockedSidebar';
import { OrchestrationSheets } from './components/OrchestrationSheets';
import { TopBar } from './components/TopBar';
import {
  activeWorkspaceAtom,
  activeWorkspaceIdAtom,
  activityStateAtom,
  agentUsageAtom,
  appStateAtom,
  asksInFlightAtom,
  canvasOffsetAtom,
  EMPTY_AGENT_USAGE_SNAPSHOT,
  partiturasAtom,
  preferencesAtom,
  recentTransfersAtom,
  rolesAtom,
  routineHistoryAtom,
  routinesAtom,
  savedPromptsAtom,
  sidebarLayoutAtom,
  tokenUsageAtom,
  workspacesAtom,
  zoomAtom,
} from './state/atoms';
import { pendingTerminalFocusAtom } from './state/ui-atoms';

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = a ?? null;
  const nb = b ?? null;
  if (na === null || nb === null) return na === nb;
  return na.toLowerCase() === nb.toLowerCase();
}

export const App: React.FC = () => {
  const [booted, setBooted] = useState(false);
  const store = useStore();
  const workspace = useAtomValue(activeWorkspaceAtom);
  const prefs = useAtomValue(preferencesAtom);

  const setWorkspaces = useSetAtom(workspacesAtom);
  const setActiveId = useSetAtom(activeWorkspaceIdAtom);
  const setAppState = useSetAtom(appStateAtom);
  const setPrefs = useSetAtom(preferencesAtom);
  const setSidebarLayout = useSetAtom(sidebarLayoutAtom);
  const setRoles = useSetAtom(rolesAtom);
  const setPartituras = useSetAtom(partiturasAtom);
  const setSavedPrompts = useSetAtom(savedPromptsAtom);
  const setRoutines = useSetAtom(routinesAtom);
  const setRoutineHistory = useSetAtom(routineHistoryAtom);
  const setActivity = useSetAtom(activityStateAtom);
  const setAsksInFlight = useSetAtom(asksInFlightAtom);
  const setRecentTransfers = useSetAtom(recentTransfersAtom);
  const setTokenUsage = useSetAtom(tokenUsageAtom);
  const setAgentUsage = useSetAtom(agentUsageAtom);
  const setPendingTerminalFocus = useSetAtom(pendingTerminalFocusAtom);

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-theme',
      prefs.theme === 'light' ? 'light' : 'dark'
    );
  }, [prefs.theme]);

  useEffect(() => {
    const loadInitial = async () => {
      const [
        wsList,
        activeId,
        appSt,
        p,
        sLayout,
        roleList,
        partList,
        promptList,
        routList,
        histList,
        act,
        tokens,
        agentUsage,
      ] =
        await Promise.all([
          window.orkestrei.workspace.list(),
          window.orkestrei.workspace.getActiveId(),
          window.orkestrei.appState.get(),
          window.orkestrei.preferences.get(),
          window.orkestrei.sidebarLayout.get(),
          window.orkestrei.roles.list(),
          window.orkestrei.partitura.list(),
          window.orkestrei.savedPrompts.list(),
          window.orkestrei.routines.list(),
          window.orkestrei.routines.history(),
          window.orkestrei.terminal.activityState(),
          window.orkestrei.tokens.get(),
          window.orkestrei.agentUsage.get().catch(() => EMPTY_AGENT_USAGE_SNAPSHOT),
        ]);

      setWorkspaces(wsList);
      setActiveId(activeId ?? wsList[0]?.id ?? null);
      setAppState(appSt);
      setPrefs(p);
      setSidebarLayout(sLayout);
      setRoles(roleList);
      setPartituras(partList);
      setSavedPrompts(promptList);
      setRoutines(routList);
      setRoutineHistory(histList);
      setActivity(act);
      setTokenUsage(tokens);
      setAgentUsage(agentUsage);
      setBooted(true);
    };

    void loadInitial();

    const unsubs = [
      window.orkestrei.workspace.onChanged((updated) => {
        setWorkspaces((prev) => {
          const idx = prev.findIndex((w) => w.id === updated.id);
          if (idx === -1) return [...prev, updated];
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      }),
      window.orkestrei.workspace.onDeleted((deletedId) => {
        setWorkspaces((prev) => prev.filter((w) => w.id !== deletedId));
      }),
      window.orkestrei.workspace.onActiveChanged((nextId) => {
        setActiveId(nextId);
      }),
      window.orkestrei.preferences.onChanged(setPrefs),
      window.orkestrei.sidebarLayout.onChanged(setSidebarLayout),
      window.orkestrei.roles.onChanged(() => {
        void window.orkestrei.roles.list().then(setRoles);
      }),
      window.orkestrei.partitura.onChanged(() => {
        void window.orkestrei.partitura.list().then(setPartituras);
      }),
      window.orkestrei.savedPrompts.onChanged(() => {
        void window.orkestrei.savedPrompts.list().then(setSavedPrompts);
      }),
      window.orkestrei.routines.onChanged(() => {
        void window.orkestrei.routines.list().then(setRoutines);
      }),
      window.orkestrei.routines.onHistoryChanged(() => {
        void window.orkestrei.routines.history().then(setRoutineHistory);
      }),
      window.orkestrei.terminal.onActivity(setActivity),
      window.orkestrei.tokens.onChanged(setTokenUsage),
      window.orkestrei.agentUsage.onChanged(setAgentUsage),
      window.orkestrei.band.onAsksInFlight((asks) => {
        setAsksInFlight(asks as Record<string, AskInFlight>);
      }),
      window.orkestrei.connection.onTransferActive((ev: TransferActiveEvent) => {
        setRecentTransfers((prev) => [...prev.slice(-15), ev]);
        setTimeout(() => {
          setRecentTransfers((prev) => prev.filter((x) => Date.now() - x.timestamp < 2400));
        }, 2500);
      }),
      window.orkestrei.app.onNotification((n) => {
        toast(n.title, { description: n.body });
      }),
      window.orkestrei.terminal.onFocusRequest((ev) => {
        const allWorkspaces = store.get(workspacesAtom);
        let targetWorkspaceId = ev.workspaceId;
        let targetFloorId = ev.floorId;

        if (!targetWorkspaceId) {
          for (const ws of allWorkspaces) {
            const onGround = ws.nodes.some(
              (n) =>
                (n.content.kind === 'terminal' && sameId(n.content.terminal.id, ev.terminalId)) ||
                (ev.nodeId !== null && sameId(n.id, ev.nodeId))
            );
            if (onGround) {
              targetWorkspaceId = ws.id;
              targetFloorId = null;
              break;
            }
            const floorMatch = ws.floors.find((f) =>
              f.nodes.some(
                (n) =>
                  (n.content.kind === 'terminal' &&
                    sameId(n.content.terminal.id, ev.terminalId)) ||
                  (ev.nodeId !== null && sameId(n.id, ev.nodeId))
              )
            );
            if (floorMatch) {
              targetWorkspaceId = ws.id;
              targetFloorId = floorMatch.id;
              break;
            }
          }
        }

        if (!targetWorkspaceId) return;

        setPendingTerminalFocus({
          terminalId: ev.terminalId,
          nodeId: ev.nodeId,
          workspaceId: targetWorkspaceId,
          floorId: targetFloorId,
        });

        void (async () => {
          const curWs = store.get(activeWorkspaceAtom);
          if (!curWs || !sameId(curWs.id, targetWorkspaceId)) {
            const switched = await window.orkestrei.workspace.switch(targetWorkspaceId);
            if (!switched) {
              setPendingTerminalFocus(null);
              return;
            }
            if (!sameId(switched.activeFloorId, targetFloorId)) {
              await window.orkestrei.floor.switch(switched.id, targetFloorId);
            }
          } else if (!sameId(curWs.activeFloorId, targetFloorId)) {
            await window.orkestrei.floor.switch(curWs.id, targetFloorId, {
              origin: store.get(canvasOffsetAtom),
              zoom: store.get(zoomAtom),
            });
          }
        })();
      }),
    ];

    return () => {
      for (const u of unsubs) u();
    };
  }, []);

  if (!booted) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--background)] text-xs text-[var(--muted-foreground)]">
        Starting Orkestrei…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <DockedSidebar />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        {workspace ? (
          <CanvasViewport />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
            Create a workspace to begin
          </div>
        )}
        <TopBar />
      </main>

      <OrchestrationSheets />
      <CommandPalette />
      <Toaster position="bottom-center" theme={prefs.theme === 'light' ? 'light' : 'dark'} />
    </div>
  );
};

export default App;
