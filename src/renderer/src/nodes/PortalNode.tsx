import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Maximize2,
  Minimize2,
  RotateCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { PORTAL_UA_PRESETS } from '../../../shared/constants';
import type { CanvasNode } from '../../../shared/types';
import { useDismissable } from '../components/useDismissable';
import { activeWorkspaceAtom } from '../state/atoms';
import { NodeFrame } from './NodeFrame';

interface WebviewElement extends HTMLElement {
  src: string;
  getWebContentsId: () => number;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => void;
}

export const PortalNode: React.FC<{ node: CanvasNode }> = ({ node }) => {
  const workspace = useAtomValue(activeWorkspaceAtom);
  const portal = node.content.kind === 'portal' ? node.content.portal : null;
  const webviewRef = useRef<WebviewElement | null>(null);
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  const [urlInput, setUrlInput] = useState(portal?.url || 'https://example.com');
  const [showDeviceMenu, setShowDeviceMenu] = useState(false);

  useDismissable(showDeviceMenu, deviceMenuRef, () => setShowDeviceMenu(false));

  useEffect(() => {
    if (portal?.url) setUrlInput(portal.url);
  }, [portal?.url]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !portal) return;

    const handleDomReady = () => {
      try {
        const wcId = wv.getWebContentsId();
        void window.orkestrei.portal.register(portal.id, wcId);
      } catch {
        // ignore if not ready
      }
    };

    const handleDidNavigate = (ev: Event & { url?: string }) => {
      if (ev.url && workspace) {
        setUrlInput(ev.url);
      }
    };

    wv.addEventListener('dom-ready', handleDomReady);
    wv.addEventListener('did-navigate', handleDidNavigate);
    return () => {
      wv.removeEventListener('dom-ready', handleDomReady);
      wv.removeEventListener('did-navigate', handleDidNavigate);
      void window.orkestrei.portal.unregister(portal.id);
    };
  }, [portal?.id]);

  if (!portal || !workspace) return null;

  const navigate = (raw: string) => {
    let target = raw.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target) && !target.startsWith('about:')) {
      target = target.includes('localhost') || target.includes('127.0.0.1')
        ? `http://${target}`
        : `https://${target}`;
    }
    setUrlInput(target);
    void window.orkestrei.node.patch(workspace.id, node.id, {
      content: { kind: 'portal', portal: { ...portal, url: target } },
    });
    webviewRef.current?.loadURL(target);
  };

  const setViewport = (w: number, h: number, uaPreset: string) => {
    setShowDeviceMenu(false);
    void window.orkestrei.node.patch(workspace.id, node.id, {
      frame: { ...node.frame, width: w, height: h + 52 },
      content: {
        kind: 'portal',
        portal: {
          ...portal,
          viewportSize: { width: w, height: h },
          userAgentPreset: uaPreset,
        },
      },
    });
  };

  const ua = PORTAL_UA_PRESETS[portal.userAgentPreset]?.userAgent || undefined;

  return (
    <NodeFrame node={node} minWidth={340} minHeight={260}>
      {({ startDrag, isLifted, toggleLift }) => (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-lg bg-[var(--card)]">
          <div
            onPointerDown={startDrag}
            className="flex h-11 shrink-0 cursor-grab items-center gap-1.5 border-b border-[var(--border)] bg-[var(--card)] px-2.5 active:cursor-grabbing"
          >
            <Globe className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
            <span className="max-w-[90px] truncate text-xs font-medium text-[var(--foreground)]">
              {portal.name || 'Portal'}
            </span>

            <div className="flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => webviewRef.current?.goBack()}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
              >
                <ArrowLeft className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => webviewRef.current?.goForward()}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
              >
                <ArrowRight className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => webviewRef.current?.reload()}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
              >
                <RotateCw className="size-3.5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                navigate(urlInput);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex-1"
            >
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                className="w-full rounded-lg bg-[var(--input)] px-2.5 py-1 text-xs text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
                placeholder="https://..."
              />
            </form>

            <div className="flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
              <div ref={deviceMenuRef} className="relative flex items-center">
                <button
                  type="button"
                  onClick={() => setShowDeviceMenu((v) => !v)}
                  className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
                  title="Responsive viewport presets"
                >
                  <Smartphone className="size-3.5" />
                </button>
                {showDeviceMenu && (
                  <div className="glass-strong absolute right-0 top-8 z-40 w-44 rounded-lg border border-[var(--border)] p-1 text-xs shadow-xl">
                    <button
                      type="button"
                      onClick={() => setViewport(720, 500, 'desktop')}
                      className="w-full rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      Desktop (720×500)
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewport(390, 740, 'ios')}
                      className="w-full rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      iPhone 12 Pro (390×740)
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewport(768, 760, 'ios')}
                      className="w-full rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      iPad Mini (768×760)
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={toggleLift}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-hover)] hover:text-[var(--foreground)]"
                title="Focus"
              >
                {isLifted ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => void window.orkestrei.node.deleteMany(workspace.id, [node.id])}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/20 hover:text-[var(--destructive)]"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>

          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="relative flex-1 bg-white"
          >
            <webview
              ref={(el) => {
                webviewRef.current = el as WebviewElement | null;
              }}
              src={portal.url}
              useragent={ua}
              className="h-full w-full"
            />
          </div>
        </div>
      )}
    </NodeFrame>
  );
};
