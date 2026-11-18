import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function newId(): string {
  return randomUUID();
}

export function idsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function sameFloor(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = a ?? null;
  const nb = b ?? null;
  if (na === null || nb === null) return na === nb;
  return na.toLowerCase() === nb.toLowerCase();
}

export function displayNameForNoteFile(fileName: string, fallback = 'Untitled'): string {
  const stripped = fileName.replace(/\.(?:md|markdown|txt)$/i, '');
  return stripped === '' ? fallback : stripped;
}

export function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export function slugifyBranch(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `floor-${Date.now()}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * Persist JSON atomically via a per-file queue and unique temporary file.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const resolved = path.resolve(filePath);
  const queueKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const prev = writeQueues.get(queueKey) ?? Promise.resolve();

  const current = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureDir(path.dirname(resolved));
      const tmp = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fsp.rename(tmp, resolved);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => undefined);
        throw err;
      }
    });

  writeQueues.set(queueKey, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(queueKey) === current) {
      writeQueues.delete(queueKey);
    }
  }
}

export function readJsonFileSync<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}
