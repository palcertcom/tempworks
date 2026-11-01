#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// snapshot-engine.mjs — bounded-resource DR snapshots stored directly in a
// separate, private object-storage bucket. Built for hosts with a small,
// ephemeral local disk and little memory (DigitalOcean App Platform: 4 GiB
// ephemeral fs, 1 GiB RAM, several instances, no volumes).
//
// Nothing is staged locally as a whole:
//   * pg_dump --format=custom streams to the backup bucket (multipart, fixed
//     part size, at most DR_PART_INFLIGHT parts in memory) while the same
//     bytes are hashed and fed to `pg_restore --data-only -f -`, whose output
//     is scanned on the fly for storage references (same MVCC snapshot).
//   * Uploaded files are stored content-addressed (blobs/sha256/<aa>/<sha>).
//     An object whose (key, ETag, size) is unchanged since a previous complete
//     snapshot is NOT transferred again; new/changed objects are streamed
//     through memory (≤ DR_MEM_OBJECT_MB) or a single temp file per worker.
//   * MANIFEST.json is written LAST: a snapshot without it does not exist.
//
// Snapshot layout  <prefix>snapshots/<package>/
//   database/{globals.sql,database-properties.sql,database.dump,rowcounts.tsv}
//   config/*, RUNBOOK.md, uploads.manifest.json, [uploads-legacy-local.manifest.json],
//   uploads.refcheck.json, CHECKSUMS.sha256, MANIFEST.json
// `materialize`/`export` rebuild exactly the package directory produced by
// backup.sh, so verify.sh and restore.sh work on it unchanged.
//
// Commands (all print JSON on stdout, logs on stderr):
//   backup --kind full|database [--label TEXT]       exit 0 ok, 4 INCOMPLETE, 5 busy
//   list                                             snapshots (from MANIFEST.json objects)
//   verify <package> [--deep]                        exit 0 verified, 3 failed
//   export <package>                                 POSIX tar of the package on stdout
//   materialize <package> <dir>                      package directory on local disk
//   cat <package> <relative-path>                    one snapshot file on stdout
//   retention --keep N [--protect a,b]               delete old snapshots + GC blobs
//   delete <package>
//
// Invoke through snapshot.sh (selects a pg toolchain matching the server and
// exports PG*). Env: DATABASE_URL (via PG*), BACKUP_SPACES_* (destination),
// DO_SPACES_* + UPLOAD_STORAGE_DRIVER (source), DR_TMP.
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
  DeleteObjectsCommand, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(BACKEND, '..');
const LOCK_KEY = 7243008153; // == BACKUP_ADVISORY_LOCK_KEY (src/backup/backup-lock.ts)

const MiB = 1 << 20;
const PART = Math.max(5, Number(process.env.DR_PART_MB || 8)) * MiB;
const PART_INFLIGHT = Math.max(1, Number(process.env.DR_PART_INFLIGHT || 2));
const CONCURRENCY = Math.max(1, Number(process.env.DR_CONCURRENCY || 4));
const MEM_OBJECT = Math.max(1, Number(process.env.DR_MEM_OBJECT_MB || 8)) * MiB;
const TMP = process.env.DR_TMP || process.env.TMPDIR || '/tmp';
// App Platform gives every instance its own container host name.
const INSTANCE = process.env.DR_INSTANCE_ID || process.env.HOSTNAME || hostname();
const PROVIDER_ROLES_RE = process.env.DR_PROVIDER_ROLES || '^(postgres|doadmin|_dodb|rdsadmin|rds_superuser|rdsrepladmin|cloudsqladmin|cloudsqlsuperuser|azure_pg_admin|azuresu|pg_.*)$';

// Recovery completeness, independent of artifact integrity (checksums):
//   COMPLETE   every required file and database prerequisite is in the backup
//   DEGRADED   internally consistent, but required files exist in NO checked
//              source (pre-existing loss) — a useful partial, never a full backup
//   INCOMPLETE a race could not be resolved, or a prerequisite could not be
//              captured — not a consistent recovery point
const RANK = { INFO: 0, COMPLETE: 0, DEGRADED: 1, INCOMPLETE: 2 };
const worst = (issues) => issues.reduce((a, i) => (RANK[i.severity] > RANK[a] ? i.severity : a), 'COMPLETE');
/** Recoverability of a manifest (older manifests only have `complete`). */
const recoverabilityOf = (m) => m.recoverability || (m.complete === false ? 'INCOMPLETE' : 'COMPLETE');

const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const log = (m) => process.stderr.write(`${ts()} [dr] ${m}\n`);
const warn = (m) => process.stderr.write(`${ts()} [dr][WARN] ${m}\n`);
class Fatal extends Error { constructor(m, code = 1) { super(m); this.code = code; } }
const human = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = Number(b || 0);
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return i ? `${n.toFixed(2)} ${u[i]}` : `${n} B`;
};
const truthy = (v) => v === '1' || v === 'true';
const clean = (e) => (e?.ETag || e || '').toString().replace(/"/g, '');
const is404 = (e) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

// ── Clients ──────────────────────────────────────────────────────────────────
// We do our own end-to-end SHA-256, so S3 "flexible checksums" are only sent
// when an operation requires them (several S3-compatible providers reject the
// newer x-amz-checksum-* headers on multipart uploads).
function s3(endpoint, region, accessKeyId, secretAccessKey, pathStyle) {
  return new S3Client({
    endpoint, region, forcePathStyle: pathStyle,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function destination() {
  const E = process.env;
  const endpoint = E.BACKUP_SPACES_ENDPOINT || E.DO_SPACES_ENDPOINT;
  const region = E.BACKUP_SPACES_REGION || E.DO_SPACES_REGION;
  const bucket = E.BACKUP_SPACES_BUCKET;
  const key = E.BACKUP_SPACES_ACCESS_KEY || E.DO_SPACES_ACCESS_KEY;
  const secret = E.BACKUP_SPACES_SECRET_KEY || E.DO_SPACES_SECRET_KEY;
  if (!bucket) throw new Fatal('BACKUP_SPACES_BUCKET is not set — no backup destination configured');
  if (!endpoint || !region || !key || !secret) throw new Fatal('backup destination endpoint/region/credentials incomplete');
  // The backup destination must never be the live upload bucket: a bug, a
  // compromised app key or an accidental lifecycle rule must not be able to
  // destroy the data and its backups together.
  if (E.DO_SPACES_BUCKET && bucket === E.DO_SPACES_BUCKET &&
      (endpoint || '').replace(/\/+$/, '') === (E.DO_SPACES_ENDPOINT || '').replace(/\/+$/, '')) {
    throw new Fatal(`backup destination '${bucket}' is the live upload bucket — configure a separate private bucket (BACKUP_SPACES_BUCKET)`);
  }
  const prefix = (E.BACKUP_SPACES_PREFIX ?? 'dr/').replace(/^\/+|\/+$/g, '');
  return {
    bucket, prefix: prefix ? `${prefix}/` : '', endpoint,
    sharedCredentials: !E.BACKUP_SPACES_ACCESS_KEY,
    client: s3(endpoint, region, key, secret, truthy(E.BACKUP_SPACES_FORCE_PATH_STYLE || E.DO_SPACES_FORCE_PATH_STYLE)),
  };
}

function liveBucket() {
  const E = process.env;
  for (const k of ['DO_SPACES_ENDPOINT', 'DO_SPACES_REGION', 'DO_SPACES_BUCKET', 'DO_SPACES_ACCESS_KEY', 'DO_SPACES_SECRET_KEY'])
    if (!E[k]) throw new Fatal(`missing env ${k} (driver=spaces)`);
  return {
    bucket: E.DO_SPACES_BUCKET,
    client: s3(E.DO_SPACES_ENDPOINT, E.DO_SPACES_REGION, E.DO_SPACES_ACCESS_KEY, E.DO_SPACES_SECRET_KEY, truthy(E.DO_SPACES_FORCE_PATH_STYLE)),
  };
}

// ── Small S3 helpers ─────────────────────────────────────────────────────────
async function* listAll(client, Bucket, Prefix) {
  let ContinuationToken;
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const o of out.Contents || []) yield o;
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

async function getText(client, Bucket, Key) {
  const r = await client.send(new GetObjectCommand({ Bucket, Key }));
  return Buffer.from(await r.Body.transformToByteArray()).toString('utf8');
}

async function putSmall(client, Bucket, Key, body, ContentType = 'application/octet-stream') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  await client.send(new PutObjectCommand({ Bucket, Key, Body: buf, ContentType }));
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function deleteKeys(client, Bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (chunk.length) await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
  }
}

/**
 * Bounded-memory streaming upload: holds at most one part being filled plus
 * PART_INFLIGHT parts in flight. Hashes every byte (SHA-256) as it passes.
 */
class StreamUpload {
  constructor(client, Bucket, Key, ContentType) {
    Object.assign(this, { client, Bucket, Key, ContentType });
    this.chunks = []; this.len = 0; this.parts = []; this.inflight = new Set();
    this.uploadId = null; this.error = null; this.hash = createHash('sha256'); this.bytes = 0;
  }
  async write(chunk) {
    if (this.error) throw this.error;
    this.hash.update(chunk); this.bytes += chunk.length;
    this.chunks.push(chunk); this.len += chunk.length;
    while (this.len >= PART) await this.flush(PART);
  }
  async flush(size) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.len);
    const body = Buffer.from(all.subarray(0, size));
    const rest = all.subarray(size);
    this.chunks = rest.length ? [Buffer.from(rest)] : []; this.len = rest.length;
    if (!this.uploadId) {
      const r = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.Bucket, Key: this.Key, ContentType: this.ContentType }));
      this.uploadId = r.UploadId;
    }
    while (this.inflight.size >= PART_INFLIGHT) await Promise.race(this.inflight);
    if (this.error) throw this.error;
    const PartNumber = this.parts.length + 1;
    this.parts.push(null);
    const t = this.client.send(new UploadPartCommand({ Bucket: this.Bucket, Key: this.Key, UploadId: this.uploadId, PartNumber, Body: body }))
      .then((r) => { this.parts[PartNumber - 1] = { PartNumber, ETag: r.ETag }; })
      .catch((e) => { this.error ??= e; })
      .finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }
  async end() {
    if (!this.uploadId) {
      const body = Buffer.concat(this.chunks, this.len);
      await this.client.send(new PutObjectCommand({ Bucket: this.Bucket, Key: this.Key, Body: body, ContentType: this.ContentType }));
    } else {
      if (this.len > 0) await this.flush(this.len);
      await Promise.all(this.inflight);
      if (this.error) throw this.error;
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.Bucket, Key: this.Key, UploadId: this.uploadId, MultipartUpload: { Parts: this.parts },
      }));
    }
    this.chunks = [];
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }
  async abort() {
    if (this.uploadId) await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.Bucket, Key: this.Key, UploadId: this.uploadId })).catch(() => undefined);
  }
}

// ── Child processes ──────────────────────────────────────────────────────────
const children = new Set();
function run(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: opts.stdio || ['ignore', 'pipe', 'pipe'], env: process.env });
  children.add(c);
  let stderr = '';
  c.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  c.done = new Promise((res) => c.on('close', (code, sig) => { children.delete(c); res({ code: code ?? (sig ? 128 : 1), stderr }); }));
  c.on('error', (e) => { stderr += String(e?.message || e); });
  return c;
}
async function capture(cmd, args) {
  const c = run(cmd, args);
  const out = [];
  c.stdout.on('data', (d) => out.push(d));
  const r = await c.done;
  return { ...r, stdout: Buffer.concat(out).toString('utf8') };
}
const tool = (name) => process.env[name] || { PGDUMP: 'pg_dump', PGDUMPALL: 'pg_dumpall', PGRESTORE: 'pg_restore', PSQL: 'psql' }[name];
async function sql(query) {
  const r = await capture(tool('PSQL'), ['-X', '-q', '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', query]);
  if (r.code !== 0) throw new Fatal(`psql failed: ${r.stderr.trim().split('\n').pop()}`);
  return r.stdout.replace(/\n$/, '');
}
async function sqlFile(path) {
  const r = await capture(tool('PSQL'), ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', path]);
  if (r.code !== 0) throw new Fatal(`psql failed: ${r.stderr.trim().split('\n').pop()}`);
  return r.stdout.trim();
}
const testFail = (stage) => { if (process.env.DR_TEST_FAIL_STAGE === stage) throw new Fatal(`[test hook] injected failure at stage ${stage}`, 97); };

async function writeTo(stream, chunk) {
  if (!stream || stream.destroyed || stream.writableEnded) return;
  if (stream.write(chunk)) return;
  await new Promise((res) => {
    const done = () => { stream.off('drain', done); stream.off('close', done); stream.off('error', done); res(); };
    stream.on('drain', done); stream.on('close', done); stream.on('error', done);
  });
}

// ── Cross-instance lock (same key as the app) ────────────────────────────────
// A psql session holds pg_try_advisory_lock for the whole operation. Server-side
// TCP keepalives are shortened for THIS session so that, if the host is killed
// (redeploy/scale-in SIGKILL), PostgreSQL drops the session and releases the
// lock in about a minute instead of after the OS default (~2 h).
async function takeLock() {
  if (truthy(process.env.DR_LOCK_HELD)) return { release: async () => undefined };
  const c = spawn(tool('PSQL'), ['-X', '-q', '-tA'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const lines = []; const waiters = []; let ended = false; let buf = '';
  c.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) (waiters.shift() || ((x) => lines.push(x)))(l); }
  });
  c.on('close', () => { ended = true; while (waiters.length) waiters.shift()(null); });
  const ask = (q) => new Promise((res) => { if (ended) return res(null); waiters.push(res); c.stdin.write(q + '\n'); });
  c.stdin.write('SET tcp_keepalives_idle = 20; SET tcp_keepalives_interval = 10; SET tcp_keepalives_count = 3;\n');
  // A purge holds the lock in SHARED mode for a few seconds: wait for it. An
  // EXCLUSIVE holder is a real backup/restore: give up at once (exit 5).
  const deadline = Date.now() + Number(process.env.DR_LOCK_WAIT_SECS ?? 60) * 1000;
  for (;;) {
    const got = await ask(`SELECT pg_try_advisory_lock(${LOCK_KEY});`);
    if (got === null) throw new Fatal('lock session ended unexpectedly (database unreachable?)');
    if (got === 't') break;
    const excl = await ask(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted AND objsubid=1 AND ((classid::bigint << 32) | objid::bigint) = ${LOCK_KEY};`);
    if (excl !== '0' || Date.now() > deadline) { c.stdin.end(); throw new Fatal('another backup/restore holds the operation lock', 5); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { release: async () => { if (ended) return; c.stdin.end(`SELECT pg_advisory_unlock(${LOCK_KEY});\n\\q\n`); await new Promise((r) => c.on('close', r)); } };
}

// ── Storage reference scanner (port of lib/refcheck.py) ──────────────────────
const STOP = `[^\\s"'\\\\,)\\]}]+`;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unq = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
class RefScanner {
  constructor(base) {
    this.base = (base || '').replace(/\/+$/, '');
    this.reObj = this.base ? new RegExp(`${reEsc(this.base)}/(${STOP})`, 'g') : null;
    this.reLoc = new RegExp(`(?<![A-Za-z0-9:/])/uploads/(${STOP})`, 'g');
    this.refs = new Map(); this.carry = ''; this.dec = new StringDecoder('utf8');
  }
  scan(text) {
    if (this.reObj) for (const m of text.matchAll(this.reObj)) this.refs.set(`object\0${unq(m[1])}`, `${this.base}/${m[1]}`);
    for (const m of text.matchAll(this.reLoc)) this.refs.set(`local\0${unq(m[1])}`, `/uploads/${m[1]}`);
  }
  push(chunk) {
    const s = this.carry + this.dec.write(chunk);
    // Cut at the last separator: a reference never contains one, so no match
    // can straddle the cut. Long separator-free runs (bytea hex) are trimmed.
    const cut = s.search(/[\s"'\\,)\]}][^\s"'\\,)\]}]*$/);
    if (cut < 0) { this.carry = s.length > MiB ? s.slice(-8192) : s; return; }
    this.scan(s.slice(0, cut + 1)); this.carry = s.slice(cut + 1);
    if (this.carry.length > MiB) this.carry = this.carry.slice(-8192);
  }
  end() { this.scan(this.carry + this.dec.end()); this.carry = ''; return this.refs; }
}

// ── Upload sources ───────────────────────────────────────────────────────────
// token: object storage = ETag, local files = "<size>:<mtime_ns>" (as backup.sh)
function spacesSource() {
  const { client, bucket } = liveBucket();
  return {
    label: `s3://${bucket}`,
    async list() {
      const m = new Map();
      for await (const o of listAll(client, bucket, undefined)) if (o.Key && !o.Key.endsWith('/')) m.set(o.Key, { token: clean(o.ETag), size: Number(o.Size || 0) });
      return m;
    },
    async open(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { stream: r.Body, token: clean(r.ETag), size: Number(r.ContentLength || 0), contentType: r.ContentType || null, metadata: r.Metadata || {} };
    },
  };
}
function localSource(root) {
  return {
    label: root,
    async list() {
      const m = new Map();
      const walk = async (d) => {
        let ents; try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = join(d, e.name);
          if (e.isDirectory()) { if (!e.name.startsWith('.partial_')) await walk(p); continue; }
          if (e.name === '.gitkeep') continue;
          try { const st = await stat(p, { bigint: true }); m.set(relative(root, p).split('\\').join('/'), { token: `${st.size}:${st.mtimeNs}`, size: Number(st.size) }); } catch { /* vanished */ }
        }
      };
      await walk(root);
      return m;
    },
    async open(key) {
      const p = join(root, key);
      const st = await stat(p, { bigint: true });
      return { stream: createReadStream(p), token: `${st.size}:${st.mtimeNs}`, size: Number(st.size), contentType: null };
    },
  };
}

// ── Blob store (content addressed) ───────────────────────────────────────────
const blobKey = (dest, sha) => `${dest.prefix}blobs/sha256/${sha.slice(0, 2)}/${sha}`;
const snapPrefix = (dest, pkg) => `${dest.prefix}snapshots/${pkg}/`;

async function existingBlobs(dest) {
  const s = new Map();
  for await (const o of listAll(dest.client, dest.bucket, `${dest.prefix}blobs/sha256/`)) s.set(o.Key.split('/').pop(), Number(o.Size || 0));
  return s;
}

/** Index of (key, token, size) -> {sha256, contentType} from the newest snapshot. */
async function previousIndex(dest) {
  // Any committed snapshot's entries are valid content for reuse (keys are
  // write-once); completeness does not matter for de-duplication.
  const snaps = await listSnapshots(dest);
  const idx = new Map();
  if (!snaps.length) return { idx, from: null };
  const latest = snaps[0];
  for (const f of ['uploads.manifest.json', 'uploads-legacy-local.manifest.json']) {
    try {
      const m = JSON.parse(await getText(dest.client, dest.bucket, snapPrefix(dest, latest.package) + f));
      const ns = f.startsWith('uploads-legacy') ? 'local' : 'object';
      for (const e of m.files || []) idx.set(`${ns}\0${e.key}\0${e.etag ?? e.token}\0${e.size}`, { sha256: e.sha256, contentType: e.contentType ?? null, versionEvidence: e.versionEvidence ?? null });
    } catch (e) { if (!is404(e)) throw e; }
  }
  return { idx, from: latest.package };
}

// Proof that a stored copy is THE version a database reference means, usable
// when the live object is later lost: StorageService writes every object
// once (never overwritten), under a generated unique key, and records its
// SHA-256 in object metadata. If that recorded hash equals the captured
// content, the key can only ever have held these bytes.
const VERSION_EVIDENCE = 'app-write-once-unique-key';
function versionEvidenceOf(meta, sha) {
  return meta && meta['tw-write-once'] === '1' && meta['tw-unique-key'] === '1' && meta['tw-sha256'] === sha ? VERSION_EVIDENCE : null;
}

/** Store one source object as a blob. Returns its manifest entry, or null if it vanished. */
async function captureObject(dest, src, ns, key, listed, prev, blobs, stats) {
  const hit = prev.idx.get(`${ns}\0${key}\0${listed.token}\0${listed.size}`);
  if (hit && blobs.get(hit.sha256) === listed.size) {
    stats.reused++; stats.reusedBytes += listed.size;
    return { key, size: listed.size, sha256: hit.sha256, token: listed.token, contentType: hit.contentType, versionEvidence: hit.versionEvidence ?? null, reused: true };
  }
  let o;
  try { o = await src.open(key); } catch (e) {
    if (is404(e) || e?.code === 'ENOENT') { stats.vanished.push(key); return null; }
    throw e;
  }
  const h = createHash('sha256');
  let size = 0; let sha;
  if (o.size <= MEM_OBJECT) {
    const parts = [];
    for await (const c of o.stream) { h.update(c); size += c.length; parts.push(c); }
    sha = h.digest('hex');
    if (blobs.get(sha) !== size) {
      await dest.client.send(new PutObjectCommand({ Bucket: dest.bucket, Key: blobKey(dest, sha), Body: Buffer.concat(parts, size), ContentType: 'application/octet-stream' }));
      blobs.set(sha, size); stats.uploaded++; stats.uploadedBytes += size;
    }
  } else {
    // Larger than the in-memory budget: spool through ONE temp file (bounded by
    // the largest single upload), then stream it to the bucket.
    const tmp = join(TMP, `blob.${randomBytes(6).toString('hex')}`);
    try {
      const w = createWriteStream(tmp);
      for await (const c of o.stream) { h.update(c); size += c.length; await writeTo(w, c); }
      await new Promise((res, rej) => w.end((e) => (e ? rej(e) : res())));
      sha = h.digest('hex');
      if (blobs.get(sha) !== size) {
        const up = new StreamUpload(dest.client, dest.bucket, blobKey(dest, sha), 'application/octet-stream');
        try { for await (const c of createReadStream(tmp, { highWaterMark: MiB })) await up.write(c); await up.end(); }
        catch (e) { await up.abort(); throw e; }
        blobs.set(sha, size); stats.uploaded++; stats.uploadedBytes += size;
      }
    } finally { await unlink(tmp).catch(() => undefined); }
  }
  return { key, size, sha256: sha, token: o.token, contentType: o.contentType, versionEvidence: versionEvidenceOf(o.metadata, sha), reused: false };
}

async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── Missing-file resolution (no file is declared lost on one listing) ────────
const inventoryPrefix = (dest) => `${dest.prefix}legacy-inventory/`;

/**
 * Record which legacy "/uploads/<key>" files THIS instance has on its disk.
 * The files themselves are already stored as content-addressed blobs. Other
 * instances' backups resolve references from these inventories, so a file
 * that exists on only one of several App Platform instances is not lost.
 */
async function writeInventory(dest, root, files) {
  const body = { instance: INSTANCE, root, scannedAt: new Date().toISOString(),
    files: [...files.values()].map((f) => ({ key: f.key, size: f.size, sha256: f.sha256 })) };
  await putSmall(dest.client, dest.bucket, `${inventoryPrefix(dest)}${INSTANCE.replace(/[^A-Za-z0-9._-]/g, '_')}.json`, JSON.stringify(body), 'application/json');
  log(`legacy inventory for instance ${INSTANCE}: ${body.files.length} file(s) recorded`);
  return body;
}

async function readInventories(dest) {
  const out = [];
  for await (const o of listAll(dest.client, dest.bucket, inventoryPrefix(dest))) {
    if (!o.Key.endsWith('.json')) continue;
    try { out.push(JSON.parse(await getText(dest.client, dest.bucket, o.Key))); } catch (e) { warn(`unreadable inventory ${o.Key}: ${e.message}`); }
  }
  return out.sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1));
}

/** key -> newest {sha256,size,contentType,package} over EVERY committed snapshot, per namespace. */
async function snapshotFileIndex(dest) {
  const idx = { object: new Map(), local: new Map() };
  const snaps = await listSnapshots(dest); // newest first
  for (const sn of snaps) {
    for (const [f, ns] of [['uploads.manifest.json', 'object'], ['uploads-legacy-local.manifest.json', 'local']]) {
      let m; try { m = JSON.parse(await getText(dest.client, dest.bucket, snapPrefix(dest, sn.package) + f)); } catch { continue; }
      for (const e of m.files || []) {
        if (!idx[ns].has(e.key)) idx[ns].set(e.key, { sha256: e.sha256, size: e.size, contentType: e.contentType ?? null, package: sn.package,
          versionEvidence: e.recoveredFrom ? (e.versionVerified ? e.versionEvidence ?? null : null) : (e.versionEvidence ?? null), versions: new Set() });
        idx[ns].get(e.key).versions.add(e.sha256);
      }
    }
  }
  return { idx, snapshots: snaps.length };
}

/**
 * For references that no listing showed: (1) direct HEAD on the live bucket,
 * (2) other instances' legacy inventories, (3) every earlier snapshot. Found
 * files are added to the capture (with where they came from); the rest are
 * returned as unresolved with the evidence of what was checked.
 */
async function resolveDangling(dest, dangling, captured, blobs, stats, { legacyRoot }) {
  const checkedAt = new Date().toISOString();
  const recovered = []; const unresolved = []; const unverified = [];
  const live = (process.env.UPLOAD_STORAGE_DRIVER || 'local') === 'spaces' ? liveBucket() : null;
  const inventories = await readInventories(dest);
  const { idx: snapIdx, snapshots } = await snapshotFileIndex(dest);
  const add = (ns, entry) => { (captured[ns] ??= new Map()).set(entry.key, entry); };
  let heads = 0;
  for (const d of dangling) {
    const checked = [];
    if (d.ns === 'object' && live) {
      heads++;
      try {
        const h = await live.client.send(new HeadObjectCommand({ Bucket: live.bucket, Key: d.key }));
        const e = await captureObject(dest, spacesSource(), 'object', d.key, { token: clean(h.ETag), size: Number(h.ContentLength || 0) }, { idx: new Map() }, blobs, stats);
        if (e) { add('object', { ...e, recoveredFrom: 'live bucket (direct HEAD; absent from listings)' }); recovered.push({ ref: d.ref, from: 'live bucket (direct HEAD)' }); continue; }
      } catch (err) { if (!is404(err)) throw err; }
      checked.push(`live bucket s3://${live.bucket}: absent from every listing and direct HEAD → 404 at ${checkedAt}`);
    } else if (d.ns === 'object') {
      checked.push(`local upload directory on instance ${INSTANCE}: absent`);
    }
    if (d.ns === 'local') {
      checked.push(`instance ${INSTANCE}: ${legacyRoot} — absent`);
      const inv = inventories.find((i) => i.instance !== INSTANCE && (i.files || []).some((f) => f.key === d.key && blobs.get(f.sha256) === f.size));
      for (const i of inventories.filter((x) => x.instance !== INSTANCE)) checked.push(`instance ${i.instance}: ${i.root} (inventory ${i.scannedAt}) — ${i === inv ? 'PRESENT' : 'absent'}`);
      if (!inventories.some((x) => x.instance !== INSTANCE)) checked.push('no inventory from any other instance yet');
      if (inv) {
        // Legacy files on a local disk carry no write-once/unique-key guarantee:
        // the key may have been rewritten after this inventory. Keep the copy as
        // a CANDIDATE and disclose it — never count it as the required version.
        const f = inv.files.find((x) => x.key === d.key);
        const from = `instance ${inv.instance} (inventory ${inv.scannedAt})`;
        add('local', { key: d.key, size: f.size, sha256: f.sha256, token: `inventory:${inv.instance}`, contentType: null, recoveredFrom: from, versionVerified: false });
        unverified.push({ ref: d.ref, key: d.key, ns: d.ns, from, sha256: f.sha256, checked,
          reason: 'legacy local file: no evidence it is the version the database references (local keys can be rewritten; the inventory may predate a replacement)' });
        continue;
      }
    }
    const prev = snapIdx[d.ns].get(d.key);
    if (prev && blobs.get(prev.sha256) === prev.size) {
      const from = `earlier snapshot ${prev.package}`;
      // Intact blob ≠ required version. Proven only by app write-once evidence
      // recorded when that copy was captured (see VERSION_EVIDENCE).
      const proven = d.ns === 'object' && prev.versionEvidence === VERSION_EVIDENCE;
      add(d.ns, { key: d.key, size: prev.size, sha256: prev.sha256, token: `snapshot:${prev.package}`, contentType: prev.contentType,
        recoveredFrom: from, versionVerified: proven, versionEvidence: proven ? prev.versionEvidence : undefined });
      if (proven) recovered.push({ ref: d.ref, from, versionEvidence: prev.versionEvidence });
      else unverified.push({ ref: d.ref, key: d.key, ns: d.ns, from, sha256: prev.sha256, checked,
        versionsSeenInSnapshots: prev.versions.size,
        reason: d.ns === 'local'
          ? 'legacy local file: no evidence the earlier copy is the version the database references (the key may have been rewritten since)'
          : 'captured without app write-once evidence (object predates it or was written out-of-band): it may have been replaced since' });
      continue;
    }
    checked.push(`${snapshots} earlier snapshot(s): not contained`);
    unresolved.push({ ref: d.ref, key: d.key, ns: d.ns, checked });
  }
  if (recovered.length) warn(`${recovered.length} referenced file(s) absent from live storage were recovered from other sources WITH version evidence`);
  if (unverified.length) warn(`${unverified.length} referenced file(s) absent from live storage have only a CANDIDATE copy without version evidence — snapshot will be DEGRADED (candidates kept)`);
  if (unresolved.length) warn(`${unresolved.length} referenced file(s) exist in NO checked source — snapshot will be DEGRADED (evidence in uploads.refcheck.json)`);
  return { recovered, unresolved, unverified, evidence: { instance: INSTANCE, checkedAt, liveBucket: live?.bucket ?? null, directHeads: heads,
    legacyRootOnThisInstance: legacyRoot, otherInstanceInventories: inventories.filter((i) => i.instance !== INSTANCE).map((i) => ({ instance: i.instance, scannedAt: i.scannedAt, files: (i.files || []).length })),
    earlierSnapshotsSearched: snapshots } };
}

async function cmdLegacyInventory() {
  const dest = destination();
  const root = process.env.LEGACY_UPLOADS_DIR ? resolve(process.env.LEGACY_UPLOADS_DIR) : (process.env.UPLOAD_DEST ? resolve(process.env.UPLOAD_DEST) : join(BACKEND, 'uploads'));
  const src = localSource(root);
  const listed = await src.list();
  const blobs = await existingBlobs(dest);
  const stats = { reused: 0, reusedBytes: 0, uploaded: 0, uploadedBytes: 0, vanished: [] };
  const entries = await pool([...listed.keys()].sort(), CONCURRENCY, (k) => captureObject(dest, src, 'local', k, listed.get(k), { idx: new Map() }, blobs, stats));
  const inv = await writeInventory(dest, root, new Map(entries.filter(Boolean).map((e) => [e.key, e])));
  process.stdout.write(JSON.stringify({ instance: INSTANCE, root, files: inv.files.length, uploaded: stats.uploaded, scannedAt: inv.scannedAt }) + '\n');
  return 0;
}

// ── backup ───────────────────────────────────────────────────────────────────
let cleanupHook = null;

async function cmdBackup(opts) {
  const kind = opts.kind || 'database';
  if (!['full', 'database'].includes(kind)) throw new Fatal("--kind must be 'full' or 'database'");
  const dest = destination();
  if (dest.sharedCredentials) warn('backup destination uses the live upload credentials (BACKUP_SPACES_ACCESS_KEY unset) — use a separate key so a leaked app key cannot delete backups');
  const driver = process.env.UPLOAD_STORAGE_DRIVER || 'local';
  const base = driver === 'spaces' ? (process.env.DO_SPACES_PUBLIC_URL || '').replace(/\/+$/, '') : '';
  const uploadRoot = process.env.UPLOAD_DEST ? resolve(process.env.UPLOAD_DEST) : join(BACKEND, 'uploads');
  const legacyRoot = process.env.LEGACY_UPLOADS_DIR ? resolve(process.env.LEGACY_UPLOADS_DIR) : uploadRoot;

  const lock = await takeLock();
  const stamp = new Date();
  const pkg = `tempworks-dr_${stamp.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}_${randomBytes(4).toString('hex')}`;
  const P = snapPrefix(dest, pkg);
  const written = new Map(); // relative path -> {bytes, sha256}
  let dumpUpload = null;
  cleanupHook = async () => {
    await dumpUpload?.abort();
    await deleteKeys(dest.client, dest.bucket, [...written.keys()].map((r) => P + r)).catch(() => undefined);
    await lock.release().catch(() => undefined);
  };
  const put = async (rel, body, ct) => { written.set(rel, await putSmall(dest.client, dest.bucket, P + rel, body, ct)); };

  log(`DR snapshot starting: kind=${kind} package=${pkg} → s3://${dest.bucket}/${P}`);
  const serverMajor = Number(await sql('SHOW server_version_num')) / 10000 | 0;
  const clientVersion = ((await capture(tool('PGDUMP'), ['--version'])).stdout.match(/\d+(\.\d+)+/) || ['?'])[0];
  log(`source: ${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE} (server major ${serverMajor}, pg_dump ${clientVersion})`);

  const issues = []; // recovery-completeness findings → recoverability
  // 1. globals (roles/memberships/tablespaces); managed providers may refuse.
  const g = await capture(tool('PGDUMPALL'), ['--globals-only', '--no-role-passwords']);
  const globalsOk = g.code === 0;
  if (!globalsOk) warn(`pg_dumpall --globals-only refused (managed providers restrict it): ${g.stderr.trim().split('\n').pop()} — capturing the REQUIRED roles from the catalog instead`);
  await put('database/globals.sql', globalsOk ? g.stdout : '', 'application/sql');

  // 1a. Database prerequisites from catalogs readable by any role: every role
  // the database needs (owners, grantees, policy roles, the connecting role,
  // membership closure) with attributes/memberships/settings, extensions,
  // tablespaces. This is what makes a restore into a FRESH cluster possible
  // without pg_dumpall. Failure here = the backup cannot be restored → INCOMPLETE.
  let prereq = null; let prereqSummary = null;
  try {
    testFail('prereqs');
    prereq = JSON.parse(await sqlFile(join(HERE, 'lib', 'prereqs.sql')));
    const tmp = join(TMP, `prereqs.${randomBytes(4).toString('hex')}.json`);
    await writeFile(tmp, JSON.stringify(prereq));
    const rs = await capture('python3', [join(HERE, 'lib', 'prereqs.py'), 'roles-sql', tmp, PROVIDER_ROLES_RE]);
    const sm = await capture('python3', [join(HERE, 'lib', 'prereqs.py'), 'summary', tmp, PROVIDER_ROLES_RE]);
    await unlink(tmp).catch(() => undefined);
    if (rs.code !== 0 || sm.code !== 0) throw new Error(`prereqs.py failed: ${(rs.stderr || sm.stderr).trim().split('\n').pop()}`);
    prereqSummary = JSON.parse(sm.stdout);
    await put('database/prerequisites.json', JSON.stringify(prereq, null, 2), 'application/json');
    await put('database/roles.sql', rs.stdout, 'application/sql');
    log(`prerequisites: ${prereqSummary.requiredRoles.length} required role(s) [${prereqSummary.requiredRoles.join(', ')}]` +
        `${prereqSummary.providerRoles.length ? `; provider-managed: ${prereqSummary.providerRoles.join(', ')}` : ''}; extensions: ${prereqSummary.extensions.join(', ') || 'none'}`);
    if (!globalsOk) issues.push({ code: 'GLOBALS_FROM_CATALOG', severity: 'INFO', count: prereqSummary.requiredRoles.length,
      detail: 'pg_dumpall --globals-only was refused; the required roles were captured from the database catalog instead (database/roles.sql).',
      action: 'none — restore.sh --roles recreates them; LOGIN roles need their passwords from the secret store.' });
    if (prereqSummary.tablespaces.length) issues.push({ code: 'TABLESPACES_REQUIRED', severity: 'INFO', count: prereqSummary.tablespaces.length,
      detail: `objects live in non-default tablespace(s): ${prereqSummary.tablespaces.join(', ')}`,
      action: 'create these tablespaces on the target before restoring (or restore with --no-tablespaces).' });
  } catch (e) {
    warn(`database prerequisites could not be captured: ${e.message}`);
    issues.push({ code: 'PREREQ_CAPTURE_FAILED', severity: 'INCOMPLETE', count: 1,
      detail: `required roles/memberships could not be read from the catalog: ${e.message}`,
      action: 'restore into a fresh cluster cannot recreate roles; fix database access for the backup role (it must be able to read pg_roles / pg_auth_members) and back up again.' });
  }

  // 1b. database-level properties: stream pg_dump --create, keep DB-level lines only.
  const propsLines = [];
  {
    const c = run(tool('PGDUMP'), ['--create', '--schema-only', '--no-comments']);
    const dec = new StringDecoder('utf8'); let rest = '';
    const keep = /^(CREATE DATABASE|ALTER DATABASE|GRANT .* ON DATABASE|REVOKE .* ON DATABASE|ALTER ROLE .* IN DATABASE)/;
    for await (const d of c.stdout) {
      const lines = (rest + dec.write(d)).split('\n'); rest = lines.pop();
      for (const l of lines) if (keep.test(l)) propsLines.push(l);
    }
    if (keep.test(rest)) propsLines.push(rest);
    const r = await c.done;
    if (r.code !== 0) throw new Fatal(`pg_dump --create failed: ${r.stderr.trim().split('\n').pop()}`);
    if (!propsLines.some((l) => l.startsWith('CREATE DATABASE'))) throw new Fatal('could not capture CREATE DATABASE properties');
  }
  await put('database/database-properties.sql', propsLines.join('\n') + '\n', 'application/sql');
  const [dbName, dbOwner, dbEncoding, dbCollate, dbCtype, dbLocProv] = (await sql(
    "SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding), d.datcollate, d.datctype, d.datlocprovider FROM pg_database d WHERE d.datname = current_database()",
  )).split('|');

  // 2+3. Consistent capture (same protocol as backup.sh, see runbook §Consistency).
  const maxAttempts = 1 + Number(process.env.BACKUP_CONSISTENCY_RETRIES ?? 2);
  const sources = [];
  if (kind === 'full') {
    if (driver === 'spaces') {
      sources.push({ ns: 'object', manifest: 'uploads.manifest.json', dir: 'uploads', src: spacesSource(), field: 'etag' });
      // Legacy "/uploads/<key>" files live on THIS instance's disk only (App
      // Platform disks are per instance and reset on deploy). Always registered
      // so references can also be resolved from other instances' inventories.
      sources.push({ ns: 'local', manifest: 'uploads-legacy-local.manifest.json', dir: 'uploads-legacy-local', src: localSource(legacyRoot), field: 'token' });
    } else {
      sources.push({ ns: 'object', manifest: 'uploads.manifest.json', dir: 'uploads', src: localSource(uploadRoot), field: 'token' });
    }
  }
  const prev = kind === 'full' ? await previousIndex(dest) : { idx: new Map(), from: null };
  const blobs = kind === 'full' ? await existingBlobs(dest) : new Map();
  if (prev.from) log(`incremental: ${prev.idx.size} object version(s) known from ${prev.from}; ${blobs.size} blob(s) in store`);

  let attempt = 0; let dump; let refcheck = {}; let captured = {}; let stats;
  let refsSeen = null; let dangling = []; let raceMissing = []; let raceOverwritten = [];
  const everSeen = {}; // every key seen in ANY listing during this backup, per namespace
  for (;;) {
    attempt++;
    stats = { reused: 0, reusedBytes: 0, uploaded: 0, uploadedBytes: 0, vanished: [] };
    const pre = {};
    for (const s of sources) {
      pre[s.ns] = await s.src.list();
      everSeen[s.ns] ??= new Set();
      for (const k of pre[s.ns].keys()) everSeen[s.ns].add(k);
    }

    log(`streaming pg_dump (custom format) to the backup bucket [attempt ${attempt}/${maxAttempts}]…`);
    const pd = run(tool('PGDUMP'), ['--format=custom']);
    const scanner = kind === 'full' ? new RefScanner(base) : null;
    const pr = scanner ? run(tool('PGRESTORE'), ['--data-only', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] }) : null;
    pr?.stdin.on('error', () => undefined);
    const scanDone = pr ? (async () => { for await (const d of pr.stdout) scanner.push(d); })() : null;
    dumpUpload = new StreamUpload(dest.client, dest.bucket, `${P}database/database.dump`, 'application/octet-stream');
    try {
      for await (const chunk of pd.stdout) { await dumpUpload.write(chunk); await writeTo(pr?.stdin, chunk); }
      pr?.stdin.end();
      const r = await pd.done;
      if (r.code !== 0) throw new Fatal(`pg_dump failed (rc=${r.code}): ${r.stderr.trim().split('\n').pop()}`);
      dump = await dumpUpload.end();
      if (pr) { await scanDone; const rr = await pr.done; if (rr.code !== 0) throw new Fatal(`reference scan (pg_restore) failed: ${rr.stderr.trim().split('\n').pop()}`); }
    } catch (e) { await dumpUpload.abort(); pd.kill('SIGTERM'); pr?.kill('SIGTERM'); throw e; }
    dumpUpload = null;
    written.set('database/database.dump', dump);
    log(`database dump streamed: ${human(dump.bytes)} sha256=${dump.sha256}`);
    if (kind !== 'full') break;

    if (process.env.DR_TEST_PAUSE_AFTER_DUMP_SECS && attempt === 1) {
      warn(`DR_TEST_PAUSE_AFTER_DUMP_SECS=${process.env.DR_TEST_PAUSE_AFTER_DUMP_SECS} (test hook) — pausing before file capture`);
      if (process.env.DR_TEST_SIGNAL_FILE) await writeFile(process.env.DR_TEST_SIGNAL_FILE, '').catch(() => undefined);
      await new Promise((r) => setTimeout(r, Number(process.env.DR_TEST_PAUSE_AFTER_DUMP_SECS) * 1000));
    }

    // Capture every object that exists NOW (post-snapshot listing).
    captured = {};
    for (const s of sources) {
      const now = await s.src.list();
      for (const k of now.keys()) everSeen[s.ns].add(k);
      log(`capturing ${now.size} object(s) from ${s.src.label} (concurrency ${CONCURRENCY})…`);
      const keys = [...now.keys()].sort();
      const entries = await pool(keys, CONCURRENCY, (k) => captureObject(dest, s.src, s.ns, k, now.get(k), prev, blobs, stats));
      captured[s.ns] = new Map(entries.filter(Boolean).map((e) => [e.key, e]));
    }
    log(`objects: ${stats.uploaded} uploaded (${human(stats.uploadedBytes)}), ${stats.reused} unchanged & reused (${human(stats.reusedBytes)})${stats.vanished.length ? `, ${stats.vanished.length} vanished during capture` : ''}`);

    // Reference check against the dump's own snapshot.
    refsSeen = scanner.end();
    const missing = []; const overwritten = []; dangling = [];
    for (const [k, ref] of [...refsSeen.entries()].sort()) {
      const [ns0, key] = k.split('\0');
      const ns = driver === 'spaces' ? ns0 : 'object'; // local driver: "/uploads/<key>" files ARE the upload set
      if (driver === 'spaces' && ns0 === 'object' && !base) continue;
      const got = captured[ns]?.get(key);
      const before = pre[ns]?.get(key);
      if (!got) {
        // Never seen in ANY listing since this backup started: not a race —
        // resolved below from other sources (direct HEAD, other instances,
        // earlier snapshots) or reported with evidence. Anything that existed
        // during the backup and is now gone is a real race -> retry / INCOMPLETE.
        if (!everSeen[ns]?.has(key)) dangling.push({ ref, key, ns }); else missing.push(ref);
        continue;
      }
      if (before && before.token !== got.token) overwritten.push(ref);
    }
    raceMissing = missing; raceOverwritten = overwritten;
    const inconsistent = [...missing, ...overwritten];
    if (!inconsistent.length) { log(`✓ consistency: no reference changed or vanished during the backup (${refsSeen.size} referenced)`); break; }
    if (attempt < maxAttempts) { warn(`consistency: ${inconsistent.length} referenced file(s) missing or overwritten during backup — retrying capture`); continue; }
    warn(`consistency: ${inconsistent.length} referenced file(s) still missing after ${attempt} attempt(s) — snapshot will be marked INCOMPLETE`);
    break;
  }

  // 3b. References absent from every listing: try every other source before
  // calling a file missing, and record what was checked.
  let unresolved = []; const recovered = []; let unverified = []; let evidence = null;
  if (kind === 'full' && dangling.length) {
    const r = await resolveDangling(dest, dangling, captured, blobs, stats, { legacyRoot });
    unresolved = r.unresolved; recovered.push(...r.recovered); unverified = r.unverified; evidence = r.evidence;
  }
  if (kind === 'full' && driver === 'spaces' && captured.local?.size) await writeInventory(dest, legacyRoot, captured.local).catch((e) => warn(`legacy inventory not written: ${e.message}`));
  if (raceMissing.length || raceOverwritten.length) issues.push({ code: 'FILES_CHANGED_DURING_BACKUP', severity: 'INCOMPLETE',
    count: raceMissing.length + raceOverwritten.length, items: [...raceMissing, ...raceOverwritten].slice(0, 200),
    detail: `${raceMissing.length} referenced file(s) vanished and ${raceOverwritten.length} were overwritten while the backup ran, after ${attempt} attempt(s)`,
    action: 'not a consistent recovery point; back up again (deletions are deferred by the app, so this indicates an out-of-band change).' });
  if (unresolved.length) issues.push({ code: 'FILES_UNRESOLVED', severity: 'DEGRADED', count: unresolved.length, items: unresolved.slice(0, 200),
    detail: `${unresolved.length} file(s) referenced by the database exist in no checked source (see evidence in uploads.refcheck.json)`,
    action: unresolved.some((u) => u.ns === 'local')
      ? 'legacy /uploads files live on one instance disk each: call POST /api/v1/backup/legacy-inventory until every running instance has answered (the response names the instance), then back up again; anything still unresolved was lost with an earlier deployment\'s disk — see runbook §Missing files.'
      : 'check the live bucket and any other copies (versioning, other buckets, the uploader); restoring this backup leaves these references without a file — see runbook §Missing files.' });
  if (unverified.length) issues.push({ code: 'FILES_VERSION_UNVERIFIED', severity: 'DEGRADED', count: unverified.length, items: unverified.slice(0, 200),
    detail: `${unverified.length} referenced file(s) are missing from live storage; a copy was found (another instance or an earlier snapshot) and is INCLUDED as a candidate, but nothing proves it is the version the database references`,
    action: 'confirm each candidate (e.g. with the uploader or document owner) and restore it to live storage, or re-upload the file; until then this backup is not a complete recovery point — see runbook §Missing files.' });
  if (recovered.length) issues.push({ code: 'LIVE_STORAGE_MISSING_RECOVERED', severity: 'INFO', count: recovered.length, items: recovered.slice(0, 200),
    detail: `${recovered.length} referenced file(s) are missing from live storage but were taken from an earlier snapshot WITH version evidence (app write-once object, unique key, recorded SHA-256 matches); the backup contains them`,
    action: 'restore them into live storage from this snapshot (materialize, then copy) — the running application cannot serve them today.' });
  refcheck = {
    referenced: refsSeen?.size ?? 0, engine: 'stream', overwriteCheck: true, consistencyAttempts: attempt,
    missingCount: raceMissing.length + raceOverwritten.length + unresolved.length + unverified.length,
    missing: [...raceMissing, ...raceOverwritten, ...unresolved.map((u) => u.ref)].slice(0, 200),
    absentCount: raceMissing.length, overwrittenCount: raceOverwritten.length, overwritten: raceOverwritten.slice(0, 200),
    unresolvedCount: unresolved.length, unresolved: unresolved.slice(0, 200),
    recoveredFromOtherSources: recovered.slice(0, 200), recoveredCount: recovered.length,
    versionUnverified: unverified.slice(0, 200), versionUnverifiedCount: unverified.length,
    // kept for older readers: "dangling" = unresolved after every source was checked
    danglingCount: unresolved.length, dangling: unresolved.map((u) => u.ref).slice(0, 200),
    evidence,
    capturedObjects: captured.object?.size ?? 0, capturedLegacyLocal: captured.local?.size ?? 0,
  };
  const recoverability = worst(issues);
  refcheck.recoverability = recoverability;
  refcheck.complete = recoverability === 'COMPLETE';
  const complete = recoverability === 'COMPLETE';

  // 4. manifests, config, rowcounts
  let uploadsCount = 0; let uploadsBytes = 0; let legacyCount = 0;
  const checksumLines = [];
  for (const s of sources) {
    const files = [...(captured[s.ns]?.values() || [])].map((e) => ({ key: e.key, size: e.size, sha256: e.sha256, [s.field]: e.token, contentType: e.contentType ?? undefined, versionEvidence: e.versionEvidence ?? undefined,
      recoveredFrom: e.recoveredFrom, versionVerified: e.recoveredFrom ? e.versionVerified : undefined }));
    const man = s.ns === 'object'
      ? { driver: driver === 'spaces' ? 'spaces' : 'local', ...(driver === 'spaces' ? { bucket: process.env.DO_SPACES_BUCKET } : {}), count: files.length, files, vanishedDuringCapture: stats.vanished, blobStore: `${dest.prefix}blobs/sha256/` }
      : { driver: 'legacy-local', count: files.length, files, blobStore: `${dest.prefix}blobs/sha256/` };
    await put(s.manifest, JSON.stringify(man), 'application/json');
    for (const f of files) checksumLines.push(`${f.sha256}  ./${s.dir}/${f.key}`);
    if (s.ns === 'object') { uploadsCount = files.length; uploadsBytes = files.reduce((a, f) => a + f.size, 0); } else legacyCount = files.length;
  }
  if (kind === 'full') await put('uploads.refcheck.json', JSON.stringify(refcheck) + '\n', 'application/json');

  const rowcounts = await sql('SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname').catch(() => '');
  await put('database/rowcounts.tsv', rowcounts ? `${rowcounts}\n` : '', 'text/tab-separated-values');
  for (const [src, rel] of [[join(BACKEND, '.env.example'), 'config/backend.env.example'], [join(REPO_ROOT, '.env.example'), 'config/frontend.env.example'], [join(BACKEND, 'prisma', 'schema.prisma'), 'config/schema.prisma']]) {
    if (existsSync(src)) await put(rel, await readFile(src), 'text/plain');
  }
  const gitSha = process.env.APP_GIT_SHA || (await capture('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim() || 'unknown';
  let appVersion = 'unknown';
  try { appVersion = JSON.parse(await readFile(join(BACKEND, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  await put('config/release.txt', `appVersion=${appVersion}\ngitSha=${gitSha}\ncapturedAt=${ts()}\n`, 'text/plain');
  const pointer = join(HERE, 'RUNBOOK_POINTER.txt');
  await put('RUNBOOK.md', existsSync(pointer) ? await readFile(pointer) : `See docs/DISASTER_RECOVERY_RUNBOOK.md in the TempWorks repository (gitSha ${gitSha}).\n`, 'text/markdown');

  const manifest = {
    manifestVersion: '1.0', package: pkg, kind, createdAt: stamp.toISOString().replace(/\.\d+Z$/, 'Z'),
    label: opts.label || '', consistency: 'online-snapshot', engine: 'stream',
    source: { host: process.env.PGHOST, database: process.env.PGDATABASE, serverMajor, clientVersion },
    app: { version: appVersion, gitSha },
    components: {
      globals: { file: 'database/globals.sql', captured: globalsOk, bytes: written.get('database/globals.sql').bytes, sha256: written.get('database/globals.sql').sha256, error: globalsOk ? '' : g.stderr.trim().slice(-300) },
      database: { file: 'database/database.dump', format: 'custom', bytes: dump.bytes, sha256: dump.sha256, includesOwners: true, includesAcls: true, includesLargeObjects: true },
      uploads: {
        included: kind === 'full', driver, count: uploadsCount, bytes: uploadsBytes, manifest: 'uploads.manifest.json',
        legacyLocalCount: legacyCount, dbReferencedObjects: refcheck.referenced ?? 0,
        unresolvedReferences: refcheck.unresolvedCount ?? 0, danglingReferences: refcheck.unresolvedCount ?? 0,
        recoveredFromOtherSources: refcheck.recoveredCount ?? 0,
        complete: kind === 'full' ? !issues.some((i) => i.code.startsWith('FILES_') && i.severity !== 'INFO') : undefined,
        consistencyAttempts: attempt, refcheck: 'uploads.refcheck.json',
        transfer: kind === 'full' ? { uploaded: stats.uploaded, uploadedBytes: stats.uploadedBytes, reused: stats.reused, reusedBytes: stats.reusedBytes, previousSnapshot: prev.from } : undefined,
      },
      rowcounts: { file: 'database/rowcounts.tsv', tables: rowcounts ? rowcounts.split('\n').length : 0 },
      databaseProperties: { file: 'database/database-properties.sql', name: dbName, owner: dbOwner, encoding: dbEncoding, collate: dbCollate, ctype: dbCtype, localeProvider: dbLocProv },
      prerequisites: prereqSummary
        ? { file: 'database/prerequisites.json', rolesSql: 'database/roles.sql', captured: true, method: globalsOk ? 'catalog (+ pg_dumpall globals)' : 'catalog (pg_dumpall refused)', ...prereqSummary,
            note: 'LOGIN roles are recreated WITHOUT passwords — set them from the secret store; provider-managed roles must exist on the target or be mapped (restore.sh --role-map).' }
        : { captured: false },
    },
    storage: { driver, publicBaseUrl: base || '/uploads', note: 'fileUrl columns store this base; restore.sh rewrites it to the recovery storage base' },
    // Recovery completeness (what a restore will contain) — independent of
    // artifact integrity, which verify establishes from the stored bytes.
    recoverability, complete, recoveryIssues: issues,
    catalogId: process.env.BACKUP_CATALOG_ID || '', restoreWith: 'backend/scripts/dr/restore.sh (after snapshot.sh materialize)',
    location: `s3://${dest.bucket}/${P}`,
  };
  const manifestBody = JSON.stringify(manifest, null, 2);
  const manifestSha = createHash('sha256').update(manifestBody).digest('hex');
  for (const [rel, w] of written) checksumLines.push(`${w.sha256}  ./${rel}`);
  checksumLines.push(`${manifestSha}  ./MANIFEST.json`);
  checksumLines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  await put('CHECKSUMS.sha256', checksumLines.join('\n') + '\n', 'text/plain');
  await put('MANIFEST.json', manifestBody, 'application/json'); // commit point
  cleanupHook = async () => { await lock.release().catch(() => undefined); };
  log(`snapshot committed: s3://${dest.bucket}/${P}`);

  // 5. Independent verification of what is actually stored remotely.
  let offsiteStatus = 'UPLOADED';
  try {
    const v = await verifySnapshot(dest, pkg, { deep: false });
    offsiteStatus = v.integrity === 'OK' ? 'VERIFIED' : 'VERIFY_FAILED';
    log(v.integrity === 'OK' ? 'stored snapshot integrity verified (dump re-read + sha256, archive readable, every blob present).' : `stored snapshot integrity FAILED: ${v.problems.slice(0, 5).join('; ')}`);
  } catch (e) { offsiteStatus = 'VERIFY_FAILED'; warn(`verification error: ${e.message}`); }
  await lock.release();
  cleanupHook = null;

  const result = {
    package: pkg, dir: null, artifact: manifest.location, engine: 'stream', kind,
    databaseSha256: dump.sha256, databaseBytes: dump.bytes, globalsCaptured: globalsOk,
    uploadsIncluded: kind === 'full', uploadsCount, uploadsBytes, uploadsComplete: complete,
    danglingReferences: refcheck.unresolvedCount ?? 0, unresolvedReferences: refcheck.unresolvedCount ?? 0,
    recoverability, recoveryIssues: issues, prerequisitesCaptured: !!prereqSummary, consistencyAttempts: attempt,
    transfer: manifest.components.uploads.transfer ?? null,
    offsiteStatus, offsiteLocation: manifest.location, manifest,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  if (offsiteStatus !== 'VERIFIED') return 3;                       // integrity first
  for (const i of issues.filter((x) => x.severity !== 'INFO')) process.stderr.write(`${ts()} [dr][ERROR] ${i.severity} ${i.code}: ${i.detail} — ${i.action}\n`);
  if (recoverability === 'INCOMPLETE') { process.stderr.write(`${ts()} [dr][ERROR] DR snapshot INCOMPLETE — not a usable recovery point (integrity of the stored copy is fine).\n`); return 4; }
  if (recoverability === 'DEGRADED') { process.stderr.write(`${ts()} [dr][ERROR] DR snapshot DEGRADED — consistent, but NOT a complete recovery point; kept as a partial backup.\n`); return 6; }
  log('DR snapshot finished OK — COMPLETE recovery point.');
  return 0;
}

// ── list / verify ────────────────────────────────────────────────────────────
async function listSnapshots(dest) {
  const out = [];
  for await (const o of listAll(dest.client, dest.bucket, `${dest.prefix}snapshots/`)) {
    if (!o.Key.endsWith('/MANIFEST.json')) continue;
    try {
      const m = JSON.parse(await getText(dest.client, dest.bucket, o.Key));
      out.push({
        package: m.package, kind: m.kind, createdAt: m.createdAt, recoverability: recoverabilityOf(m), complete: recoverabilityOf(m) === 'COMPLETE', label: m.label,
        recoveryIssues: (m.recoveryIssues || []).map((i) => ({ code: i.code, severity: i.severity, count: i.count })),
        catalogId: m.catalogId || null, databaseBytes: m.components?.database?.bytes ?? 0, databaseSha256: m.components?.database?.sha256 ?? null,
        uploadsCount: m.components?.uploads?.count ?? 0, uploadsBytes: m.components?.uploads?.bytes ?? 0,
        danglingReferences: m.components?.uploads?.unresolvedReferences ?? m.components?.uploads?.danglingReferences ?? 0, serverMajor: m.source?.serverMajor ?? null,
        location: `s3://${dest.bucket}/${o.Key.replace(/MANIFEST\.json$/, '')}`,
      });
    } catch (e) { warn(`unreadable manifest ${o.Key}: ${e.message}`); }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function hashObject(dest, Key, sink) {
  const r = await dest.client.send(new GetObjectCommand({ Bucket: dest.bucket, Key }));
  const h = createHash('sha256'); let n = 0;
  for await (const c of r.Body) { h.update(c); n += c.length; if (sink) await writeTo(sink, c); }
  return { sha256: h.digest('hex'), bytes: n };
}

async function verifySnapshot(dest, pkg, { deep }) {
  const P = snapPrefix(dest, pkg);
  const problems = []; const checks = [];
  let m;
  try { m = JSON.parse(await getText(dest.client, dest.bucket, P + 'MANIFEST.json')); }
  catch (e) { return { package: pkg, verified: false, problems: [is404(e) ? 'MANIFEST.json missing — snapshot does not exist or never committed' : `MANIFEST.json unreadable: ${e.message}`], checks }; }
  const sums = new Map();
  try {
    for (const l of (await getText(dest.client, dest.bucket, P + 'CHECKSUMS.sha256')).split('\n')) {
      const mm = l.match(/^([0-9a-f]{64})  \.\/(.+)$/); if (mm) sums.set(mm[2], mm[1]);
    }
  } catch { problems.push('CHECKSUMS.sha256 missing'); }
  const mSha = createHash('sha256').update(await getText(dest.client, dest.bucket, P + 'MANIFEST.json')).digest('hex');
  if (sums.get('MANIFEST.json') !== mSha) problems.push('MANIFEST.json checksum mismatch');

  // Database dump: full re-read, sha256, and a complete archive parse.
  const pr = run(tool('PGRESTORE'), ['-f', '/dev/null'], { stdio: ['pipe', 'ignore', 'pipe'] });
  pr.stdin.on('error', () => undefined);
  const d = await hashObject(dest, P + 'database/database.dump', pr.stdin).catch((e) => ({ error: e.message }));
  pr.stdin.end();
  const prr = await pr.done;
  if (d.error) problems.push(`database.dump unreadable: ${d.error}`);
  else if (d.sha256 !== m.components.database.sha256 || d.bytes !== m.components.database.bytes) problems.push('database.dump sha256/size mismatch');
  else checks.push(`database.dump ${human(d.bytes)} sha256 ok`);
  if (prr.code !== 0) problems.push(`database.dump is not a complete readable archive: ${prr.stderr.trim().split('\n').pop()}`);
  else checks.push('database.dump parsed completely by pg_restore');

  // Every other non-upload file listed in CHECKSUMS.
  for (const [rel, want] of sums) {
    if (rel === 'MANIFEST.json' || rel === 'database/database.dump' || rel.startsWith('uploads/') || rel.startsWith('uploads-legacy-local/')) continue;
    const got = await hashObject(dest, P + rel).catch(() => null);
    if (!got) problems.push(`${rel} missing`); else if (got.sha256 !== want) problems.push(`${rel} checksum mismatch`);
  }
  // Uploads: every manifest entry's blob exists with the right size (deep: re-hash).
  if (m.kind === 'full') {
    const blobs = await existingBlobs(dest);
    let n = 0; let bad = 0;
    for (const f of ['uploads.manifest.json', 'uploads-legacy-local.manifest.json']) {
      let man; try { man = JSON.parse(await getText(dest.client, dest.bucket, P + f)); } catch (e) { if (f === 'uploads.manifest.json') problems.push(`${f} missing`); continue; }
      const dir = f.startsWith('uploads-legacy') ? 'uploads-legacy-local' : 'uploads';
      await pool(man.files || [], CONCURRENCY, async (e) => {
        n++;
        if (sums.get(`${dir}/${e.key}`) !== e.sha256) { bad++; problems.push(`checksum list disagrees for ${dir}/${e.key}`); return; }
        if (blobs.get(e.sha256) !== e.size) { bad++; problems.push(`blob missing/size mismatch for ${dir}/${e.key}`); return; }
        if (deep) { const got = await hashObject(dest, blobKey(dest, e.sha256)); if (got.sha256 !== e.sha256) { bad++; problems.push(`blob content mismatch for ${dir}/${e.key}`); } }
      });
    }
    checks.push(`uploads: ${n} file(s), ${bad} problem(s)${deep ? ' (deep re-hash)' : ' (presence+size)'}`);
  }
  // Two separate answers: are the stored bytes intact (integrity), and does
  // the backup contain everything a recovery needs (recoverability)?
  const integrity = problems.length === 0 ? 'OK' : 'FAILED';
  const recoverability = recoverabilityOf(m);
  return { package: pkg, integrity, recoverability, verified: integrity === 'OK' && recoverability === 'COMPLETE',
    deep: !!deep, problems: problems.slice(0, 50), checks, complete: recoverability === 'COMPLETE', kind: m.kind,
    recoveryIssues: (m.recoveryIssues || []).filter((i) => i.severity !== 'INFO').map((i) => ({ code: i.code, severity: i.severity, count: i.count, detail: i.detail, action: i.action })) };
}

// ── export / materialize / cat ───────────────────────────────────────────────
// Entries of the package directory with where their bytes live.
async function packageEntries(dest, pkg) {
  const P = snapPrefix(dest, pkg);
  const m = JSON.parse(await getText(dest.client, dest.bucket, P + 'MANIFEST.json'));
  const out = [];
  for await (const o of listAll(dest.client, dest.bucket, P)) out.push({ rel: o.Key.slice(P.length), size: Number(o.Size), key: o.Key });
  for (const f of ['uploads.manifest.json', 'uploads-legacy-local.manifest.json']) {
    if (!out.some((e) => e.rel === f)) continue;
    const man = JSON.parse(await getText(dest.client, dest.bucket, P + f));
    const dir = f.startsWith('uploads-legacy') ? 'uploads-legacy-local' : 'uploads';
    for (const e of man.files || []) out.push({ rel: `${dir}/${e.key}`, size: e.size, key: blobKey(dest, e.sha256), sha256: e.sha256 });
  }
  if (m.kind === 'full' && !out.some((e) => e.rel.startsWith('uploads/'))) out.push({ rel: 'uploads/', dir: true });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// Minimal POSIX (ustar + pax) tar writer: one header per entry, no buffering of
// file contents. Long paths use a pax extended header.
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  const w = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  w(name.slice(0, 100), 0, 100);
  w(oct(0o644, 8), 100, 8); w(oct(0, 8), 108, 8); w(oct(0, 8), 116, 8);
  w(oct(size < 0o77777777777 ? size : 0, 12), 124, 12); w(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  w('        ', 148, 8); w(type, 156, 1); w('ustar\0', 257, 6); w('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  w(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  for (;;) { const s = `${len}${body}`; const l = Buffer.byteLength(s); if (l === len) return s; len = l; }
}
async function* tarEntry(path, size, isDir) {
  const name = isDir ? path.replace(/\/?$/, '/') : path;
  const big = !isDir && size >= 0o77777777777; // > 8 GiB: size goes in the pax header
  if (Buffer.byteLength(name) > 99 || big) {
    const pax = Buffer.from(paxRecord('path', name) + (big ? paxRecord('size', String(size)) : ''));
    yield tarHeader('PaxHeader', pax.length, 'x');
    yield pax; if (pax.length % 512) yield Buffer.alloc(512 - (pax.length % 512));
  }
  yield tarHeader(name.slice(0, 99), isDir ? 0 : size, isDir ? '5' : '0');
}

async function cmdExport(pkg, out) {
  const dest = destination();
  const entries = await packageEntries(dest, pkg);
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.rel.replace(/\/$/, '').split('/');
    for (let i = 1; i <= parts.length - (e.dir ? 0 : 1); i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for await (const h of tarEntry(pkg, 0, true)) await writeTo(out, h);
  for (const d of [...dirs].sort()) for await (const h of tarEntry(`${pkg}/${d}`, 0, true)) await writeTo(out, h);
  for (const e of entries) {
    if (e.dir) continue;
    for await (const h of tarEntry(`${pkg}/${e.rel}`, e.size, false)) await writeTo(out, h);
    const r = await dest.client.send(new GetObjectCommand({ Bucket: dest.bucket, Key: e.key }));
    const h = createHash('sha256'); let n = 0;
    for await (const c of r.Body) { h.update(c); n += c.length; await writeTo(out, c); }
    // Integrity during download: a corrupted or short blob aborts the archive
    // (the client gets a truncated, unusable tar — never a silently wrong file).
    if (n !== e.size || (e.sha256 && h.digest('hex') !== e.sha256)) throw new Fatal(`integrity failure exporting ${e.rel}`);
    if (n % 512) await writeTo(out, Buffer.alloc(512 - (n % 512)));
  }
  await writeTo(out, Buffer.alloc(1024));
}

async function cmdMaterialize(pkg, dir) {
  const dest = destination();
  const root = join(resolve(dir), pkg);
  const entries = await packageEntries(dest, pkg);
  let bytes = 0;
  await pool(entries, CONCURRENCY, async (e) => {
    const p = join(root, e.rel);
    if (e.dir) { await mkdir(p, { recursive: true }); return; }
    await mkdir(dirname(p), { recursive: true });
    const r = await dest.client.send(new GetObjectCommand({ Bucket: dest.bucket, Key: e.key }));
    await pipeline(r.Body, createWriteStream(p));
    bytes += e.size;
  });
  process.stdout.write(JSON.stringify({ package: pkg, dir: root, files: entries.filter((e) => !e.dir).length, bytes }) + '\n');
  log(`materialized ${pkg} → ${root} (${human(bytes)}); next: verify.sh ${root} && restore.sh ${root} …`);
}

async function cmdCat(pkg, rel) {
  const dest = destination();
  const r = await dest.client.send(new GetObjectCommand({ Bucket: dest.bucket, Key: snapPrefix(dest, pkg) + rel }));
  for await (const c of r.Body) await writeTo(process.stdout, c);
}

// ── retention / delete ───────────────────────────────────────────────────────
async function deleteSnapshot(dest, pkg) {
  const P = snapPrefix(dest, pkg);
  // MANIFEST first: from that instant the snapshot no longer exists for readers.
  await deleteKeys(dest.client, dest.bucket, [P + 'MANIFEST.json']);
  const keys = []; for await (const o of listAll(dest.client, dest.bucket, P)) keys.push(o.Key);
  await deleteKeys(dest.client, dest.bucket, keys);
}

async function gcBlobs(dest, graceHours) {
  const live = new Set();
  for (const s of await listSnapshots(dest)) {
    for (const f of ['uploads.manifest.json', 'uploads-legacy-local.manifest.json']) {
      try { for (const e of JSON.parse(await getText(dest.client, dest.bucket, snapPrefix(dest, s.package) + f)).files || []) live.add(e.sha256); }
      catch (e) { if (!is404(e)) throw e; }
    }
  }
  const cutoff = Date.now() - graceHours * 3600e3;
  const doomed = []; let kept = 0;
  for await (const o of listAll(dest.client, dest.bucket, `${dest.prefix}blobs/sha256/`)) {
    const sha = o.Key.split('/').pop();
    if (live.has(sha)) { kept++; continue; }
    // Grace: a blob written by a backup that has not committed its MANIFEST yet
    // (or just crashed) is not deleted until it is older than the grace period.
    if (new Date(o.LastModified).getTime() < cutoff) doomed.push(o.Key);
  }
  await deleteKeys(dest.client, dest.bucket, doomed);

  // Snapshot directories that never committed a MANIFEST (host killed with
  // SIGKILL mid-backup) and are older than the grace period.
  const dirs = new Map();
  for await (const o of listAll(dest.client, dest.bucket, `${dest.prefix}snapshots/`)) {
    const pkg = o.Key.slice(`${dest.prefix}snapshots/`.length).split('/')[0];
    const d = dirs.get(pkg) || { keys: [], committed: false, newest: 0 };
    d.keys.push(o.Key); d.committed ||= o.Key.endsWith('/MANIFEST.json');
    d.newest = Math.max(d.newest, new Date(o.LastModified).getTime()); dirs.set(pkg, d);
  }
  const orphans = [...dirs.entries()].filter(([, d]) => !d.committed && d.newest < cutoff);
  for (const [, d] of orphans) await deleteKeys(dest.client, dest.bucket, d.keys);

  // Multipart uploads abandoned the same way (invisible, but billed).
  let abortedUploads = 0;
  try {
    const r = await dest.client.send(new ListMultipartUploadsCommand({ Bucket: dest.bucket, Prefix: dest.prefix }));
    for (const u of r.Uploads || []) {
      if (new Date(u.Initiated).getTime() < cutoff) {
        await dest.client.send(new AbortMultipartUploadCommand({ Bucket: dest.bucket, Key: u.Key, UploadId: u.UploadId })).catch(() => undefined);
        abortedUploads++;
      }
    }
  } catch (e) { warn(`could not list multipart uploads (${e.name || e.message}) — configure a lifecycle rule to abort incomplete uploads`); }
  return { blobsKept: kept, blobsDeleted: doomed.length, orphanSnapshotsDeleted: orphans.length, abortedUploads };
}

async function cmdRetention(opts) {
  const dest = destination();
  const keep = Math.max(1, Number(opts.keep || process.env.BACKUP_RETENTION_COUNT || 10));
  const protect = new Set((opts.protect || '').split(',').filter(Boolean));
  const lock = await takeLock();
  cleanupHook = () => lock.release();
  try {
    const snaps = await listSnapshots(dest); // newest first
    // COMPLETE recovery points and partial ones (DEGRADED / INCOMPLETE) are
    // retained separately, so partials can never push a complete one out:
    //   * the newest N COMPLETE snapshots, the newest COMPLETE full snapshot
    //     and every --protect'ed package are always kept;
    //   * partials NEWER than the newest COMPLETE one are kept (newest N,
    //     plus the newest DEGRADED full — the best available full backup when
    //     no complete one exists); partials older than it are superseded.
    const completes = snaps.filter((s) => s.recoverability === 'COMPLETE');
    const newestFull = completes.find((s) => s.kind === 'full')?.package;
    const newestCompleteAt = completes[0]?.createdAt || '';
    const partials = snaps.filter((s) => s.recoverability !== 'COMPLETE' && s.createdAt > newestCompleteAt);
    const bestPartialFull = partials.find((s) => s.kind === 'full' && s.recoverability === 'DEGRADED')?.package;
    const keepSet = new Set([...completes.slice(0, keep).map((s) => s.package), ...partials.slice(0, keep).map((s) => s.package),
      ...protect, ...[newestFull, bestPartialFull].filter(Boolean)]);
    const removed = [];
    for (const s of snaps) {
      if (keepSet.has(s.package)) continue;
      await deleteSnapshot(dest, s.package); removed.push(s.package);
    }
    const gc = await gcBlobs(dest, Number(process.env.DR_GC_GRACE_HOURS ?? 24));
    process.stdout.write(JSON.stringify({ kept: snaps.length - removed.length, removed, keptComplete: completes.filter((x) => keepSet.has(x.package)).map((x) => x.package),
      keptPartial: snaps.filter((x) => x.recoverability !== 'COMPLETE' && keepSet.has(x.package)).map((x) => x.package), ...gc }) + '\n');
    log(`retention: kept ${snaps.length - removed.length} snapshot(s), removed ${removed.length}; blobs kept ${gc.blobsKept}, deleted ${gc.blobsDeleted}`);
  } finally { await lock.release(); cleanupHook = null; }
}

// ── probe (used by preflight.sh --engine stream) ─────────────────────────────
async function cmdProbe() {
  const checks = [];
  const rec = (name, state, detail) => { checks.push({ name, state, detail }); };
  let dest;
  try { dest = destination(); rec('backup-destination', 'pass', `s3://${dest.bucket}/${dest.prefix} at ${dest.endpoint} (separate from the live upload bucket)`); }
  catch (e) { rec('backup-destination', 'fail', e.message); }
  if (dest) {
    const key = `${dest.prefix}.probe-${randomBytes(6).toString('hex')}`;
    try {
      await dest.client.send(new PutObjectCommand({ Bucket: dest.bucket, Key: key, Body: Buffer.from('probe') }));
      await dest.client.send(new HeadObjectCommand({ Bucket: dest.bucket, Key: key }));
      await deleteKeys(dest.client, dest.bucket, [key]);
      rec('backup-destination-access', 'pass', 'write + read + delete permitted');
    } catch (e) { rec('backup-destination-access', 'fail', `cannot write/read/delete in the backup bucket: ${e.name || ''} ${e.message}`); }
    try { await dest.client.send(new ListObjectsV2Command({ Bucket: dest.bucket, Prefix: `${dest.prefix}snapshots/.probe-none/` })); rec('backup-destination-list', 'pass', 'listing permitted'); }
    catch (e) { rec('backup-destination-list', 'fail', `cannot list the backup bucket: ${e.message}`); }
    rec('backup-credentials', dest.sharedCredentials ? 'warn' : 'pass', dest.sharedCredentials
      ? 'BACKUP_SPACES_ACCESS_KEY not set — the live upload key is reused; a leaked app key could delete backups'
      : 'dedicated backup credentials');
  }
  if ((process.env.UPLOAD_STORAGE_DRIVER || 'local') === 'spaces') {
    try { const { client, bucket } = liveBucket(); await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: '.probe-none/' })); rec('upload-source', 'pass', `can list live bucket '${bucket}'`); }
    catch (e) { rec('upload-source', 'fail', `cannot list the live upload bucket: ${e.message}`); }
    if (!process.env.DO_SPACES_PUBLIC_URL) rec('upload-references', 'warn', 'DO_SPACES_PUBLIC_URL unset — references by public URL cannot be cross-checked');
  }
  try {
    const st = await statfs(TMP); const free = Number(st.bavail) * Number(st.bsize);
    const need = CONCURRENCY * 256 * MiB;
    rec('temp-disk', free >= need ? 'pass' : 'warn', `free ${human(free)} in ${TMP}; this engine needs at most ${CONCURRENCY} × (largest single upload) there (spill only for objects > ${MEM_OBJECT / MiB} MiB)`);
  } catch (e) { rec('temp-disk', 'warn', `cannot stat ${TMP}: ${e.message}`); }
  const ok = !checks.some((c) => c.state === 'fail');
  process.stdout.write(JSON.stringify({ ok, checks }) + '\n');
  return ok ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deep') o.deep = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parse(rest);
  switch (cmd) {
    case 'backup': return cmdBackup(o);
    case 'probe': return cmdProbe();
    case 'legacy-inventory': return cmdLegacyInventory();
    case 'legacy-inventories': {
      const inv = (await readInventories(destination())).map((i) => ({ instance: i.instance, root: i.root, scannedAt: i.scannedAt, files: (i.files || []).length }));
      process.stdout.write(JSON.stringify(inv) + '\n'); return 0;
    }
    case 'list': process.stdout.write(JSON.stringify(await listSnapshots(destination())) + '\n'); return 0;
    case 'verify': {
      if (!o._[0]) throw new Fatal('verify needs <package>');
      const v = await verifySnapshot(destination(), o._[0], { deep: o.deep });
      for (const c of v.checks) log(`✓ ${c}`);
      for (const p of v.problems) process.stderr.write(`${ts()} [dr][ERROR] ✗ ${p}\n`);
      for (const i of v.recoveryIssues) process.stderr.write(`${ts()} [dr][ERROR] ✗ recoverability ${i.severity} ${i.code} (${i.count}): ${i.detail}\n`);
      process.stdout.write(JSON.stringify(v) + '\n');
      log(`integrity ${v.integrity}; recoverability ${v.recoverability} — ${v.verified ? 'VERIFY OK' : 'NOT a verified complete recovery point'}: ${o._[0]}`);
      // 0 = intact + complete, 3 = integrity failed, 6 = intact but partial (DEGRADED/INCOMPLETE)
      return v.integrity !== 'OK' ? 3 : v.verified ? 0 : 6;
    }
    case 'export': if (!o._[0]) throw new Fatal('export needs <package>'); await cmdExport(o._[0], process.stdout); return 0;
    case 'materialize': if (!o._[1]) throw new Fatal('materialize needs <package> <dir>'); await cmdMaterialize(o._[0], o._[1]); return 0;
    case 'cat': if (!o._[1]) throw new Fatal('cat needs <package> <path>'); await cmdCat(o._[0], o._[1]); return 0;
    case 'retention': await cmdRetention(o); return 0;
    case 'delete': if (!o._[0]) throw new Fatal('delete needs <package>'); await deleteSnapshot(destination(), o._[0]); process.stdout.write(JSON.stringify({ deleted: o._[0] }) + '\n'); return 0;
    default: throw new Fatal('usage: snapshot-engine.mjs backup|list|verify|export|materialize|cat|retention|delete');
  }
}

// Termination (App Platform redeploy/scale-in sends SIGTERM, then SIGKILL after
// the grace period): stop children, abort the multipart upload, remove the
// uncommitted snapshot files, release the lock, exit 143. A committed snapshot
// is never touched by this path.
let stopping = false;
async function abort(why) {
  if (stopping) return; stopping = true;
  warn(`${why} — aborting; uncommitted snapshot files are removed`);
  for (const c of children) c.kill('SIGTERM');
  await cleanupHook?.().catch(() => undefined);
  process.exit(143);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => abort(`${sig} received`));
// Under DR_LOCK_HELD the PARENT (the app) holds the operation lock. If the
// parent dies the lock is gone, so this run must not continue unprotected.
if (truthy(process.env.DR_LOCK_HELD)) {
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) void abort('parent process (lock holder) exited'); }, 1000).unref();
}
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(141); });
// snapshot.sh execs us with a per-process scratch dir (lib/common.sh); remove it.
process.on('exit', () => { if (process.env.DR_TMP && /\/dr\.[^/]+$/.test(process.env.DR_TMP)) rmSync(process.env.DR_TMP, { recursive: true, force: true }); });

main().then((code) => process.exit(code ?? 0)).catch(async (e) => {
  process.stderr.write(`${ts()} [dr][ERROR] ${e?.message || e}\n`);
  await cleanupHook?.().catch(() => undefined);
  process.exit(e instanceof Fatal ? e.code : 1);
});
