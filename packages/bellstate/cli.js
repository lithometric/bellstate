#!/usr/bin/env node
'use strict';

// bellstate CLI — a shell is just another client of the store.
//
//   npx bellstate get counter
//   npx bellstate set user '{"id":42}'
//   npx bellstate watch 'presence:*' --ns my-suite
//   npx bellstate stats

const { connect } = require('./client');

const USAGE = `bellstate — machine-global state for Electron and Node processes

Usage: bellstate <command> [args] [options]

Commands:
  get <key>            print a value (waits for large values to sync)
  set <key> <value>    write a value (parsed as JSON, else stored as string)
  del <key>            delete a key
  incr <key> [by]      atomic increment (default by 1)
  merge <key> <json>   atomic per-property merge (null deletes a field)
  hist <channel> [n]   recent history of a stream (pulses sent with keep)
  keys [prefix]        list keys
  dump                 print the whole store as JSON
  watch [pattern]      stream change events ('prefix*' patterns; Ctrl+C to stop)
  clear                delete every key
  ping                 round-trip health check
  stats                daemon statistics
  shutdown             stop the daemon (it persists state first)

Options:
  -n, --ns <name>      namespace (default: "default")
      --no-spawn       fail instead of spawning a daemon if none is running
      --json           machine-readable output
  -h, --help           show this help`;

function parseArgs(argv) {
  const args = [];
  const flags = { ns: 'default', spawn: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-n' || arg === '--ns' || arg === '--namespace') {
      flags.ns = argv[++i];
    } else if (arg === '--no-spawn') {
      flags.spawn = false;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      args.push(arg);
    }
  }
  return { args, flags };
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // bare strings are convenient: bellstate set theme dark
  }
}

function print(value, json) {
  if (json || typeof value === 'object') {
    console.log(JSON.stringify(value, null, json ? 0 : 2));
  } else {
    console.log(String(value));
  }
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args;
  if (!command) {
    console.log(USAGE);
    process.exit(2);
  }

  const store = await connect({
    namespace: flags.ns,
    spawnDaemon: flags.spawn,
    autoRespawn: command === 'watch',
    // CLI-spawned daemons shouldn't outlive their usefulness forever.
    idleTimeout: 300,
  });

  const done = (code = 0) => {
    store.close();
    process.exit(code);
  };

  switch (command) {
    case 'get': {
      const value = await store.fetch(rest[0]);
      if (value === undefined) {
        console.error(`(no key '${rest[0]}')`);
        done(1);
      }
      print(value, flags.json);
      return done();
    }
    case 'set': {
      const rev = await store.set(rest[0], parseValue(rest[1] ?? 'null'));
      print(flags.json ? { rev } : `ok (rev ${rev})`, flags.json);
      return done();
    }
    case 'del': {
      const existed = await store.delete(rest[0]);
      print(flags.json ? { existed } : existed ? 'deleted' : '(did not exist)', flags.json);
      return done(existed ? 0 : 1);
    }
    case 'incr': {
      const value = await store.incr(rest[0], rest[1] != null ? Number(rest[1]) : 1);
      print(value, flags.json);
      return done();
    }
    case 'merge': {
      const rev = await store.merge(rest[0], parseValue(rest[1] ?? '{}'));
      print(flags.json ? { rev } : `ok (rev ${rev})`, flags.json);
      return done();
    }
    case 'hist': {
      const values = await store.history(rest[0], rest[1] != null ? Number(rest[1]) : 50);
      print(values, flags.json);
      return done();
    }
    case 'keys': {
      const keys = store.keys(rest[0] || '');
      print(flags.json ? keys : keys.join('\n'), flags.json);
      return done();
    }
    case 'dump': {
      console.log(JSON.stringify(store.getAll(), null, flags.json ? 0 : 2));
      return done();
    }
    case 'clear': {
      const rev = await store.clear();
      print(flags.json ? { rev } : `cleared (rev ${rev})`, flags.json);
      return done();
    }
    case 'ping': {
      const res = await store.ping();
      print(
        flags.json ? res : `pong — daemon ${res.version}, protocol v${res.v}, rev ${res.rev}`,
        flags.json
      );
      return done();
    }
    case 'stats': {
      const res = await store.stats();
      print(
        flags.json
          ? res
          : [
              `daemon    ${res.version} (protocol v${res.v})`,
              `clients   ${res.clients}`,
              `keys      ${res.keys}`,
              `rev       ${res.rev}`,
              `bytes     ${res.bytes}`,
              `wal       ${res.walBytes} bytes`,
              `uptime    ${Math.round(res.uptimeMs / 1000)}s`,
            ].join('\n'),
        flags.json
      );
      return done();
    }
    case 'shutdown': {
      await store.shutdownDaemon();
      print(flags.json ? { ok: true } : 'daemon stopped', flags.json);
      return process.exit(0);
    }
    case 'watch': {
      const pattern = rest[0] || '*';
      console.error(`watching '${pattern}' on namespace '${flags.ns}' (Ctrl+C to stop)`);
      const printChange = (c) => {
        if (flags.json) {
          console.log(JSON.stringify(c));
        } else if (c.deleted) {
          const why = c.expired ? 'expired' : c.ephemeral ? 'ephemeral gone' : 'deleted';
          console.log(`[rev ${c.rev}] ${why} ${c.key}`);
        } else {
          console.log(`[rev ${c.rev}] ${c.key} = ${JSON.stringify(c.value)}`);
        }
      };
      if (pattern === '*') store.on('change', printChange);
      else store.watch(pattern, printChange);
      store.on('disconnect', () => console.error('(daemon lost, reconnecting…)'));
      store.on('reconnect', () => console.error('(reconnected)'));
      process.on('SIGINT', () => done());
      return; // stay alive
    }
    default:
      console.error(`bellstate: unknown command '${command}'\n`);
      console.log(USAGE);
      return done(2);
  }
}

main().catch((err) => {
  console.error(`bellstate: ${err.message}`);
  process.exit(1);
});
