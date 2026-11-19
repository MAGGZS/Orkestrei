import React, { useEffect, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { FolderOpen, Play, Plus, Sparkles, Trash2, X } from 'lucide-react';
import type { AgentPreset, FloorLandingPreview, HookCommand, RoutineSchedule } from '../../../shared/types';
import {
  activeLevelAtom,
  activeSheetAtom,
  activeWorkspaceAtom,
  partiturasAtom,
  preferencesAtom,
  rolesAtom,
  routineHistoryAtom,
  routinesAtom,
  workspacesAtom,
} from '../state/atoms';
import { type TmuxPrefixOption, tmuxPrefixSettingAtom } from '../state/ui-atoms';

const ModalShell: React.FC<{
  title: string;
  onClose: () => void;
  widthClass?: string;
  children: React.ReactNode;
}> = ({ title, onClose, widthClass = 'max-w-lg', children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`glass-strong w-full ${widthClass} overflow-hidden rounded-2xl border border-[var(--border)] shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-4 text-xs">{children}</div>
      </div>
    </div>
  );
};

export const OrchestrationSheets: React.FC = () => {
  const [sheet, setSheet] = useAtom(activeSheetAtom);
  const workspace = useAtomValue(activeWorkspaceAtom);
  const level = useAtomValue(activeLevelAtom);
  const workspaces = useAtomValue(workspacesAtom);
  const prefs = useAtomValue(preferencesAtom);
  const roles = useAtomValue(rolesAtom);
  const partituras = useAtomValue(partiturasAtom);
  const routines = useAtomValue(routinesAtom);
  const routineHistory = useAtomValue(routineHistoryAtom);
  const [tmuxPrefix, setTmuxPrefix] = useAtom(tmuxPrefixSettingAtom);

  // Form states
  const [wsName, setWsName] = useState('');
  const [wsDir, setWsDir] = useState('');
  const [wsFrom, setWsFrom] = useState('');

  const [floorName, setFloorName] = useState('');
  const [floorBranch, setFloorBranch] = useState('');
  const [floorNoGit, setFloorNoGit] = useState(false);
  const [floorCopyGround, setFloorCopyGround] = useState(false);

  const [landInto, setLandInto] = useState('main');
  const [landDeleteBranch, setLandDeleteBranch] = useState(true);

  const [bandName, setBandName] = useState('Squad');

  const [partName, setPartName] = useState('');
  const [partSummary, setPartSummary] = useState('');

  const [roleName, setRoleName] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  const [roleScope, setRoleScope] = useState<'current' | 'global'>('global');

  const [presetName, setPresetName] = useState('');
  const [presetCmd, setPresetCmd] = useState('');
  const [presetMaestro, setPresetMaestro] = useState(false);

  const [routineName, setRoutineName] = useState('');
  const [routineCmd, setRoutineCmd] = useState('');
  const [routineKind, setRoutineKind] = useState<'every' | 'daily'>('every');
  const [routineVal, setRoutineVal] = useState('30m');
  const [routineTermId, setRoutineTermId] = useState('');
  const [routineTab, setRoutineTab] = useState<'list' | 'history'>('list');

  const [fileContent, setFileContent] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  const [landingPreview, setLandingPreview] = useState<FloorLandingPreview | null>(null);
  const [landingLoading, setLandingLoading] = useState(false);
  const [landingError, setLandingError] = useState<string | null>(null);

  const [hookPhaseTab, setHookPhaseTab] = useState<'setup' | 'run' | 'teardown'>('setup');
  const [newHookLabel, setNewHookLabel] = useState('');
  const [newHookCmd, setNewHookCmd] = useState('');
  const [hookRunResults, setHookRunResults] = useState<
    Array<{ id: string; label: string; command: string; ok: boolean; output: string }>
  >([]);
  const [hookRunning, setHookRunning] = useState(false);

  const loadLandingPreview = async (wsId: string, floorId: string, into?: string) => {
    setLandingLoading(true);
    setLandingError(null);
    const prev = await window.orkestrei.floor.landingPreview(wsId, floorId, into);
    setLandingPreview(prev);
    setLandingLoading(false);
  };

  useEffect(() => {
    if (sheet?.kind === 'fileEditor') {
      setFileError(null);
      void window.orkestrei.fileTree.readFile(sheet.filePath).then((res) => {
        if (res.ok) setFileContent(res.content);
        else setFileError(res.error);
      });
    } else if (sheet?.kind === 'landFloor' && workspace) {
      void loadLandingPreview(workspace.id, sheet.floorId, landInto.trim() || undefined);
    } else if (sheet?.kind === 'floorHooks') {
      setHookRunResults([]);
    }
  }, [sheet, workspace?.id]);

  if (!sheet) return null;

  const close = () => setSheet(null);

  if (sheet.kind === 'newWorkspace') {
    return (
      <ModalShell title="New Workspace" onClose={close}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!wsName.trim() || !wsDir.trim()) return;
            const created = await window.orkestrei.workspace.create({
              name: wsName.trim(),
              workingDirectory: wsDir.trim(),
              fromWorkspaceId: wsFrom || null,
            });
            await window.orkestrei.workspace.switch(created.id);
            setWsName('');
            setWsDir('');
            close();
          }}
          className="space-y-3"
        >
          <div>
            <label className="mb-1 block font-medium text-[var(--muted-foreground)]">Name</label>
            <input
              autoFocus
              required
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              placeholder="e.g. My Fullstack App"
              className="w-full rounded-xl bg-[var(--input)] px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
          <div>
            <label className="mb-1 block font-medium text-[var(--muted-foreground)]">
              Project Directory
            </label>
            <div className="flex gap-2">
              <input
                required
                value={wsDir}
                onChange={(e) => setWsDir(e.target.value)}
                placeholder="C:\path\to\project"
                className="flex-1 rounded-xl bg-[var(--input)] px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--ring)]"
              />
              <button
                type="button"
                onClick={async () => {
                  const picked = await window.orkestrei.app.pickDirectory();
                  if (picked) setWsDir(picked);
                }}
                className="flex items-center gap-1 rounded-xl bg-[var(--secondary)] px-3 py-2 font-medium hover:opacity-90"
              >
                <FolderOpen className="size-3.5" />
                Browse
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block font-medium text-[var(--muted-foreground)]">
              Clone Layout From (Optional Template)
            </label>
            <select
              value={wsFrom}
              onChange={(e) => setWsFrom(e.target.value)}
              className="w-full rounded-xl bg-[var(--input)] px-3 py-2 outline-none"
            >
              <option value="">Empty Canvas</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={close} className="rounded-xl px-3 py-1.5 hover:bg-[var(--bg-hover)]">
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-xl bg-[var(--accent)] px-4 py-1.5 font-medium text-white"
            >
              Create Workspace
            </button>
          </div>
        </form>
      </ModalShell>
    );
  }

  if (sheet.kind === 'newFloor' && workspace) {
    return (
      <ModalShell title="New Floor (Isolated Level)" onClose={close}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!floorName.trim()) return;
            const res = await window.orkestrei.floor.create(workspace.id, {
              name: floorName.trim(),
              branchName: floorBranch.trim() || undefined,
              noGit: floorNoGit,
              copyGround: floorCopyGround,
            });
            if (res.ok) {
              await window.orkestrei.floor.switch(workspace.id, res.floor.id);
              setFloorName('');
              setFloorBranch('');
              close();
            }
          }}
          className="space-y-3"
        >
          <div>
            <label className="mb-1 block font-medium text-[var(--muted-foreground)]">Floor Name</label>
            <input
              autoFocus
              required
              value={floorName}
              onChange={(e) => setFloorName(e.target.value)}
              placeholder="e.g. Refactor Auth"
              className="w-full rounded-xl bg-[var(--input)] px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
          <div>
            <label className="mb-1 block font-medium text-[var(--muted-foreground)]">
              Git Branch (auto-slugged if blank)
            </label>
            <input
              value={floorBranch}
              onChange={(e) => setFloorBranch(e.target.value)}
              placeholder="feat/refactor-auth"
              className="w-full rounded-xl bg-[var(--input)] px-3 py-2 outline-none"
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!floorNoGit}
              onChange={(e) => setFloorNoGit(!e.target.checked)}
            />
            <span>Isolate in a Git Worktree (.orkestrei/floors/...)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={floorCopyGround}
              onChange={(e) => setFloorCopyGround(e.target.checked)}
            />
            <span>Copy Ground floor layout</span>
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={close} className="rounded-xl px-3 py-1.5 hover:bg-[var(--bg-hover)]">
              Cancel
            </button>
            <button type="submit" className="rounded-xl bg-[var(--accent)] px-4 py-1.5 font-medium text-white">
              Create Floor
            </button>
          </div>
        </form>
      </ModalShell>
    );
  }

  if (sheet.kind === 'landFloor' && workspace) {
    const floor = workspace.floors.find((f) => f.id === sheet.floorId);
    return (
      <ModalShell title={`Land Floor: ${floor?.name ?? ''}`} onClose={close} widthClass="max-w-2xl">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!floor) return;
            setLandingError(null);
            const res = await window.orkestrei.floor.land(workspace.id, floor.id, {
              intoBranch: landInto.trim() || undefined,
              deleteBranch: landDeleteBranch,
            });
            if (!res.ok) {
              setLandingError(res.error);
              return;
            }
            close();
          }}
          className="space-y-3"
        >
          <p className="text-[var(--muted-foreground)]">
            Merge branch <strong>{floor?.branchName || '(local floor)'}</strong> back into your project and clean up the worktree.
          </p>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block font-medium text-[var(--muted-foreground)]">
                Target Branch
              </label>
              <input
                value={landInto}
                onChange={(e) => setLandInto(e.target.value)}
                className="w-full rounded-xl bg-[var(--input)] px-3 py-2 outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                if (floor) void loadLandingPreview(workspace.id, floor.id, landInto.trim() || undefined);
              }}
              className="rounded-xl border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 font-medium hover:bg-[var(--bg-hover)]"
            >
              {landingLoading ? 'Refreshing…' : 'Refresh Diff'}
            </button>
          </div>

          {landingPreview && (
            <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded bg-[var(--secondary)] px-2 py-0.5 font-mono">
                  {landingPreview.worktreePath}
                </span>
                {landingPreview.dirtyFiles.length > 0 && (
                  <span className="rounded bg-[#ff9f0a]/20 px-2 py-0.5 font-semibold text-[#ff9f0a]">
                    {landingPreview.dirtyFiles.length} uncommitted change(s)
                  </span>
                )}
                {landingPreview.commitLog.length > 0 && (
                  <span className="rounded bg-[#0a84ff]/20 px-2 py-0.5 font-semibold text-[#64d2ff]">
                    {landingPreview.commitLog.length} commit(s) ahead of {landingPreview.targetBranch}
                  </span>
                )}
              </div>

              {landingPreview.commitLog.length > 0 && (
                <div className="max-h-24 overflow-y-auto rounded-lg bg-[var(--card)] p-2 font-mono text-[10.5px]">
                  {landingPreview.commitLog.map((line, i) => (
                    <div key={i} className="truncate text-[var(--foreground)]">
                      {line}
                    </div>
                  ))}
                </div>
              )}

              {landingPreview.diffStat && (
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-[var(--card)] p-2 font-mono text-[10.5px] text-[var(--muted-foreground)]">
                  {landingPreview.diffStat}
                </pre>
              )}

              {landingPreview.diffText ? (
                <pre className="max-h-48 overflow-auto whitespace-pre rounded-lg bg-[#111216] p-2.5 font-mono text-[10.5px] text-[#d4d4d8]">
                  {landingPreview.diffText}
                </pre>
              ) : (
                <div className="text-[11px] italic text-[var(--muted-foreground)]">
                  {landingPreview.isGitRepo
                    ? 'No diffs detected relative to target branch.'
                    : 'Not a Git repository floor.'}
                </div>
              )}
            </div>
          )}

          {landingError && (
            <div className="rounded-xl border border-[var(--destructive)]/40 bg-[var(--destructive)]/15 px-3 py-2 text-[11px] text-[var(--destructive)]">
              {landingError}
            </div>
          )}

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={landDeleteBranch}
              onChange={(e) => setLandDeleteBranch(e.target.checked)}
            />
            <span>Delete floor branch after merge</span>
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={close} className="rounded-xl px-3 py-1.5 hover:bg-[var(--bg-hover)]">
              Cancel
            </button>
            <button type="submit" className="rounded-xl bg-[var(--success)] px-4 py-1.5 font-medium text-black">
              Land Floor
            </button>
          </div>
        </form>
      </ModalShell>
    );
  }

  if (sheet.kind === 'floorHooks' && workspace) {
    const hooks = workspace.hooks;
    const cmdsKey =
      hookPhaseTab === 'setup'
        ? 'setupCommands'
        : hookPhaseTab === 'run'
          ? 'runCommands'
          : 'teardownCommands';
    const currentCmds = hooks[cmdsKey];

    const saveHooksPatch = (nextHooks: typeof hooks) => {
      void window.orkestrei.workspace.patch(workspace.id, { hooks: nextHooks });
    };

    const handleAddHook = () => {
      if (!newHookCmd.trim()) return;
      const item: HookCommand = {
        id: crypto.randomUUID(),
        name: newHookLabel.trim() || newHookCmd.trim().slice(0, 28),
        command: newHookCmd.trim(),
      };
      saveHooksPatch({
        ...hooks,
        [cmdsKey]: [...currentCmds, item],
      });
      setNewHookLabel('');
      setNewHookCmd('');
    };

    const handleRunPhase = async () => {
      setHookRunning(true);
      const res = await window.orkestrei.floorHooks.run(
        workspace.id,
        workspace.activeFloorId,
        hookPhaseTab
      );
      setHookRunResults(res.results);
      setHookRunning(false);
    };

    return (
      <ModalShell title="Floor Hooks (Lifecycle Commands)" onClose={close} widthClass="max-w-2xl">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={hooks.isEnabled}
                onChange={(e) => saveHooksPatch({ ...hooks, isEnabled: e.target.checked })}
              />
              <span>Enable Workspace Hooks</span>
            </label>
            <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={hooks.autoRunSetup}
                onChange={(e) => saveHooksPatch({ ...hooks, autoRunSetup: e.target.checked })}
              />
              <span>Auto-run Setup when a new Floor is created</span>
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex gap-1.5">
              {(['setup', 'run', 'teardown'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setHookPhaseTab(tab)}
                  className={`rounded-lg px-3 py-1.5 capitalize ${
                    hookPhaseTab === tab
                      ? 'bg-[var(--accent)] font-medium text-white'
                      : 'bg-[var(--secondary)] text-[var(--muted-foreground)]'
                  }`}
                >
                  {tab} ({hooks[`${tab}Commands`].length})
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={hookRunning || currentCmds.length === 0}
              onClick={() => void handleRunPhase()}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--success)] px-3 py-1.5 font-medium text-black disabled:opacity-40"
            >
              <Play className="size-3.5" />
              {hookRunning ? 'Running…' : `Run ${hookPhaseTab} now`}
            </button>
          </div>

          <div className="flex gap-2">
            <input
              value={newHookLabel}
              onChange={(e) => setNewHookLabel(e.target.value)}
              placeholder="Label (e.g. Install deps)"
              className="w-40 rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
            />
            <input
              value={newHookCmd}
              onChange={(e) => setNewHookCmd(e.target.value)}
              placeholder="Shell command (e.g. npm install)"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddHook();
                }
              }}
              className="flex-1 rounded-lg bg-[var(--input)] px-2.5 py-1.5 font-mono outline-none"
            />
            <button
              type="button"
              onClick={handleAddHook}
              className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-white"
            >
              <Plus className="size-3.5" />
              Add
            </button>
          </div>

          <div className="space-y-1.5">
            {currentCmds.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-[var(--muted-foreground)]">
                No {hookPhaseTab} hook commands configured.
              </div>
            ) : (
              currentCmds.map((cmd) => (
                <div
                  key={cmd.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[var(--foreground)]">{cmd.name}</div>
                    <div className="truncate font-mono text-[11px] text-[var(--muted-foreground)]">
                      {cmd.command}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      saveHooksPatch({
                        ...hooks,
                        [cmdsKey]: currentCmds.filter((c) => c.id !== cmd.id),
                      })
                    }
                    className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          {hookRunResults.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-[var(--border)] bg-[#111216] p-3">
              <div className="text-[11px] font-medium text-[var(--muted-foreground)]">
                Last execution output
              </div>
              {hookRunResults.map((r) => (
                <div key={r.id} className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-[#e4e4e7]">{r.label}</span>
                    <span className={r.ok ? 'text-[#30d158]' : 'text-[#ff453a]'}>
                      {r.ok ? 'OK' : 'FAILED'}
                    </span>
                  </div>
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10.5px] text-[#a1a1aa]">
                    {r.output}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </ModalShell>
    );
  }

  if (sheet.kind === 'bandCreate' && workspace) {
    return (
      <ModalShell title="Form Agent Band (Squad)" onClose={close}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await window.orkestrei.band.create(workspace.id, sheet.nodeIds, bandName.trim() || 'Squad');
            close();
          }}
          className="space-y-3"
        >
          <p className="text-[var(--muted-foreground)]">
            A Band bundles {sheet.nodeIds.length} terminals into a single squad container. Every member can message each other and shares all ropes attached to the Band.
          </p>
          <input
            autoFocus
            value={bandName}
            onChange={(e) => setBandName(e.target.value)}
            placeholder="Squad Name"
            className="w-full rounded-xl bg-[var(--input)] px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--ring)]"
          />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={close} className="rounded-xl px-3 py-1.5 hover:bg-[var(--bg-hover)]">
              Cancel
            </button>
            <button type="submit" className="rounded-xl bg-[var(--accent)] px-4 py-1.5 font-medium text-white">
              Create Band
            </button>
          </div>
        </form>
      </ModalShell>
    );
  }

  if (sheet.kind === 'partituras' && workspace) {
    return (
      <ModalShell title="Partituras — Saved Team Topologies" onClose={close} widthClass="max-w-2xl">
        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/70 p-3">
            <div className="mb-2 font-semibold text-[var(--foreground)]">
              Save Current Canvas as Partitura
            </div>
            <div className="flex gap-2">
              <input
                value={partName}
                onChange={(e) => setPartName(e.target.value)}
                placeholder="Partitura name (e.g. Fullstack Squad)"
                className="flex-1 rounded-xl bg-[var(--input)] px-3 py-1.5 outline-none"
              />
              <input
                value={partSummary}
                onChange={(e) => setPartSummary(e.target.value)}
                placeholder="Short summary"
                className="flex-1 rounded-xl bg-[var(--input)] px-3 py-1.5 outline-none"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!partName.trim()) return;
                  await window.orkestrei.partitura.save({
                    name: partName.trim(),
                    summary: partSummary.trim() || `${level.nodes.length} nodes`,
                    icon: 'sparkles',
                    color: '#0a84ff',
                    workspaceId: null,
                    nodes: level.nodes,
                    connections: level.connections,
                    noteConnections: level.noteConnections,
                    noteToNoteConnections: level.noteToNoteConnections,
                    portalConnections: level.portalConnections,
                    portalToPortalConnections: level.portalToPortalConnections,
                    drawings: level.drawings,
                    roles,
                  });
                  setPartName('');
                  setPartSummary('');
                }}
                className="rounded-xl bg-[var(--accent)] px-3 py-1.5 font-medium text-white"
              >
                Save Layout
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {partituras.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
              >
                <div>
                  <div className="flex items-center gap-1.5 font-semibold text-[var(--foreground)]">
                    <Sparkles className="size-3.5 text-[var(--accent)]" />
                    {p.name}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                    {p.summary} · {p.nodes.length} nodes, {p.connections.length} connections
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      await window.orkestrei.partitura.insert(workspace.id, p.id);
                      close();
                    }}
                    className="rounded-xl bg-[var(--accent)] px-3 py-1.5 font-medium text-white hover:opacity-90"
                  >
                    Insert onto Canvas
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.orkestrei.partitura.delete(p.id)}
                    className="rounded-lg p-1.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </ModalShell>
    );
  }

  if (sheet.kind === 'rolesAndPresets' && workspace) {
    return (
      <ModalShell title="Agent Roles & Presets" onClose={close} widthClass="max-w-2xl">
        <div className="space-y-5">
          {/* Roles */}
          <div className="space-y-2">
            <h3 className="font-semibold text-[var(--foreground)]">Roles</h3>
            <div className="grid gap-2">
              {roles.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start justify-between rounded-xl border border-[var(--border)] bg-[var(--card)] p-2.5"
                >
                  <div>
                    <div className="font-semibold text-[var(--foreground)]">
                      {r.name}{' '}
                      <span className="ml-1 rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[10px]">
                        {r.scope}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{r.prompt}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void window.orkestrei.roles.delete(r.id)}
                    className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-[var(--border)] p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  placeholder="New Role Name"
                  className="flex-1 rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
                />
                <select
                  value={roleScope}
                  onChange={(e) => setRoleScope(e.target.value as 'current' | 'global')}
                  className="rounded-lg bg-[var(--input)] px-2 py-1.5 outline-none"
                >
                  <option value="global">Global</option>
                  <option value="current">Current Workspace</option>
                </select>
              </div>
              <textarea
                value={rolePrompt}
                onChange={(e) => setRolePrompt(e.target.value)}
                rows={2}
                placeholder="System instruction prompt for this role…"
                className="w-full rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!roleName.trim()) return;
                  await window.orkestrei.roles.create({
                    name: roleName.trim(),
                    prompt: rolePrompt.trim(),
                    scope: roleScope,
                    workspaceId: roleScope === 'current' ? workspace.id : null,
                  });
                  setRoleName('');
                  setRolePrompt('');
                }}
                className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-white"
              >
                <Plus className="size-3.5" />
                Add Role
              </button>
            </div>
          </div>

          {/* Presets */}
          <div className="space-y-2 border-t border-[var(--border)] pt-4">
            <h3 className="font-semibold text-[var(--foreground)]">CLI Agent Presets</h3>
            <div className="grid gap-1.5">
              {prefs.agentPresets.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 font-mono text-[11px] text-[var(--muted-foreground)]">
                      {p.command || '(interactive shell)'}
                    </span>
                    {p.maestroMode && (
                      <span className="ml-2 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                        Maestro
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={async () => {
                        const now = new Date().toISOString();
                        const activeFloor = workspace.activeFloorId
                          ? workspace.floors.find((f) => f.id === workspace.activeFloorId)
                          : null;
                        const count =
                          level.nodes.filter(
                            (n) =>
                              n.content.kind === 'terminal' &&
                              n.content.terminal.presetId === p.id
                          ).length + 1;
                        await window.orkestrei.node.create(workspace.id, {
                          id: crypto.randomUUID(),
                          frame: {
                            x: 120 + (level.nodes.length % 4) * 44,
                            y: 100 + (level.nodes.length % 4) * 44,
                            width: 560,
                            height: 390,
                          },
                          zIndex: 1,
                          groupId: null,
                          createdAt: now,
                          lastModifiedAt: now,
                          content: {
                            kind: 'terminal',
                            terminal: {
                              id: crypto.randomUUID(),
                              name: count === 1 ? p.name : `${p.name} ${count}`,
                              command: p.command || null,
                              workingDirectory: activeFloor?.clonePath || workspace.workingDirectory,
                              agentType: p.agentType,
                              presetId: p.id,
                              roleId: null,
                              roleName: null,
                              isManager: p.maestroMode,
                              inChatMode: p.startInChatMode,
                              color: p.color ?? '#8e8e93',
                              icon: p.icon || 'terminal',
                              accountName: p.account || 'Default',
                              isUnloaded: false,
                            },
                          },
                        });
                        close();
                      }}
                      className="rounded-md bg-[var(--secondary)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--bg-hover)]"
                    >
                      Launch
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void window.orkestrei.preferences.set({
                          agentPresets: prefs.agentPresets.filter((x) => x.id !== p.id),
                        })
                      }
                      className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset Name (e.g. Claude Opus)"
                className="flex-1 rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
              />
              <input
                value={presetCmd}
                onChange={(e) => setPresetCmd(e.target.value)}
                placeholder="CLI command (e.g. claude --model opus)"
                className="flex-1 rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
              />
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={presetMaestro}
                  onChange={(e) => setPresetMaestro(e.target.checked)}
                />
                Maestro
              </label>
              <button
                type="button"
                onClick={async () => {
                  if (!presetName.trim()) return;
                  const cmdTrimmed = presetCmd.trim();
                  const detectedType = cmdTrimmed.toLowerCase().startsWith('agy')
                    ? 'antigravity'
                    : cmdTrimmed.toLowerCase().startsWith('claude')
                      ? 'claude'
                      : cmdTrimmed.toLowerCase().startsWith('codex')
                        ? 'codex'
                        : cmdTrimmed.toLowerCase().startsWith('gemini')
                          ? 'gemini'
                          : 'custom';
                  const next: AgentPreset = {
                    id: crypto.randomUUID(),
                    name: presetName.trim(),
                    command: cmdTrimmed,
                    agentType: detectedType,
                    icon: detectedType === 'antigravity' ? 'sparkles' : 'bot',
                    color: '#0a84ff',
                    isActive: true,
                    maestroMode: presetMaestro,
                    startInChatMode: false,
                    showInQuickStart: true,
                    account: 'Default',
                  };
                  await window.orkestrei.preferences.set({
                    agentPresets: [...prefs.agentPresets, next],
                  });
                  setPresetName('');
                  setPresetCmd('');
                  setPresetMaestro(false);
                }}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-white"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      </ModalShell>
    );
  }

  if (sheet.kind === 'routines' && workspace) {
    const terminals = level.nodes.filter((n) => n.content.kind === 'terminal');
    return (
      <ModalShell title="Scheduled Routines" onClose={close} widthClass="max-w-2xl">
        <div className="space-y-4">
          <div className="flex gap-2 border-b border-[var(--border)] pb-2">
            <button
              type="button"
              onClick={() => setRoutineTab('list')}
              className={`rounded-lg px-3 py-1 font-medium ${
                routineTab === 'list' ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted-foreground)]'
              }`}
            >
              Routines ({routines.length})
            </button>
            <button
              type="button"
              onClick={() => setRoutineTab('history')}
              className={`rounded-lg px-3 py-1 font-medium ${
                routineTab === 'history' ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted-foreground)]'
              }`}
            >
              Fire History ({routineHistory.length})
            </button>
          </div>

          {routineTab === 'list' ? (
            <>
              <div className="space-y-2 rounded-xl border border-[var(--border)] p-3">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={routineName}
                    onChange={(e) => setRoutineName(e.target.value)}
                    placeholder="Routine name"
                    className="rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
                  />
                  <select
                    value={routineTermId}
                    onChange={(e) => setRoutineTermId(e.target.value)}
                    className="rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
                  >
                    <option value="">Desktop Reminder (no terminal)</option>
                    {terminals.map((n) => {
                      const t = n.content.kind === 'terminal' ? n.content.terminal : null;
                      return t ? (
                        <option key={t.id} value={t.id}>
                          Target: {t.name}
                        </option>
                      ) : null;
                    })}
                  </select>
                </div>
                <input
                  value={routineCmd}
                  onChange={(e) => setRoutineCmd(e.target.value)}
                  placeholder="Command or prompt to deliver"
                  className="w-full rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={routineKind}
                    onChange={(e) => setRoutineKind(e.target.value as 'every' | 'daily')}
                    className="rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
                  >
                    <option value="every">Every interval</option>
                    <option value="daily">Daily at HH:mm</option>
                  </select>
                  <input
                    value={routineVal}
                    onChange={(e) => setRoutineVal(e.target.value)}
                    placeholder={routineKind === 'every' ? '30m' : '09:00'}
                    className="w-28 rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if (!routineName.trim() || !routineCmd.trim()) return;
                      const schedule: RoutineSchedule = { kind: routineKind, value: routineVal };
                      await window.orkestrei.routines.create({
                        workspaceId: workspace.id,
                        name: routineName.trim(),
                        command: routineCmd.trim(),
                        schedule,
                        targetTerminalId: routineTermId || null,
                        isReminder: !routineTermId,
                      });
                      setRoutineName('');
                      setRoutineCmd('');
                    }}
                    className="ml-auto rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-white"
                  >
                    Create Routine
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                {routines.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
                  >
                    <div>
                      <div className="font-semibold">
                        {r.name}{' '}
                        <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
                          ({r.schedule.kind}: {r.schedule.value})
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-[var(--muted-foreground)]">
                        {r.command}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void window.orkestrei.routines.runNow(r.id)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--secondary)] px-2 py-1 hover:opacity-90"
                        title="Run now"
                      >
                        <Play className="size-3" />
                        Run
                      </button>
                      <button
                        type="button"
                        onClick={() => void window.orkestrei.routines.setEnabled(r.id, !r.enabled)}
                        className={`rounded-lg px-2 py-1 ${
                          r.enabled
                            ? 'bg-[var(--success)]/20 text-[var(--success)]'
                            : 'bg-[var(--secondary)] text-[var(--muted-foreground)]'
                        }`}
                      >
                        {r.enabled ? 'Enabled' : 'Paused'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void window.orkestrei.routines.delete(r.id)}
                        className="p-1 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              {routineHistory.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-1.5"
                >
                  <span className="font-medium">{h.routineName}</span>
                  <span className="text-[var(--muted-foreground)]">
                    {h.status} · {new Date(h.firedAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ModalShell>
    );
  }

  if (sheet.kind === 'preferences') {
    return (
      <ModalShell title="Preferences" onClose={close}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span>Theme</span>
            <select
              value={prefs.theme}
              onChange={(e) =>
                void window.orkestrei.preferences.set({
                  theme: e.target.value as 'dark' | 'light' | 'system',
                })
              }
              className="rounded-lg bg-[var(--input)] px-3 py-1.5 outline-none"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span>Canvas Background</span>
            <select
              value={prefs.canvasBackground}
              onChange={(e) =>
                void window.orkestrei.preferences.set({
                  canvasBackground: e.target.value as 'grid' | 'solid',
                })
              }
              className="rounded-lg bg-[var(--input)] px-3 py-1.5 outline-none"
            >
              <option value="grid">Graph Paper Grid</option>
              <option value="solid">Solid</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span>Terminal Font Size</span>
            <input
              type="number"
              min={10}
              max={24}
              value={prefs.fontSize}
              onChange={(e) =>
                void window.orkestrei.preferences.set({ fontSize: Number(e.target.value) || 13 })
              }
              className="w-20 rounded-lg bg-[var(--input)] px-2.5 py-1.5 outline-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div>Tmux Prefix Key</div>
              <div className="text-[11px] text-[var(--muted-foreground)]">
                Followed by 1–9, n/p, z, f
              </div>
            </div>
            <select
              value={tmuxPrefix}
              onChange={(e) => setTmuxPrefix(e.target.value as TmuxPrefixOption)}
              className="rounded-lg bg-[var(--input)] px-3 py-1.5 outline-none"
            >
              <option value="ctrl+b">Ctrl+B (Default)</option>
              <option value="ctrl+a">Ctrl+A</option>
              <option value="alt+b">Alt+B</option>
              <option value="ctrl+space">Ctrl+Space</option>
              <option value="off">Disabled</option>
            </select>
          </div>
        </div>
      </ModalShell>
    );
  }

  if (sheet.kind === 'fileEditor') {
    return (
      <ModalShell title={sheet.title} onClose={close} widthClass="max-w-3xl">
        {fileError ? (
          <p className="text-[var(--destructive)]">{fileError}</p>
        ) : (
          <div className="space-y-3">
            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              rows={20}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-xs outline-none"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} className="rounded-xl px-3 py-1.5 hover:bg-[var(--bg-hover)]">
                Close
              </button>
              <button
                type="button"
                onClick={async () => {
                  await window.orkestrei.fileTree.writeFile(sheet.filePath, fileContent);
                  close();
                }}
                className="rounded-xl bg-[var(--accent)] px-4 py-1.5 font-medium text-white"
              >
                Save File
              </button>
            </div>
          </div>
        )}
      </ModalShell>
    );
  }

  return null;
};
