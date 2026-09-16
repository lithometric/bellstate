'use strict';

// Copy the locally built bellstated binary into packages/bellstate/bin/
// so the npm package is self-contained for this platform. Run after
// `npm run build:daemon`. Release binaries for other platforms come from
// the GitHub release workflow and drop into the same layout.

const fs = require('node:fs');
const path = require('node:path');

const exe = process.platform === 'win32' ? 'bellstated.exe' : 'bellstated';
const built = path.join(__dirname, '..', 'daemon', 'target', 'release', exe);
const destDir = path.join(
  __dirname,
  '..',
  'packages',
  'bellstate',
  'bin',
  `${process.platform}-${process.arch}`
);

if (!fs.existsSync(built)) {
  console.error(`No daemon build at ${built}\nRun: npm run build:daemon`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(built, path.join(destDir, exe));
fs.chmodSync(path.join(destDir, exe), 0o755);
console.log(`bundled ${exe} → ${path.relative(process.cwd(), destDir)}`);
