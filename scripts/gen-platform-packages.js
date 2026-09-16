'use strict';

// Generate per-platform npm packages carrying the bellstated binary
// (esbuild-style), so `npm install bellstate` gets the right daemon on
// every OS via optionalDependencies.
//
//   node scripts/gen-platform-packages.js <binaries-dir> [--inject]
//
// <binaries-dir> holds binaries named bellstated-<platform>-<arch>[.exe]
// (the release workflow's artifact naming). Packages are written to
// dist/npm/. With --inject, optionalDependencies for every generated
// package are written into packages/bellstate/package.json (publish-time
// step — not meant to be committed).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'npm');
const MAIN_PKG = path.join(ROOT, 'packages', 'bellstate', 'package.json');

const TARGETS = [
  { name: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'linux-x64', os: 'linux', cpu: 'x64' },
  { name: 'linux-arm64', os: 'linux', cpu: 'arm64' },
  { name: 'win32-x64', os: 'win32', cpu: 'x64', exe: '.exe' },
];

const args = process.argv.slice(2);
const inject = args.includes('--inject');
const binariesDir = args.find((a) => !a.startsWith('--'));
if (!binariesDir) {
  console.error('usage: node scripts/gen-platform-packages.js <binaries-dir> [--inject]');
  process.exit(2);
}

const version = JSON.parse(fs.readFileSync(MAIN_PKG, 'utf8')).version;
const generated = [];

for (const target of TARGETS) {
  const ext = target.exe || '';
  const src = path.join(binariesDir, `bellstated-${target.name}${ext}`);
  if (!fs.existsSync(src)) {
    console.warn(`skip ${target.name}: no binary at ${src}`);
    continue;
  }
  const pkgName = `bellstate-${target.name}`;
  const dir = path.join(OUT, pkgName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: pkgName,
        version,
        description: `bellstated daemon binary for ${target.name} (installed automatically by bellstate)`,
        license: 'MIT',
        repository: {
          type: 'git',
          url: 'git+https://github.com/lithometric/bellstate.git',
        },
        os: [target.os],
        cpu: [target.cpu],
        files: [`bellstated${ext}`],
      },
      null,
      2
    ) + '\n'
  );
  const dest = path.join(dir, `bellstated${ext}`);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  generated.push(pkgName);
  console.log(`generated ${pkgName}@${version}`);
}

if (generated.length === 0) {
  console.error('no binaries found, nothing generated');
  process.exit(1);
}

if (inject) {
  const pkg = JSON.parse(fs.readFileSync(MAIN_PKG, 'utf8'));
  pkg.optionalDependencies = Object.fromEntries(generated.map((n) => [n, version]));
  fs.writeFileSync(MAIN_PKG, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`injected ${generated.length} optionalDependencies into bellstate`);
}
