'use strict';

// End-to-end suite for bellstate: independent clients against one daemon.
//
// Covers: cross-process reads, live events, compare-and-set + update()
// under contention, atomic incr, mset atomicity, pattern watch, chunked
// large values, ephemeral keys + locks (incl. re-claim after daemon
// restart), TTL expiry, WAL crash recovery, deletes, stats, clean shutdown.
//
// Run with: npm test   (builds the daemon first)

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect, socketPathFor, orderBetween } = require('../../packages/bellstate');

const ns = `e2e-${process.pid}-${Date.now()}`;
const dataFile = path.join(os.tmpdir(), 'bellstate-e2e', `${ns}.json`);
const pidFile = path.join(
  process.env.XDG_RUNTIME_DIR || os.tmpdir(),
  'bellstate',
  `${ns}.pid`
);
const OPTS = { namespace: ns, dataFile, idleTimeout: 60 };

const steps = [];
function step(name) {
  steps.push(name);
  console.log(`  ✔ ${name}`);
}

function waitFor(emitter, event, pred = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, listener);
      reject(new Error(`timed out waiting for '${event}'`));
    }, timeoutMs);
    const listener = (payload) => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      emitter.removeListener(event, listener);
      resolve(payload);
    };
    emitter.on(event, listener);
  });
}

async function until(fn, timeoutMs = 5000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  console.log(`bellstate e2e (namespace: ${ns})`);

  // --- basics ------------------------------------------------------------
  const a = await connect(OPTS);
  step('client A connected (daemon auto-spawned, protocol v1 handshake)');

  await a.set('foo', 1);
  const b = await connect(OPTS);
  assert.strictEqual(b.get('foo'), 1, 'B should see the value A wrote');
  step('write in A → read in B');

  const changePromise = waitFor(b, 'change', (c) => c.key === 'bar');
  await a.set('bar', { nested: [1, 2, 3] });
  const change = await changePromise;
  assert.deepStrictEqual(change.value, { nested: [1, 2, 3] });
  assert.deepStrictEqual(b.get('bar'), { nested: [1, 2, 3] });
  step('B received live change event from A’s write');

  // --- compare-and-set ----------------------------------------------------
  await a.set('cas', 'first');
  await until(() => b.get('cas') === 'first');
  await assert.rejects(
    b.set('cas', 'stale write', { ifRev: 999999 }),
    (err) => err.code === 'conflict' && typeof err.rev === 'number',
    'stale ifRev must be rejected with a conflict carrying the current rev'
  );
  assert.strictEqual(b.get('cas'), 'first');
  step('compare-and-set rejects stale writes with conflict + current rev');

  // --- update() under contention ------------------------------------------
  const bump = (client) =>
    client.update('uc', (cur) => ({ n: (cur?.n ?? 0) + 1 }));
  const runBumps = async (client, times) => {
    for (let i = 0; i < times; i++) await bump(client);
  };
  await Promise.all([runBumps(a, 30), runBumps(b, 30)]);
  await until(() => a.get('uc')?.n === 60 && b.get('uc')?.n === 60);
  step('update(): 2 clients × 30 concurrent read-modify-writes → 60, none lost');

  // --- server-side atomic incr ---------------------------------------------
  await Promise.all([
    Promise.all(Array.from({ length: 100 }, () => a.incr('hammer'))),
    Promise.all(Array.from({ length: 100 }, () => b.incr('hammer'))),
  ]);
  await until(() => a.get('hammer') === 200 && b.get('hammer') === 200);
  step('incr: 2 clients × 100 concurrent increments → exactly 200');

  // --- atomic multi-key writes ---------------------------------------------
  await a.set('tmpdel', 'doomed');
  await until(() => b.get('tmpdel') === 'doomed');
  const mchange = waitFor(b, 'mchange');
  await a.mset({ m1: 1, m2: { deep: true } }, { del: ['tmpdel'] });
  await mchange;
  assert.strictEqual(b.get('m1'), 1);
  assert.deepStrictEqual(b.get('m2'), { deep: true });
  assert.strictEqual(b.get('tmpdel'), undefined);
  assert.strictEqual(
    b.getRev('m1'),
    b.getRev('m2'),
    'mset keys must share one revision'
  );
  step('mset: multi-key write + delete lands atomically at one revision');

  // --- pattern watch --------------------------------------------------------
  const watched = [];
  const unwatch = b.watch('w:*', (c) => watched.push(c.key));
  await a.set('w:one', 1);
  await a.set('unrelated', 1);
  await a.set('w:two', 2);
  await until(() => watched.length >= 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(watched, ['w:one', 'w:two']);
  unwatch();
  step('watch("w:*") sees only matching keys');

  // --- large values (chunked transfer, lazy replication) --------------------
  const bigPayload = { blob: 'x'.repeat(8 * 1024 * 1024), tag: 'big-v1' };
  const bigArrived = waitFor(b, 'change', (c) => c.key === 'big', 30000);
  let tinyDone = 0;
  let bigDone = 0;
  const bigWrite = a.set('big', bigPayload).then(() => (bigDone = Date.now()));
  const tinyWrite = b.set('tiny', 1).then(() => (tinyDone = Date.now()));
  await Promise.all([bigWrite, tinyWrite]);
  assert.ok(
    tinyDone <= bigDone,
    'a small write must not wait behind an 8MB chunked upload'
  );
  await bigArrived;
  assert.strictEqual(b.get('big').tag, 'big-v1');
  assert.strictEqual(b.get('big').blob.length, bigPayload.blob.length);
  step('8MB value chunked up, lazily replicated to B; small write stayed instant');

  // --- ephemeral keys + locks ----------------------------------------------
  const c = await connect(OPTS);
  await c.set('eph:c', { alive: true }, { ephemeral: true });
  await until(() => a.get('eph:c')?.alive === true);
  const ephGone = waitFor(a, 'change', (x) => x.key === 'eph:c' && x.deleted);
  c.close();
  const gone = await ephGone;
  assert.strictEqual(gone.ephemeral, true);
  step('ephemeral key vanished (with event) when its client disconnected');

  assert.strictEqual(await a.acquire('lock:job'), true, 'A takes the lock');
  assert.strictEqual(await b.acquire('lock:job'), false, 'B must be refused');
  const lockFree = waitFor(b, 'change', (x) => x.key === 'lock:job' && x.deleted);
  await a.release('lock:job');
  await lockFree;
  assert.strictEqual(await b.acquire('lock:job'), true, 'B takes the freed lock');
  await b.release('lock:job');
  step('acquire/release: machine-global lock with correct mutual exclusion');

  // --- TTL -------------------------------------------------------------------
  const expired = waitFor(
    b,
    'change',
    (x) => x.key === 'ttl:x' && x.deleted && x.expired,
    4000
  );
  await a.set('ttl:x', 'temporary', { ttl: 400 });
  await until(() => b.get('ttl:x') === 'temporary');
  await expired;
  assert.strictEqual(b.get('ttl:x'), undefined);
  step('TTL key expired and the deletion broadcast to all clients');

  // --- merge: per-property LWW ----------------------------------------------
  await Promise.all([
    a.merge('mg', { x: 1, deep: { fromA: true } }),
    b.merge('mg', { y: 2, deep: { fromB: true } }),
  ]);
  await until(
    () =>
      a.get('mg')?.x === 1 &&
      a.get('mg')?.y === 2 &&
      b.get('mg')?.x === 1 &&
      b.get('mg')?.y === 2,
    5000,
    'concurrent merges to combine'
  );
  assert.deepStrictEqual(a.get('mg').deep, { fromA: true, fromB: true });
  step('merge: concurrent per-property writes combine, zero conflicts');

  await a.merge('mg', { x: null });
  await until(() => b.get('mg') && !('x' in b.get('mg')));
  assert.strictEqual(b.get('mg').y, 2);
  step('merge: null deletes a field, others untouched');

  // --- streams: bounded history backfill --------------------------------------
  for (let i = 0; i < 15; i++) a.pulse('stream:test', { i }, { keep: 10 });
  await new Promise((r) => setTimeout(r, 200));
  const late = await connect(OPTS);
  const backfill = await late.history('stream:test');
  assert.strictEqual(backfill.length, 10, 'history bounded to keep');
  assert.strictEqual(backfill[9].i, 14, 'most recent pulse last');
  assert.strictEqual(backfill[0].i, 5, 'oldest retained pulse first');
  late.close();
  step('stream: late joiner backfilled last 10 of 15 pulses');

  // --- per-client undo/redo ----------------------------------------------------
  a.enableUndo();
  await a.set('doc', 'draft one');
  await a.set('doc', 'draft two');
  await a.merge('doc-meta', { title: 'T' });
  assert.strictEqual(a.undoDepth, 3);
  await a.undo(); // un-merge → doc-meta gone (was absent before)
  await until(() => b.get('doc-meta') === undefined);
  await a.undo(); // back to draft one
  await until(() => b.get('doc') === 'draft one');
  await a.undo(); // first set undone → key gone
  await until(() => b.get('doc') === undefined);
  await a.redo();
  await until(() => b.get('doc') === 'draft one');
  step('undo/redo: per-client history reverts own ops (set, merge, creation)');

  // --- secure values (encrypted at rest) ---------------------------------------
  const keyFile = path.join(os.tmpdir(), 'bellstate-e2e', `${ns}.key`);
  const s1 = await connect({ ...OPTS, secure: { keyFile } });
  const s2 = await connect({ ...OPTS, secure: { keyFile } });
  await s1.set('vault', { token: 'hunter2-secret' }, { secure: true });
  await until(() => s2.get('vault')?.token === 'hunter2-secret');
  const envelope = a.get('vault'); // a has no key: sees ciphertext
  assert.strictEqual(envelope.$sec, 1, 'key-less client sees the envelope');
  assert.ok(!JSON.stringify(envelope).includes('hunter2'), 'no plaintext leaks');
  await new Promise((r) => setTimeout(r, 300)); // let the WAL flush
  const onDisk =
    (fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : '') +
    (fs.existsSync(dataFile.replace(/\.json$/, '.wal'))
      ? fs.readFileSync(dataFile.replace(/\.json$/, '.wal'), 'utf8')
      : '');
  assert.ok(!onDisk.includes('hunter2'), 'disk holds only ciphertext');
  assert.ok(onDisk.includes('$sec'), 'envelope reached disk');
  s1.close();
  s2.close();
  step('secure: holders decrypt; others and the disk see only ciphertext');

  // --- fractional-index ordering ------------------------------------------------
  const k1 = orderBetween(null, null);
  const k2 = orderBetween(k1, null);
  const kMid = orderBetween(k1, k2);
  assert.ok(k1 < kMid && kMid < k2);
  const kBefore = orderBetween(null, k1);
  assert.ok(kBefore < k1);
  const kTight = orderBetween('V', 'V1'); // adjacent-digit squeeze
  assert.ok('V' < kTight && kTight < 'V1');
  let lo = k1;
  for (let i = 0; i < 50; i++) {
    const next = orderBetween(lo, k2);
    assert.ok(lo < next && next < k2, `squeeze ${i}`);
    lo = next;
  }
  step('orderBetween: strict ordering holds through 50 nested inserts');

  // --- crash: WAL recovery + ephemeral re-claim ------------------------------
  assert.strictEqual(await a.acquire('lock:survivor'), true);
  await new Promise((r) => setTimeout(r, 150)); // WAL flush margin
  const daemonPid = Number(fs.readFileSync(pidFile, 'utf8'));
  const aDisconnected = waitFor(a, 'disconnect');
  const aReconnected = waitFor(a, 'reconnect', () => true, 15000);
  const bReconnected = waitFor(b, 'reconnect', () => true, 15000);
  process.kill(daemonPid, 'SIGKILL');
  await aDisconnected;
  const queuedWrite = a.set('baz', 3); // lands in the offline queue
  assert.strictEqual(a.offlineQueueSize, 1, 'write should queue while offline');
  await queuedWrite;
  assert.strictEqual(a.offlineQueueSize, 0, 'queue drains after reconnect');
  step('offline queue: write held during outage, flushed on reconnect');
  await Promise.all([aReconnected, bReconnected]);
  await until(() => b.get('baz') === 3, 5000, 'B to see post-crash write');
  assert.strictEqual(b.get('foo'), 1, 'WAL must preserve state across SIGKILL');
  assert.strictEqual(b.get('hammer'), 200);
  assert.strictEqual(b.get('uc').n, 60);
  await until(() => b.get('big')?.tag === 'big-v1', 30000, 'large value re-sync');
  step('daemon SIGKILLed: WAL recovered every key (incl. 8MB value), writes resumed');

  assert.strictEqual(
    await b.acquire('lock:survivor'),
    false,
    'A must have re-claimed its ephemeral lock after the restart'
  );
  step('ephemeral lock automatically re-claimed by its owner after restart');

  const newPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.notStrictEqual(newPid, daemonPid, 'a fresh daemon should be running');
  step('fresh daemon PID confirmed');

  // --- deletes ---------------------------------------------------------------
  const delSeen = waitFor(b, 'change', (x) => x.key === 'bar' && x.deleted);
  await a.delete('bar');
  await delSeen;
  assert.strictEqual(b.get('bar'), undefined);
  step('delete in A propagated to B');

  // --- stats -----------------------------------------------------------------
  const stats = await a.stats();
  assert.ok(stats.clients >= 2, 'stats should count both clients');
  assert.ok(stats.keys > 0);
  assert.ok(stats.rev > 0);
  assert.strictEqual(stats.v, 1);
  step(`stats: ${stats.clients} clients, ${stats.keys} keys, rev ${stats.rev}`);

  // --- cleanup ---------------------------------------------------------------
  a.close();
  await b.shutdownDaemon();
  await until(() => !fs.existsSync(socketPathFor(ns)), 3000, 'socket cleanup');
  fs.rmSync(path.dirname(dataFile), { recursive: true, force: true });
  step('clean shutdown, socket removed');

  console.log(`\nall ${steps.length} steps passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\ne2e FAILED:', err);
  process.exit(1);
});
