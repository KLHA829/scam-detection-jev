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
| Mask | 0 | 2.25 → 0.31 | 3.31 → 2.30 | 604.61 → 870.47 |
| Mask | 250 | 251.95 → 0.30 | 253.40 → 256.44 | 7.89 → 7.80 |
| Mask | 1000 | 1006.28 → 0.22 | 1006.95 → 1006.97 | 1.99 → 1.99 |
| LLM | 0 | 1.62 → 0.18 | 2.09 → 2.03 | 956.20 → 987.64 |
| LLM | 250 | 252.22 → 0.16 | 252.80 → 252.71 | 7.91 → 7.91 |
| LLM | 1000 | 1005.83 → 0.15 | 1006.99 → 1006.55 | 1.99 → 1.99 |

This removes cross-chat head-of-line blocking; it does not accelerate the slow
explanation itself. Total two-chat throughput is therefore essentially unchanged
at nonzero delays. Sub-millisecond and zero-delay results are subject to noise.
The benchmark disables action gaps for isolation. Guided forward/card/poll/fallback
writes remain inside one exclusive section with no pause calls, matching main.
Regression tests assert that boundary and zero added pauses at the default gap.

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
