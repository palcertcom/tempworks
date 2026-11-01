/**
 * Tiny `.env` auto-loader for Phase 1 scripts.
 *
 * Why this exists:
 *   - The standalone ts-node scripts under backend/scripts/saas/ run outside
 *     the NestJS bootstrap, so `@nestjs/config` does not load the .env file.
 *   - Operators on Windows PowerShell cannot use `export FOO=bar`; they use
 *     `$env:FOO = "bar"`. Auto-loading `.env` removes that footgun.
 *
 * Strategy:
 *   1. If `process.env.DATABASE_URL` is already set, do nothing.
 *   2. Try `dotenv` (already in backend/node_modules) — if available, load
 *      from a sequence of candidate paths.
 *   3. Otherwise, parse inline (no dependency assumption).
 *
 * The loader is silent on success and quiet on miss; only logs in DEBUG mode.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';

const CANDIDATE_PATHS = (start: string): string[] => [
  // 1. CWD/.env
  join(process.cwd(), '.env'),
  // 2. backend/.env (relative to the calling script)
  join(start, '..', '..', '..', '..', '..', '.env'),
  join(start, '..', '..', '..', '..', '.env'),
  // 3. repo root /.env
  join(start, '..', '..', '..', '..', '..', '..', '.env'),
];

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding single/double quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

let loaded = false;
export function autoLoadEnv(callerFile = __filename): void {
  if (loaded) return;
  loaded = true;
  // Already configured: nothing to do.
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0) return;

  const start = dirname(callerFile);
  const candidates = CANDIDATE_PATHS(start);
  for (const p of candidates) {
    try {
      const abs = resolve(p);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8');
      const parsed = parseEnv(text);
      // Only assign keys that are not already set in the environment.
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      if (process.env.SAAS_ENV_DEBUG === 'true') {
        // eslint-disable-next-line no-console
        console.error(`[env] loaded ${Object.keys(parsed).length} keys from ${abs}`);
      }
      return;
    } catch {
      /* try next candidate */
    }
  }
  // No file found — leave env as-is.
}

/** Helper to format a friendly error message that works on every shell. */
export function formatDatabaseUrlMissingMessage(): string {
  const examples = [
    'bash / zsh:    export DATABASE_URL=postgres://user:pass@host:5432/db',
    'PowerShell:    $env:DATABASE_URL = "postgres://user:pass@host:5432/db"',
    'cmd.exe:       set DATABASE_URL=postgres://user:pass@host:5432/db',
    'inline arg:    --db=postgres://user:pass@host:5432/db',
    'or:            create backend/.env with DATABASE_URL=...',
  ];
  return [
    'DATABASE_URL is not set.',
    '',
    'Set it via one of:',
    ...examples.map((s) => '  ' + s),
  ].join('\n');
}
