'use strict';

const path = require('path');
const { siblingUnblockScenario } = require('../test/support/sibling-unblock-scenario');

(async () => {
  const rows = [];
  for (const root of process.argv.slice(2).length ? process.argv.slice(2) : [process.cwd()]) {
    for (const choice of ['解除封鎖', '保持封鎖']) {
      rows.push({ root: path.resolve(root), ...await siblingUnblockScenario({ root: path.resolve(root), choice }) });
    }
  }
  console.table(rows);
})().catch((err) => { console.error(err); process.exitCode = 1; });
