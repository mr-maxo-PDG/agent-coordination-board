'use strict';

// Helper for the concurrency test: posts N events from N simultaneous processes,
// exiting only once they have all finished. Kept out of run.js so the test harness
// itself can stay synchronous.
//   node concurrent-poster.js <repoRoot> <count>

const path = require('path');
const { spawn } = require('child_process');

const [root, countArg] = process.argv.slice(2);
const count = Number(countArg);
const bin = path.join(__dirname, '..', 'bin', 'coordboard.js');

let done = 0;
for (let i = 0; i < count; i += 1) {
  const child = spawn(process.execPath, [bin, 'event', `concurrent ${i}`, '--handle', 'racer'], {
    cwd: root,
    stdio: 'ignore',
  });
  child.on('exit', () => {
    done += 1;
    if (done === count) process.exit(0);
  });
}
