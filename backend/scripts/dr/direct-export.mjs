// Direct browser exports: no archive, SQL dump or upload copies on server disk.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function safeName(name) {
  if (!name || name.startsWith('/') || /[\\:\x00-\x1f]/.test(name)
      || name.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Unsafe archive path');
  }
  return name;
}

export async function exportZip(kind, options = {}) {
  if (!['DATABASE', 'FILES'].includes(kind)) throw new Error('Invalid export kind');
  const output = options.output || process.stdout;
  const zip = spawn('python3', ['-B', fileURLToPath(new URL('./zip-writer.py', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const zipDone = new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('close', code => code === 0 ? resolve() : reject(new Error('ZIP writer failed')));
  });
  zipDone.catch(() => {});
  zip.stdin.on('error', () => {});
  zip.stderr.resume();
  zip.stdout.pipe(output, { end: false });
  let dump;
  const abort = () => { dump?.kill('SIGTERM'); zip.kill('SIGTERM'); };
  const onOutputError = () => abort();
  output.on('error', onOutputError);
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const entries = [];
  const write = async (buffer) => {
    if (zip.stdin.destroyed) throw new Error('ZIP writer closed');
    if (!zip.stdin.write(buffer)) await once(zip.stdin, 'drain');
  };
  const frame = async (op, value) => {
    if (value === undefined) return write(Buffer.from(op));
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(5);
    header.write(op); header.writeUInt32BE(buffer.length, 1);
    await write(header); await write(buffer);
  };
  const append = async (name, source, validate = async () => {}) => {
    await frame('N', JSON.stringify({ name: safeName(name) }));
    const hash = createHash('sha256');
    let size = 0;
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk); size += chunk.length;
      for (let i = 0; i < chunk.length; i += 65536) await frame('D', chunk.subarray(i, i + 65536));
    }
    await validate(size);
    await frame('E');
    entries.push({ path: name, bytes: size, sha256: hash.digest('hex') });
  };
  let client;
  try {
    if (kind === 'DATABASE') {
      const url = new URL(process.env.DATABASE_URL);
      const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '20' };
      if (url.searchParams.has('sslmode')) env.PGSSLMODE = url.searchParams.get('sslmode');
      // Prisma-only URL options are intentionally not passed to libpq.
      dump = spawn(path.join(process.env.PG_BIN_PATH || '', 'pg_dump'),
        ['--format=plain', '--no-owner', '--no-privileges', '--no-password'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const done = new Promise((resolve, reject) => {
        dump.once('error', reject);
        dump.once('close', code => code === 0 ? resolve() : reject(new Error('Database export failed')));
      });
      done.catch(() => {});
      dump.stderr.resume(); // Never return connection details or SQL in logs.
      await append('database.sql', dump.stdout, async () => { await done; });
    } else {
      const driver = process.env.UPLOAD_STORAGE_DRIVER || 'local';
      if (driver === 'spaces') {
        const { S3Client, ListObjectsV2Command, GetObjectCommand } = options.s3 || await import('@aws-sdk/client-s3');
        const required = ['DO_SPACES_ENDPOINT', 'DO_SPACES_REGION', 'DO_SPACES_BUCKET', 'DO_SPACES_ACCESS_KEY', 'DO_SPACES_SECRET_KEY'];
        if (required.some(key => !process.env[key])) throw new Error('Missing Spaces configuration');
        client = new S3Client({ endpoint: process.env.DO_SPACES_ENDPOINT, region: process.env.DO_SPACES_REGION,
          credentials: { accessKeyId: process.env.DO_SPACES_ACCESS_KEY, secretAccessKey: process.env.DO_SPACES_SECRET_KEY } });
        let token;
        do {
          const page = await client.send(new ListObjectsV2Command({ Bucket: process.env.DO_SPACES_BUCKET, ContinuationToken: token }));
          for (const item of page.Contents || []) {
            if (item.Key.endsWith('/') && item.Size === 0) continue;
            safeName(item.Key);
            const object = await client.send(new GetObjectCommand({ Bucket: process.env.DO_SPACES_BUCKET, Key: item.Key, IfMatch: item.ETag }));
            if (!object.Body) throw new Error('Object body missing');
            await append(`spaces/${item.Key}`, object.Body, async size => {
              if (size !== Number(object.ContentLength) || size !== Number(item.Size)) throw new Error('Object changed during export');
            });
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && !token) throw new Error('Incomplete object listing');
        } while (token);
      } else if (driver !== 'local') throw new Error('Unsupported storage driver');

      const root = path.resolve(process.env.UPLOAD_DEST || './uploads');
      const walk = async (dir, prefix = '') => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix + item.name;
          safeName(rel);
          const full = path.join(dir, item.name);
          if (item.isSymbolicLink()) throw new Error('Symlink in uploads; export stopped');
          if (item.isDirectory()) await walk(full, rel + '/');
          else if (item.isFile()) {
            const before = await lstat(full);
            await append(`uploads/${rel}`, createReadStream(full, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }), async size => {
              const after = await lstat(full);
              if (after.isSymbolicLink() || before.ino !== after.ino || before.size !== size || before.mtimeMs !== after.mtimeMs)
                throw new Error('Local file changed during export');
            });
          } else throw new Error('Unsupported upload file');
        }
      };
      try { await walk(root); }
      catch (error) { if (!(driver === 'spaces' && error.code === 'ENOENT' && error.path === root)) throw error; }
    }
    const manifest = { format: 'tempworks-direct-zip-v1', kind, createdAt: new Date().toISOString(), entries,
      scope: kind === 'DATABASE' ? 'Database schema and data; excludes cluster roles, ownership and grants.'
        : 'Current objects in configured Spaces bucket and uploads on the serving instance. Database references and other instances are not validated.',
      restore: kind === 'DATABASE' ? 'Extract database.sql and restore with psql into a separate empty database. This ZIP is not accepted by the legacy restore screen.'
        : 'spaces/ paths are object keys; uploads/ paths are local upload paths. This ZIP contains no database.' };
    await frame('N', JSON.stringify({ name: 'manifest.json' }));
    await frame('D', JSON.stringify(manifest, null, 2)); await frame('E');
    await frame('F'); zip.stdin.end();
    await zipDone;
    return manifest;
  } catch (error) {
    abort();
    await zipDone.catch(() => {});
    throw error;
  } finally {
    client?.destroy();
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
    output.removeListener('error', onOutputError);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exportZip(process.argv[2]).catch(() => {
    console.error('Direct ZIP export failed. Discard the incomplete download and check source availability.');
    process.exitCode = 1;
  });
}
