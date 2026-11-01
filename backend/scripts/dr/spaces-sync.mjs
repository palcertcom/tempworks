#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spaces-sync.mjs — object-storage side of the DR toolkit.
//
// Reuses @aws-sdk/client-s3 (already a backend dependency) to:
//   download <destDir>    mirror every object in the app bucket into destDir,
//                         printing uploads.manifest.json (key/size/sha256/etag)
//                         to stdout. Used by backup.sh when driver=spaces.
//   upload   <srcDir>     push every file under srcDir back to the app bucket,
//                         preserving keys + inferred content type. Used by
//                         restore.sh when driver=spaces.
//   offsite-put <file>    upload a DR package/tarball to the OFFSITE backup
//                         bucket (private). Used by backup.sh --offsite.
//
// App bucket env:    DO_SPACES_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY
// Offsite bucket env: BACKUP_SPACES_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY
//                     (falls back to DO_SPACES_* for endpoint/region/creds,
//                      BACKUP_SPACES_PREFIX default "dr/")
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, dirname, relative, extname } from 'node:path';

const die = (m) => { console.error(`[spaces-sync] ${m}`); process.exit(1); };

const pathStyle = (v) => v === '1' || v === 'true';

function appClient() {
  for (const k of ['DO_SPACES_ENDPOINT', 'DO_SPACES_REGION', 'DO_SPACES_BUCKET', 'DO_SPACES_ACCESS_KEY', 'DO_SPACES_SECRET_KEY'])
    if (!process.env[k]) die(`missing env ${k}`);
  return {
    bucket: process.env.DO_SPACES_BUCKET,
    client: new S3Client({
      endpoint: process.env.DO_SPACES_ENDPOINT,
      region: process.env.DO_SPACES_REGION,
      credentials: { accessKeyId: process.env.DO_SPACES_ACCESS_KEY, secretAccessKey: process.env.DO_SPACES_SECRET_KEY },
      // Virtual-hosted for DO Spaces/AWS; path-style for MinIO/other S3-compatibles.
      forcePathStyle: pathStyle(process.env.DO_SPACES_FORCE_PATH_STYLE),
    }),
  };
}

function offsiteClient() {
  const endpoint = process.env.BACKUP_SPACES_ENDPOINT || process.env.DO_SPACES_ENDPOINT;
  const region = process.env.BACKUP_SPACES_REGION || process.env.DO_SPACES_REGION;
  const bucket = process.env.BACKUP_SPACES_BUCKET;
  const accessKeyId = process.env.BACKUP_SPACES_ACCESS_KEY || process.env.DO_SPACES_ACCESS_KEY;
  const secretAccessKey = process.env.BACKUP_SPACES_SECRET_KEY || process.env.DO_SPACES_SECRET_KEY;
  if (!bucket) die('missing env BACKUP_SPACES_BUCKET (offsite target not configured)');
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) die('offsite credentials/endpoint incomplete');
  return {
    bucket,
    prefix: (process.env.BACKUP_SPACES_PREFIX || 'dr/').replace(/^\/+|\/+$/g, '') + '/',
    client: new S3Client({
      endpoint, region, credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: pathStyle(process.env.BACKUP_SPACES_FORCE_PATH_STYLE || process.env.DO_SPACES_FORCE_PATH_STYLE),
    }),
  };
}

const CT = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.csv': 'text/csv',
};
const sha256File = async (p) => new Promise((res, rej) => {
  const h = createHash('sha256'); const s = createReadStream(p);
  s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex'))); s.on('error', rej);
});
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
const streamToFile = async (body, dest) => {
  await mkdir(dirname(dest), { recursive: true });
  const chunks = [];
  for await (const c of body) chunks.push(c);
  await writeFile(dest, Buffer.concat(chunks));
};

async function download(destDir) {
  const { client, bucket } = appClient();
  await mkdir(destDir, { recursive: true });
  const files = []; const vanished = []; let token;
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of out.Contents || []) {
      if (!o.Key || o.Key.endsWith('/')) continue;
      const dest = join(destDir, o.Key);
      let got;
      try {
        got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }));
      } catch (e) {
        // Listed, then deleted before we could fetch it (e.g. the app purged
        // a replaced photo mid-backup). Not fatal here: if the database
        // snapshot references it, refcheck.py detects it and the capture is
        // retried; otherwise it was already unreferenced.
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) { vanished.push(o.Key); continue; }
        throw e;
      }
      await streamToFile(got.Body, dest);
      // Token = ETag of the bytes we actually fetched (GetObject), compared by
      // refcheck with the pre-snapshot listing to detect overwrites.
      files.push({ key: o.Key, size: Number((await stat(dest)).size), sha256: await sha256File(dest), etag: (got.ETag || o.ETag || '').replace(/"/g, '') });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  process.stdout.write(JSON.stringify({ driver: 'spaces', bucket, count: files.length, files, vanishedDuringCapture: vanished }));
  console.error(`[spaces-sync] downloaded ${files.length} object(s) from ${bucket}${vanished.length ? `; ${vanished.length} vanished during capture (left to refcheck)` : ''}`);
}

async function upload(srcDir) {
  const { client, bucket } = appClient();
  let n = 0;
  for await (const p of walk(srcDir)) {
    const key = relative(srcDir, p).split('\\').join('/');
    const body = await readFile(p);
    const ct = CT[extname(p).toLowerCase()] || 'application/octet-stream';
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: ct,
      ContentDisposition: ct.startsWith('image/') || ct === 'application/pdf' ? 'inline' : 'attachment',
      ACL: 'public-read',
    }));
    n++;
  }
  console.error(`[spaces-sync] uploaded ${n} object(s) to ${bucket}`);
}

async function offsitePut(file) {
  const { client, bucket, prefix } = offsiteClient();
  const body = await readFile(file);
  const key = prefix + file.split('/').pop();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/gzip' }));
  // Store the checksum sidecar alongside, if present.
  try {
    const sc = await readFile(`${file}.sha256`);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.sha256`, Body: sc, ContentType: 'text/plain' }));
  } catch { /* no sidecar */ }
  // Emit the object location so callers can record it.
  process.stdout.write(JSON.stringify({ bucket, key, location: `s3://${bucket}/${key}` }));
  console.error(`[spaces-sync] offsite put s3://${bucket}/${key}`);
}

const streamToBuffer = async (body) => {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
};

// Download a single offsite object (by key or bare basename) to a local file.
async function offsiteGet(key, dest) {
  const { client, bucket, prefix } = offsiteClient();
  const realKey = key.includes('/') ? key : prefix + key;
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: realKey }));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await streamToBuffer(got.Body));
  console.error(`[spaces-sync] offsite get s3://${bucket}/${realKey} -> ${dest}`);
}

// Independently verify the offsite copy: download it and compare its SHA-256
// to the local artifact (and to the stored .sha256 sidecar if present).
// Exits non-zero on any mismatch so an incomplete/corrupt offsite copy is
// never treated as a verified backup.
async function offsiteVerify(localArtifact) {
  const { client, bucket, prefix } = offsiteClient();
  const key = prefix + localArtifact.split('/').pop();
  const localSha = await sha256File(localArtifact);
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf = await streamToBuffer(got.Body);
  const remoteSha = createHash('sha256').update(buf).digest('hex');
  let sidecar = null;
  try {
    const sc = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${key}.sha256` }));
    sidecar = (await streamToBuffer(sc.Body)).toString().trim().split(/\s+/)[0];
  } catch { /* no sidecar */ }
  const ok = remoteSha === localSha && (!sidecar || sidecar === remoteSha);
  process.stdout.write(JSON.stringify({ bucket, key, localSha, remoteSha, sidecar, verified: ok, bytes: buf.length }));
  console.error(`[spaces-sync] offsite verify s3://${bucket}/${key}: ${ok ? 'OK' : 'MISMATCH'}`);
  if (!ok) process.exit(3);
}

// Change tokens for every object (key -> ETag), taken BEFORE the database
// snapshot so an overwrite between snapshot and capture is detectable.
async function listTokens() {
  const { client, bucket } = appClient();
  const tokens = {}; let token;
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of out.Contents || []) if (o.Key && !o.Key.endsWith('/')) tokens[o.Key] = (o.ETag || '').replace(/"/g, '');
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  process.stdout.write(JSON.stringify(tokens));
}

const [cmd, arg, arg2] = process.argv.slice(2);
try {
  if (cmd === 'download') await download(arg || die('download needs <destDir>'));
  else if (cmd === 'upload') await upload(arg || die('upload needs <srcDir>'));
  else if (cmd === 'offsite-put') await offsitePut(arg || die('offsite-put needs <file>'));
  else if (cmd === 'offsite-get') await offsiteGet(arg || die('offsite-get needs <key>'), arg2 || die('offsite-get needs <dest>'));
  else if (cmd === 'list-tokens') await listTokens();
  else if (cmd === 'offsite-verify') await offsiteVerify(arg || die('offsite-verify needs <localArtifact>'));
  else die(`unknown command '${cmd}' (download|upload|offsite-put|offsite-get|offsite-verify)`);
} catch (e) { die(e?.message || String(e)); }
