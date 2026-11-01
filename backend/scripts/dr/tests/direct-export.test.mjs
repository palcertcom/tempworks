import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable, Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { exportZip, safeName } from '../direct-export.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'tw-zip-test-'));
process.env.UPLOAD_DEST = path.join(root, 'uploads');
await mkdir(process.env.UPLOAD_DEST);
await writeFile(path.join(process.env.UPLOAD_DEST, 'résumé.txt'), 'Hello ملفات');
process.env.DATABASE_URL = 'postgresql://test:fake@localhost/test?schema=public';
process.env.PG_BIN_PATH = root;
const collect = () => {
  const chunks = [];
  return { chunks, output: new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }) };
};
function unzip(bytes) {
  return JSON.parse(execFileSync('python3', ['-c', `import sys,io,zipfile,json,base64
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))`], { input: bytes }).toString());
}
test('plain SQL is contained in valid ZIP; no archive left on source disk', async () => {
  await writeFile(path.join(root, 'pg_dump'), '#!/bin/sh\nprintf "CREATE TABLE sample(id integer);\\nINSERT INTO sample VALUES (7);\\n"\n', { mode: 0o755 });
  const before = await readdir(root);
  const c = collect(); await exportZip('DATABASE', c);
  const files = unzip(Buffer.concat(c.chunks));
  assert.match(Buffer.from(files['database.sql'], 'base64').toString(), /INSERT INTO sample VALUES \(7\)/);
  assert.deepEqual(Object.keys(files), ['database.sql', 'manifest.json']);
  assert.deepEqual(await readdir(root), before);
});
test('pg_dump failure after emitting SQL rejects export without valid ZIP directory', async () => {
  await writeFile(path.join(root, 'pg_dump'), '#!/bin/sh\necho partial\nexit 1\n', { mode: 0o755 });
  const c = collect(); await assert.rejects(exportZip('DATABASE', c));
  assert.equal(Buffer.concat(c.chunks).includes(Buffer.from('504b0506', 'hex')), false);
});
test('local uploads preserve bytes and unicode names', async () => {
  process.env.UPLOAD_STORAGE_DRIVER = 'local';
  const c = collect(); await exportZip('FILES', c);
  const files = unzip(Buffer.concat(c.chunks));
  assert.equal(Buffer.from(files['uploads/résumé.txt'], 'base64').toString(), 'Hello ملفات');
});
test('client disconnect stops the writer and rejects the export', { timeout: 5000 }, async () => {
  process.env.UPLOAD_STORAGE_DRIVER = 'local';
  const output = new Writable({ write(chunk, encoding, done) { done(new Error('client disconnected')); } });
  await assert.rejects(exportZip('FILES', { output }));
});
test('reject symlinks and unsafe archive names', async () => {
  for (const n of ['../secret', '/absolute', 'a/../b', 'a\\b', 'C:file']) assert.throws(() => safeName(n));
  await symlink(path.join(root, 'pg_dump'), path.join(process.env.UPLOAD_DEST, 'link'));
  await assert.rejects(exportZip('FILES', collect()));
  await rm(path.join(process.env.UPLOAD_DEST, 'link'));
});
test('Spaces paginates, preserves paths and fails on changed/missing objects', async () => {
  process.env.UPLOAD_STORAGE_DRIVER = 'spaces';
  for (const key of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY']) process.env['DO_SPACES_' + key] = 'test';
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  let bad = false;
  class S3Client {
    destroy() {}
    async send(command) {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: command.input.ContinuationToken ? 'two.txt' : 'one.txt', Size: 3, ETag: 'abc' }],
        IsTruncated: !command.input.ContinuationToken, NextContinuationToken: 'page2' };
      assert.equal(command.input.IfMatch, 'abc');
      if (bad) throw new Error('NoSuchKey');
      return { Body: Readable.from([Buffer.from('abc')]), ContentLength: 3 };
    }
  }
  const s3 = { S3Client, ListObjectsV2Command, GetObjectCommand };
  const c = collect(); await exportZip('FILES', { ...c, s3 });
  const files = unzip(Buffer.concat(c.chunks));
  assert.ok(files['spaces/one.txt']); assert.ok(files['spaces/two.txt']);
  bad = true;
  const failed = collect(); await assert.rejects(exportZip('FILES', { ...failed, s3 }));
  assert.equal(Buffer.concat(failed.chunks).includes(Buffer.from('504b0506', 'hex')), false);
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });
