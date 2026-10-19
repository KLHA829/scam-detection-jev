'use strict';

/** Send SIGTERM to pid (cross-platform). */

const pid = Number(process.argv[2]);
if (!Number.isFinite(pid) || pid < 1) process.exit(1);
try {
  process.kill(pid);
  process.exit(0);
} catch (err) {
  if (err && err.code === 'ESRCH') process.exit(0);
  process.exit(1);
}
