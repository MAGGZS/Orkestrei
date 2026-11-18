import { webContents, type WebContents } from 'electron';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PORTAL_UA_PRESETS } from '../shared/constants';
import { newId } from './utils';

type ConsoleMessageListener = (
  details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
  level: number,
  message: string
) => void;

interface RegisteredPortal {
  portalId: string;
  webContentsId: number;
  consoleLogs: string[];
  capturingLogs: boolean;
  refSelectors: Map<string, string>; // @e1 -> CSS selector / xpath fallback
  consoleListener?: ConsoleMessageListener;
}

const SNAPSHOT_SCRIPT = `(() => {
  const interactive = [];
  const candidates = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="menuitem"], [tabindex]');
  let idx = 1;
  const escapeCss = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { sel = '#' + CSS.escape(cur.id); parts.unshift(sel); break; }
      const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName) : [];
      if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = '@e' + (idx++);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role') || tag + (type ? ' type=' + type : '');
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
    );
    const href = tag === 'a' ? el.getAttribute('href') : null;
    const focused = document.activeElement === el ? ' *focused*' : '';
    const coords = '[' + Math.round(rect.left) + ',' + Math.round(rect.top) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ']';
    const css = escapeCss(el);
    el.setAttribute('data-maestri-ref', ref);
    interactive.push({
      ref,
      css,
      line: ref + ' ' + role + (label ? ' "' + label + '"' : '') + (href ? ' href=' + href : '') + ' ' + coords + focused
    });
    if (idx > 250) break;
  }
  return {
    viewport: window.innerWidth + 'x' + window.innerHeight,
    url: location.href,
    title: document.title,
    interactive
  };
})()`;

export class PortalBridge {
  private portals = new Map<string, RegisteredPortal>();
  private wakeListeners = new Set<(portalId: string) => void>();

  onWakeRequested(cb: (portalId: string) => void): () => void {
    this.wakeListeners.add(cb);
    return () => this.wakeListeners.delete(cb);
  }

  private detachConsoleListener(entry: RegisteredPortal | undefined): void {
    if (!entry?.consoleListener) return;
    const prevWc = webContents.fromId(entry.webContentsId);
    if (prevWc && !prevWc.isDestroyed()) {
      prevWc.removeListener('console-message', entry.consoleListener);
    }
    entry.consoleListener = undefined;
  }

  register(portalId: string, wcId: number): void {
    const existing = this.portals.get(portalId);
    this.detachConsoleListener(existing);

    const wc = webContents.fromId(wcId);
    const entry: RegisteredPortal = {
      portalId,
      webContentsId: wcId,
      consoleLogs: existing?.consoleLogs ?? [],
      capturingLogs: existing?.capturingLogs ?? false,
      refSelectors: existing?.refSelectors ?? new Map(),
    };

    if (wc && !wc.isDestroyed()) {
      const listener: ConsoleMessageListener = (_ev, level, message) => {
        const cur = this.portals.get(portalId);
        if (cur?.capturingLogs) {
          cur.consoleLogs.push(`[${level}] ${message}`);
          if (cur.consoleLogs.length > 500) cur.consoleLogs.shift();
        }
      };
      entry.consoleListener = listener;
      wc.on('console-message', listener);
    }
    this.portals.set(portalId, entry);
  }

  unregister(portalId: string): void {
    const existing = this.portals.get(portalId);
    this.detachConsoleListener(existing);
    this.portals.delete(portalId);
  }

  private getWebContents(portalId: string): WebContents | null {
    const reg = this.portals.get(portalId);
    if (!reg) return null;
    const wc = webContents.fromId(reg.webContentsId);
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  private resolveTargetScript(portalId: string, selector: string): string {
    const clean = selector.trim();
    const reg = this.portals.get(portalId);
    if (clean.startsWith('@e')) {
      const css = reg?.refSelectors.get(clean);
      return `(() => {
        return document.querySelector('[data-maestri-ref=' + ${JSON.stringify(clean)} + ']') || ${css ? `document.querySelector(${JSON.stringify(css)})` : 'null'};
      })()`;
    }
    if (/^\d+\s*,\s*\d+$/.test(clean)) {
      const [x, y] = clean.split(',').map((s) => Number(s.trim()));
      return `document.elementFromPoint(${x}, ${y})`;
    }
    return `document.querySelector(${JSON.stringify(clean)})`;
  }

  async executeAction(
    portalId: string,
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<{ ok: boolean; result: string }> {
    const wc = this.getWebContents(portalId);
    if (!wc) {
      for (const cb of this.wakeListeners) cb(portalId);
      return {
        ok: false,
        result: 'error: portal not loaded yet; ensure it is visible on the active canvas and retry',
      };
    }

    try {
      switch (action) {
        case 'snapshot':
        case 'a11y': {
          const data = (await wc.executeJavaScript(SNAPSHOT_SCRIPT)) as {
            viewport: string;
            url: string;
            title: string;
            interactive: Array<{ ref: string; css: string; line: string }>;
          };
          const reg = this.portals.get(portalId);
          if (reg) {
            reg.refSelectors.clear();
            for (const item of data.interactive) {
              reg.refSelectors.set(item.ref, item.css);
            }
          }
          const header = `viewport: ${data.viewport}  url: ${data.url}  title: ${data.title}`;
          const lines = data.interactive.map((i) => i.line);
          return { ok: true, result: [header, ...lines].join('\n') };
        }

        case 'navigate':
        case 'goto':
        case 'open': {
          const url = String(params.url ?? '').trim();
          if (!url) return { ok: false, result: 'error: requires url' };
          await wc.loadURL(url);
          return { ok: true, result: 'ok' };
        }

        case 'back':
          if (!wc.navigationHistory.canGoBack()) {
            return { ok: false, result: 'error: no page to go back to' };
          }
          wc.navigationHistory.goBack();
          return { ok: true, result: 'ok' };

        case 'forward':
          if (!wc.navigationHistory.canGoForward()) {
            return { ok: false, result: 'error: no page to go forward to' };
          }
          wc.navigationHistory.goForward();
          return { ok: true, result: 'ok' };

        case 'reload':
          wc.reload();
          return { ok: true, result: 'ok' };

        case 'info': {
          const info = await wc.executeJavaScript(
            `({ url: location.href, title: document.title, width: window.innerWidth, height: window.innerHeight })`
          );
          return {
            ok: true,
            result: `viewport: ${info.width}x${info.height}  url: ${info.url}  title: ${info.title}`,
          };
        }

        case 'screenshot': {
          const img = await wc.capturePage();
          const png = img.toPNG();
          const outPath = path.join(os.tmpdir(), `orkestrei-portal-${newId().slice(0, 8)}.png`);
          await fsp.writeFile(outPath, png);
          return { ok: true, result: outPath };
        }

        case 'html': {
          const html = (await wc.executeJavaScript(`document.documentElement.outerHTML`)) as string;
          return { ok: true, result: html };
        }

        case 'text': {
          const sel = String(params.selector ?? '');
          const resolver = this.resolveTargetScript(portalId, sel);
          const text = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            return el ? (el.innerText || el.textContent || '') : null;
          })()`);
          if (text === null) return { ok: false, result: 'error: element not found' };
          return { ok: true, result: String(text) };
        }

        case 'evaluate':
        case 'eval': {
          const expr = String(params.expression ?? '');
          const val = await wc.executeJavaScript(expr);
          return {
            ok: true,
            result: typeof val === 'string' ? val : JSON.stringify(val, null, 2) ?? 'undefined',
          };
        }

        case 'click': {
          const sel = String(params.selector ?? '');
          if (/^\d+\s*,\s*\d+$/.test(sel.trim())) {
            const [x, y] = sel.split(',').map((s) => Number(s.trim()));
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
            return { ok: true, result: 'ok' };
          }
          const resolver = this.resolveTargetScript(portalId, sel);
          const ok = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            if (!el) return false;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.focus?.();
            el.click();
            return true;
          })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: element not found' };
        }

        case 'fill': {
          const sel = String(params.selector ?? '');
          const text = String(params.text ?? '');
          const resolver = this.resolveTargetScript(portalId, sel);
          const ok = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            if (!el) return false;
            el.focus();
            if ('value' in el) {
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, ${JSON.stringify(text)});
              else el.value = ${JSON.stringify(text)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            if (el.isContentEditable) {
              el.textContent = ${JSON.stringify(text)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }
            return false;
          })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: fill failed' };
        }

        case 'type': {
          const text = String(params.text ?? '');
          if (params.selector) {
            const resolver = this.resolveTargetScript(portalId, String(params.selector));
            await wc.executeJavaScript(`(() => { const el = ${resolver}; el?.focus(); })()`);
          }
          for (const ch of text) {
            wc.sendInputEvent({ type: 'char', keyCode: ch });
          }
          return { ok: true, result: 'ok' };
        }

        case 'key':
        case 'press': {
          const key = String(params.key ?? 'Enter');
          const keyCode = key.split('+').pop() || 'Enter';
          const modifiers: Array<'control' | 'shift' | 'alt' | 'meta'> = [];
          const lower = key.toLowerCase();
          if (lower.includes('ctrl+')) modifiers.push('control');
          if (lower.includes('shift+')) modifiers.push('shift');
          if (lower.includes('alt+')) modifiers.push('alt');
          if (lower.includes('cmd+') || lower.includes('meta+')) modifiers.push('meta');
          wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
          wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
          return { ok: true, result: 'ok' };
        }

        case 'scroll': {
          const dir = String(params.direction ?? 'down');
          const amt = Number(params.amount ?? 300);
          const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
          const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
          await wc.executeJavaScript(`window.scrollBy(${dx}, ${dy})`);
          return { ok: true, result: 'ok' };
        }

        case 'scrollintoview': {
          const resolver = this.resolveTargetScript(portalId, String(params.selector ?? ''));
          const ok = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            if (!el) return false;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            return true;
          })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: element not found' };
        }

        case 'hover': {
          const resolver = this.resolveTargetScript(portalId, String(params.selector ?? ''));
          const ok = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            if (!el) return false;
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            return true;
          })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: element not found' };
        }

        case 'focus': {
          const resolver = this.resolveTargetScript(portalId, String(params.selector ?? ''));
          const ok = await wc.executeJavaScript(`(() => { const el = ${resolver}; if (!el) return false; el.focus(); return true; })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: element not found' };
        }

        case 'check':
        case 'uncheck': {
          const targetChecked = action === 'check';
          const resolver = this.resolveTargetScript(portalId, String(params.selector ?? ''));
          const ok = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            if (!el) return false;
            if (Boolean(el.checked) !== ${targetChecked}) el.click();
            return true;
          })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: element not found' };
        }

        case 'select': {
          const resolver = this.resolveTargetScript(portalId, String(params.selector ?? ''));
          const val = String(params.value ?? '');
          const ok = await wc.executeJavaScript(`(() => {
            const el = ${resolver};
            if (!el || el.tagName !== 'SELECT') return false;
            for (const opt of el.options) {
              if (opt.value === ${JSON.stringify(val)} || opt.text.trim() === ${JSON.stringify(val)}) {
                el.value = opt.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
            return false;
          })()`);
          return ok ? { ok: true, result: 'ok' } : { ok: false, result: 'error: select failed' };
        }

        case 'logs-start': {
          const reg = this.portals.get(portalId);
          if (reg) reg.capturingLogs = true;
          return { ok: true, result: 'ok' };
        }

        case 'logs': {
          const reg = this.portals.get(portalId);
          if (!reg) return { ok: true, result: '' };
          const out = reg.consoleLogs.join('\n');
          reg.consoleLogs = [];
          return { ok: true, result: out };
        }

        case 'ua':
        case 'useragent': {
          const preset = String(params.value ?? '');
          if (!preset) {
            return {
              ok: true,
              result: `current: ${wc.getUserAgent()}\npresets: ${Object.keys(PORTAL_UA_PRESETS).join(', ')}`,
            };
          }
          const found = PORTAL_UA_PRESETS[preset];
          const nextUa = found ? found.userAgent : preset;
          wc.setUserAgent(nextUa || wc.session.getUserAgent());
          wc.reload();
          return { ok: true, result: `ok (${preset})` };
        }

        default:
          return { ok: false, result: `error: unsupported portal action '${action}'` };
      }
    } catch (err) {
      return {
        ok: false,
        result: `error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
