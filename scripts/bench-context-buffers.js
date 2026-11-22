'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const kind = process.argv[3];

if (!kind) {
  console.log(`Checkout: ${root}`);
  console.log('| Buffer | Distinct chats | Retained chats | Heap delta (KiB) | Push (ns/op) |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const buffer of ['recent', 'thread']) {
    for (const count of [100, 1000, 10000]) {
      const child = spawnSync(process.execPath, [
        '--expose-gc', __filename, root, buffer, String(count),
      ], { encoding: 'utf8' });
      if (child.status !== 0) {
        process.stderr.write(child.stderr);
        process.exit(child.status || 1);
      }
      process.stdout.write(child.stdout);
    }
  }
} else {
  if (!global.gc) throw new Error('Worker requires --expose-gc');
  const create = kind === 'recent'
    ? require(path.join(root, 'lib/context-llm')).createRecentContext
    : require(path.join(root, 'lib/thread-context')).createThreadContext;
  const read = (buffer, id) => kind === 'recent' ? buffer.recent(id) : buffer.prior(id);
  const count = Number(process.argv[4]);
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const buffer = create();
  for (let i = 0; i < count; i += 1) {
    buffer.push(`chat-${i}`, randomBytes(512).toString('hex'));
  }
  global.gc();
  const delta = process.memoryUsage().heapUsed - before;
  let retained = 0;
  for (let i = 0; i < count; i += 1) {
    if (read(buffer, `chat-${i}`).length) retained += 1;
  }
  // Separate warmed push-only timing from allocation/GC and retention measurement.
  const ids = Array.from({ length: 2000 }, (_, i) => `timing-${i}`);
  const timings = [];
  const timed = create();
  for (let round = 0; round < 6; round += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < 200000; i += 1) timed.push(ids[i % ids.length], 'hello');
    const ns = Number(process.hrtime.bigint() - start) / 200000;
    if (round) timings.push(ns);
  }
  timings.sort((a, b) => a - b);
  console.log(`| ${kind} | ${count} | ${retained} | ${(delta / 1024).toFixed(1)} | ${timings[2].toFixed(0)} |`);
}
