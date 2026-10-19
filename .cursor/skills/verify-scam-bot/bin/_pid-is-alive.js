'use strict';

/** Exit 0 when pid exists (cross-platform; Git Bash kill -0 misses Win32 node pids). */

const pid = Number(process.argv[2]);
if (!Number.isFinite(pid) || pid < 1) process.exit(1);
try {
  process.kill(pid, 0);
  process.exit(0);
} catch (err) {
  if (err && err.code === 'EPERM') process.exit(0);
  process.exit(1);
}
