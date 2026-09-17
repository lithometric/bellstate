# bellstate-vue

Vue 3 composables for [bellstate](https://github.com/lithometric/bellstate) — machine-global state for Electron and Node processes, backed by a Rust daemon.

```bash
npm install bellstate bellstate-vue
```

Set up bellstate in your Electron main process (`initBellstate`) and preload (`exposeBellstate`) — see the [bellstate README](https://github.com/lithometric/bellstate#quickstart-electron). Then, in any component:

```vue
<script setup>
import { useBellstate, useBellstateIncr, useBellstateStatus } from 'bellstate-vue';

const theme = useBellstate('theme', 'light');   // writable computed — v-model works
const incr = useBellstateIncr('counter');
const connected = useBellstateStatus();
</script>

<template>
  <input v-model="theme" />
  <button @click="incr()">+1 {{ connected ? '●' : '○' }}</button>
</template>
```

- `useBellstate(key, initial)` → writable computed ref — updates when **any process on the machine** writes the key; assignment writes through the daemon.
- `setBellstate(key, value, opts?)` / `mergeBellstate(key, partial)` — awaitable writes; resolve with the new store revision.
- `useBellstateIncr(key)` — server-side atomic increment.
- `useBellstateStatus()` / `useBellstateRev()` — read-only refs for connection state and store revision.

Works with Vite or any bundler — the composables talk to the `window.bellstate` bridge exposed by the preload script; nothing Node-specific runs in the renderer.

MIT
