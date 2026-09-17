# bellstate-react

React hooks for [bellstate](https://github.com/lithometric/bellstate) — machine-global state for Electron and Node processes, backed by a Rust daemon.

```bash
npm install bellstate bellstate-react
```

Set up bellstate in your Electron main process (`initBellstate`) and preload (`exposeBellstate`) — see the [bellstate README](https://github.com/lithometric/bellstate#quickstart-electron). Then, in any renderer component:

```jsx
import { useBellstate, useBellstateIncr, useBellstateStatus } from 'bellstate-react';

function Counter() {
  const [theme, setTheme] = useBellstate('theme', 'light');
  const incr = useBellstateIncr('counter');
  const connected = useBellstateStatus();

  return (
    <button onClick={() => incr()}>
      {theme} {connected ? '●' : '○'}
    </button>
  );
}
```

- `useBellstate(key, initial)` → `[value, set]` — re-renders when **any process on the machine** writes the key.
- `useBellstateIncr(key)` → `(by?) => Promise<number>` — server-side atomic increment.
- `useBellstateStatus()` → `boolean` — true while the main process is connected to the daemon.
- `useBellstateRev()` → `number` — the store revision, bumped on every write.

Works with any bundler (Vite, webpack, esbuild) — the hooks talk to the `window.bellstate` bridge exposed by the preload script; nothing Node-specific runs in the renderer.

MIT
