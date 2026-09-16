'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXE = process.platform === 'win32' ? 'bellstated.exe' : 'bellstated';

/**
 * Locate the bellstated binary. Resolution order:
 *   1. explicit option
 *   2. BELLSTATE_DAEMON env var
 *   3. binary bundled with the package (bin/<platform>-<arch>/)
 *   4. a local cargo build (developing inside this repo)
 */
function platformPackage() {
  // Per-platform sibling package (bellstate-darwin-arm64, …) installed via
  // optionalDependencies, the way esbuild ships its binaries.
  try {
    return require.resolve(`bellstate-${process.platform}-${process.arch}/${EXE}`);
  } catch {
    return null;
  }
}

function resolveDaemonPath(explicit) {
  const candidates = [
    explicit,
    process.env.BELLSTATE_DAEMON,
    // In-repo cargo builds win over bundled binaries so development always
    // runs the freshest daemon; neither path exists in a published install.
    path.join(__dirname, '..', '..', 'daemon', 'target', 'release', EXE),
    path.join(__dirname, '..', '..', 'daemon', 'target', 'debug', EXE),
    platformPackage(),
    path.join(__dirname, 'bin', `${process.platform}-${process.arch}`, EXE),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    'bellstate: could not find the bellstated daemon binary. ' +
      'Install a release binary, set BELLSTATE_DAEMON to its path, ' +
      'or build it from source with: cargo build --release --manifest-path daemon/Cargo.toml\n' +
      `Searched:\n  ${candidates.join('\n  ')}`
  );
}

module.exports = { resolveDaemonPath };
