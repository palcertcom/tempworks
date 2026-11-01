// Run after the backend build; no database or production credentials needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { trackDownload } from '../../../../src/app/services/download-progress.mjs';
const require = createRequire(import.meta.url);
const { BackupService } = require('../../../dist/src/backup/backup.service.js');
const { BackupController } = require('../../../dist/src/backup/backup.controller.js');

test('progress counts exact bytes and preserves download bytes', async () => {
  const updates = [];
  const input = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } });
  const result = await new Response(trackDownload(input, n => updates.push(n), () => 1000)).arrayBuffer();
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3]);
  assert.equal(updates.at(-1), 3);
});

test('a broken stream is not converted into a completed download', async () => {
  const input = new ReadableStream({ pull(c) { c.error(new Error('network lost')); } });
  await assert.rejects(new Response(trackDownload(input, () => {})).blob(), /network lost/);
});

test('cancelling the progress stream propagates to its source', async () => {
  let cancelled = false;
  const input = new ReadableStream({ cancel() { cancelled = true; } });
  await trackDownload(input, () => {}).cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

async function controllerFixture() {
  const stream = new PassThrough();
  const events = [];
  let cancelled = false;
  const service = { directZip: async (_kind, id, email) => {
    assert.equal(id, 'user-1'); assert.equal(email, 'admin@example.test');
    return { stream, fileName: 'export.zip', report: async s => events.push(s), cancel: () => { cancelled = true; } };
  } };
  const res = new Writable({ write(_data, _encoding, done) { done(); } });
  res.set = () => {};
  const controller = new BackupController(service, {}, {});
  await controller.directDownload({ kind: 'DATABASE' }, { user: { id: 'user-1', email: 'admin@example.test' } }, res);
  return { stream, events, res, cancelled: () => cancelled };
}

test('HTTP finish records server delivery, not local save', async () => {
  const f = await controllerFixture();
  const done = once(f.res, 'finish');
  f.stream.end('zip bytes'); await done;
  assert.deepEqual(f.events, ['STREAMED']); assert.equal(f.cancelled(), false);
});

test('client disconnect records cancellation and stops producer', async () => {
  const f = await controllerFixture();
  f.res.destroy(); await once(f.res, 'close');
  assert.deepEqual(f.events, ['CANCELLED']); assert.equal(f.cancelled(), true);
});

test('producer error records failure before closing response', async () => {
  const f = await controllerFixture();
  f.stream.destroy(new Error('producer failed')); await once(f.res, 'close');
  assert.equal(f.events[0], 'FAILED'); assert.equal(f.cancelled(), true);
});

test('history correlates user and terminal event and labels abandoned starts unknown', async () => {
  const starts = [
    { entityId: 'a', createdAt: new Date(), userEmail: 'a@example.test', changes: { userName: 'Admin A', kind: 'FILES', fileName: 'a.zip' } },
    { entityId: 'b', createdAt: new Date(Date.now() - 70 * 60000), changes: { kind: 'DATABASE' } },
  ];
  const ends = [{ entityId: 'a', createdAt: new Date(), changes: { state: 'STREAMED', bytes: 123 } }];
  let calls = 0;
  const prisma = { auditLog: { findMany: async query => {
    if (++calls === 1) { assert.equal(query.take, 50); return starts; }
    assert.deepEqual(query.where.entityId.in, ['a', 'b']); return ends;
  } } };
  const result = await BackupService.prototype.directHistory.call({ prisma });
  assert.equal(result[0].userName, 'Admin A'); assert.equal(result[0].state, 'STREAMED');
  assert.equal(result[0].bytes, 123); assert.equal(result[1].state, 'UNKNOWN');
});
