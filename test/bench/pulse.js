'use strict';

// Benchmark: the transient pulse lane vs the durable KV lane, two clients
// on one daemon (sender → daemon → receiver, cross-process semantics).
//
//   node test/bench/pulse.js

const os = require('node:os');
const path = require('node:path');
const { connect } = require('../../packages/bellstate');

const ns = `bench-${process.pid}-${Date.now()}`;
const dataFile = path.join(os.tmpdir(), 'bellstate-bench', `${ns}.json`);
const OPTS = { namespace: ns, dataFile, idleTimeout: 30 };

const now = () => performance.timeOrigin + performance.now(); // µs-res epoch ms

function stats(latencies) {
  latencies.sort((a, b) => a - b);
  const pick = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

async function benchPulse(a, b, count, payload) {
  return new Promise((resolve) => {
    const latencies = [];
    let received = 0;
    let t0;
    const unsub = b.watchPulse('bench', ({ value }) => {
      latencies.push(now() - value.t);
      received++;
      if (received === count) {
        const elapsed = now() - t0;
        unsub();
        resolve({ received, elapsed, ...stats(latencies) });
      }
    });
    t0 = now();
    // Paced bursts: send in chunks of 500 per macrotask so the receiver's
    // event loop can drain — mirrors real usage (nobody sends 100k in one tick).
    let sent = 0;
    const tick = () => {
      for (let i = 0; i < 500 && sent < count; i++, sent++) {
        a.pulse('bench', { ...payload, t: now(), i: sent });
      }
      if (sent < count) setImmediate(tick);
    };
    tick();
  });
}

// Latency at a realistic rate (not saturated): one pulse per millisecond.
async function benchPacedLatency(a, b, count) {
  return new Promise((resolve) => {
    const latencies = [];
    const unsub = b.watchPulse('paced', ({ value }) => {
      latencies.push(now() - value.t);
      if (latencies.length === count) {
        unsub();
        resolve(stats(latencies));
      }
    });
    let sent = 0;
    const tick = () => {
      a.pulse('paced', { x: 1, y: 2, t: now() });
      if (++sent < count) setTimeout(tick, 1);
    };
    tick();
  });
}

async function benchKv(a, count) {
  const t0 = now();
  const batch = 200; // pipelined like a real client under load
  for (let done = 0; done < count; done += batch) {
    const n = Math.min(batch, count - done);
    await Promise.all(
      Array.from({ length: n }, (_, i) => a.set('bench-kv', { i: done + i, t: now() }))
    );
  }
  return { elapsed: now() - t0 };
}

async function main() {
  const a = await connect(OPTS);
  const b = await connect(OPTS);

  const cursorPayload = { x: 512, y: 384, name: 'Bench Lynx', color: '#8B5CF6' };

  // Warmup
  await benchPulse(a, b, 2000, cursorPayload);

  const N = 100_000;
  const pulse = await benchPulse(a, b, N, cursorPayload);
  const pulseRate = Math.round(N / (pulse.elapsed / 1000));
  console.log(`PULSE lane   : ${N.toLocaleString()} cursor-sized msgs in ${Math.round(pulse.elapsed)}ms`);
  console.log(`               throughput ${pulseRate.toLocaleString()} msg/s (sender → daemon → receiver)`);
  console.log(`               queueing under full saturation: p50 ${pulse.p50.toFixed(1)}ms`);

  const paced = await benchPacedLatency(a, b, 3000);
  console.log(`PULSE latency: (paced, realistic rate) p50 ${paced.p50.toFixed(3)}ms · p95 ${paced.p95.toFixed(3)}ms · p99 ${paced.p99.toFixed(3)}ms`);

  const KV_N = 20_000;
  const kv = await benchKv(a, KV_N);
  const kvRate = Math.round(KV_N / (kv.elapsed / 1000));
  console.log(`KV lane      : ${KV_N.toLocaleString()} durable writes (rev+WAL+ack) in ${Math.round(kv.elapsed)}ms`);
  console.log(`               throughput ${kvRate.toLocaleString()} writes/s`);

  console.log('---');
  const users120 = Math.floor(pulseRate / 120);
  console.log(`headroom     : ${users120.toLocaleString()} users at 120Hz each on the pulse lane`);
  console.log(`               (Figma coalesces presence to ~30Hz per user)`);

  a.close();
  await b.shutdownDaemon();
  require('node:fs').rmSync(path.dirname(dataFile), { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error('bench FAILED:', err);
  process.exit(1);
});
