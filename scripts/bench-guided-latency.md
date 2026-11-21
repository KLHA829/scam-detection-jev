# Guided explanation queue benchmark

Run from the repo root: `node scripts/bench-guided-latency.js`.

Like PR #69's receipt benchmark, this uses `handleWaMessage`, a fake WhatsApp
client, and `WA_ACTION_GAP_MS=0`. Chat A's guided link-rule review waits on a
fixed-latency mask or LLM stub. Chat B's automatic link-rule message arrives
once that wait starts. No real WhatsApp, mask worker, or external LLM is used.
The LLM stub returns a valid explanation; both handlers complete. Five trials
per stage/delay are measured independently; each column reports its median.

- Archive latency: from B's arrival to B's `archive()` call.
- Total time: from A's arrival until both handlers complete, including A's poll.
- Throughput: two completed chat handlers divided by total seconds.

Measured on Node v20.20.2, Ubuntu, main `174afe4` versus this branch:

| Slow stage | Delay (ms) | B archive before → after (ms) | Total before → after (ms) | Chats/s before → after |
|---|---:|---:|---:|---:|
| Mask | 0 | 1.75 → 0.25 | 2.44 → 2.65 | 819.25 → 753.90 |
| Mask | 250 | 251.41 → 0.28 | 252.25 → 253.93 | 7.93 → 7.88 |
| Mask | 1000 | 1006.17 → 0.16 | 1006.74 → 1006.82 | 1.99 → 1.99 |
| LLM | 0 | 1.57 → 0.15 | 1.99 → 1.86 | 1005.29 → 1073.08 |
| LLM | 250 | 252.13 → 0.13 | 252.79 → 252.71 | 7.91 → 7.91 |
| LLM | 1000 | 1005.19 → 0.16 | 1006.47 → 1006.52 | 1.99 → 1.99 |

This removes cross-chat head-of-line blocking; it does not accelerate the slow
explanation itself. Total two-chat throughput is therefore essentially unchanged
at nonzero delays. Sub-millisecond and zero-delay results are subject to noise.
Pacing is disabled for isolation here and covered separately by the regression
tests using an injected clock.

## Reproduce the main comparison

From this branch, after `npm ci --no-audit --no-fund`:

```sh
git worktree add --detach ../scam-detection-jev-guided-base 174afe4
ln -s "$PWD/node_modules" ../scam-detection-jev-guided-base/node_modules
cp scripts/bench-guided-latency.js ../scam-detection-jev-guided-base/scripts/
cp test/support/guided-latency.js ../scam-detection-jev-guided-base/test/support/
(cd ../scam-detection-jev-guided-base && node scripts/bench-guided-latency.js)
node scripts/bench-guided-latency.js
```

The benchmark and its support helper are copied unchanged into the main worktree;
production code remains main's. Use a different worktree path if it already exists.
