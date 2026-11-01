import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Version-aware PostgreSQL client-tool resolution.
 *
 * Root cause of the production backup 500: the server runs PostgreSQL 18.6 but
 * the host's default /usr/bin/pg_dump was 17.7, and the old resolver picked
 * /usr/bin first — so pg_dump aborted with "server version mismatch". pg_dump
 * refuses to dump a server whose major version is NEWER than the client.
 *
 * This resolver enumerates every candidate bin directory and picks the first
 * whose pg_dump major version is >= the server major (preferring an exact
 * match), honouring PG_BIN_PATH as an explicit override. It returns an
 * actionable error when nothing adequate is installed, instead of letting
 * pg_dump fail deep inside a spawn.
 */

export interface PgTools {
  bindir: string;
  pgDump: string;
  pgRestore: string;
  psql: string;
  pgDumpall: string;
  clientMajor: number;
  clientVersion: string;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

function binMajor(pgDumpPath: string): number | null {
  try {
    const out = execFileSync(pgDumpPath, ['--version'], { encoding: 'utf8' });
    const m = out.match(/(\d+)(?:\.\d+)?/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function cleanVersion(pgDumpPath: string): string {
  try {
    const out = execFileSync(pgDumpPath, ['--version'], { encoding: 'utf8' });
    const m = out.match(/\d+(?:\.\d+)+/);
    return m ? m[0] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Candidate bin directories, highest-likelihood first. */
function candidateBindirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PG_BIN_PATH) dirs.push(process.env.PG_BIN_PATH);

  // PGDG / distro versioned installs — newest first.
  for (const root of ['/usr/lib/postgresql', '/usr/pgsql']) {
    try {
      const vers = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => parseFloat(b) - parseFloat(a));
      for (const v of vers) dirs.push(path.join(root, v, 'bin'));
    } catch {
      /* not present */
    }
  }
  // Homebrew keg-only installs.
  try {
    for (const d of fs.readdirSync('/opt/homebrew/opt')) {
      if (/^postgresql@\d+/.test(d)) dirs.push(`/opt/homebrew/opt/${d}/bin`);
    }
  } catch {
    /* not present */
  }
  dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');

  // Windows installs.
  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      try {
        const vers = fs
          .readdirSync(root)
          .filter((d) => /^\d+/.test(d))
          .sort((a, b) => parseFloat(b) - parseFloat(a));
        for (const v of vers) dirs.push(`${root}\\${v}\\bin`);
      } catch {
        /* ignore */
      }
    }
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) dirs.push(d);
  return dirs;
}

export class PgToolError extends Error {}

/**
 * Resolve a version-correct toolchain. Pass the server's major version so we
 * can guarantee pg_dump >= server. Omit it (e.g. offline restore) to take the
 * newest client available.
 */
export function resolvePgTools(serverMajor?: number): PgTools {
  let best: { dir: string; major: number } | null = null;
  let exact: string | null = null;
  const seen = new Set<string>();
  let highest = 0;

  for (const dir of candidateBindirs()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pgDump = path.join(dir, `pg_dump${EXE}`);
    if (!fs.existsSync(pgDump)) continue;
    const major = binMajor(pgDump);
    if (major == null) continue;
    if (major > highest) highest = major;
    if (serverMajor && major === serverMajor && !exact) exact = dir;
    if (!best || major > best.major) best = { dir, major };
  }

  let chosen: { dir: string; major: number } | null = null;
  if (exact) chosen = { dir: exact, major: serverMajor! };
  else if (serverMajor && best && best.major >= serverMajor) chosen = best;
  else if (!serverMajor && best) chosen = best;

  if (!chosen) {
    throw new PgToolError(
      `No pg_dump found whose major version >= server major (${serverMajor ?? 'unknown'}). ` +
        `Highest client available: ${highest || 'none'}. ` +
        `Install the matching client (e.g. postgresql-client-${serverMajor ?? 18}) or set PG_BIN_PATH. ` +
        `See deploy/provision-postgres-client-18.sh.`,
    );
  }

  const pgDump = path.join(chosen.dir, `pg_dump${EXE}`);
  return {
    bindir: chosen.dir,
    pgDump,
    pgRestore: path.join(chosen.dir, `pg_restore${EXE}`),
    psql: path.join(chosen.dir, `psql${EXE}`),
    pgDumpall: path.join(chosen.dir, `pg_dumpall${EXE}`),
    clientMajor: chosen.major,
    clientVersion: cleanVersion(pgDump),
  };
}

/**
 * Toolchain selection for RESTORE. Unlike backup (newer client than server is
 * safe), restoring with a pg_restore whose major differs from the TARGET server
 * is risky, so we PREFER an exact match to the target major and only fall back
 * to a newer client when the operator opts in via PG_ALLOW_VERSION_SKEW=1.
 * We also refuse a client older than the archive's dump major (cannot read it).
 */
export function resolvePgToolsForRestore(targetMajor: number, archiveMajor?: number): PgTools {
  // Find an exact-major client.
  let exactDir: string | null = null;
  let highest = 0;
  const seen = new Set<string>();
  for (const dir of candidateBindirs()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pr = path.join(dir, `pg_restore${EXE}`);
    if (!fs.existsSync(pr)) continue;
    const major = binMajor(pr);
    if (major == null) continue;
    if (major > highest) highest = major;
    if (major === targetMajor && !exactDir) exactDir = dir;
  }

  let dir = exactDir;
  if (!dir) {
    if (process.env.PG_ALLOW_VERSION_SKEW === '1') {
      dir = resolvePgTools(targetMajor).bindir; // newest >= target
    } else {
      throw new PgToolError(
        `No pg_restore matching the target server major (${targetMajor}) is installed ` +
          `(highest available: ${highest || 'none'}). Install postgresql-client-${targetMajor} ` +
          `(deploy/provision-postgres-client-18.sh), or set PG_ALLOW_VERSION_SKEW=1 to override (not recommended).`,
      );
    }
  }
  const pgRestore = path.join(dir, `pg_restore${EXE}`);
  const cmaj = binMajor(pgRestore)!;
  if (archiveMajor && cmaj < archiveMajor) {
    throw new PgToolError(
      `pg_restore major ${cmaj} cannot read an archive created by pg_dump major ${archiveMajor}. Install a client >= ${archiveMajor}.`,
    );
  }
  return {
    bindir: dir,
    pgDump: path.join(dir, `pg_dump${EXE}`),
    pgRestore,
    psql: path.join(dir, `psql${EXE}`),
    pgDumpall: path.join(dir, `pg_dumpall${EXE}`),
    clientMajor: cmaj,
    clientVersion: cleanVersion(pgRestore),
  };
}
