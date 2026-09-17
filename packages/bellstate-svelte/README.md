# bellstate-svelte

Svelte stores for [bellstate](https://github.com/lithometric/bellstate) — machine-global state for Electron and Node processes, backed by a Rust daemon. Zero dependencies: implements the plain store contract, so it works with every Svelte version (including Svelte 5).

```bash
npm install bellstate bellstate-svelte
```

Set up bellstate in your Electron main process (`initBellstate`) and preload (`exposeBellstate`) — see the [bellstate README](https://github.com/lithometric/bellstate#quickstart-electron). Then, in any component:

```svelte
<script>
  import { bellstateStore, incrBellstate, bellstateConnected } from 'bellstate-svelte';

  const theme = bellstateStore('theme', 'light');
  const connected = bellstateConnected();
</script>

<input bind:value={$theme} />
<button on:click={() => incrBellstate('counter')}>+1 {$connected ? '●' : '○'}</button>
```

- `bellstateStore(key, initial)` → writable store — `$store` updates when **any process on the machine** writes the key; `set`/`update` write through the daemon.
- `setBellstate(key, value, opts?)` / `mergeBellstate(key, partial)` — awaitable writes; resolve with the new store revision.
- `incrBellstate(key, by?)` — server-side atomic increment.
- `bellstateConnected()` / `bellstateRev()` — readable stores for connection state and store revision.

Works with Vite/SvelteKit or any bundler — the stores talk to the `window.bellstate` bridge exposed by the preload script; nothing Node-specific runs in the renderer.

MIT
