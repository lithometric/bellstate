# bellstate-angular

Angular signals for [bellstate](https://github.com/lithometric/bellstate) — machine-global state for Electron and Node processes, backed by a Rust daemon.

```bash
npm install bellstate bellstate-angular
```

Set up bellstate in your Electron main process (`initBellstate`) and preload (`exposeBellstate`) — see the [bellstate README](https://github.com/lithometric/bellstate#quickstart-electron). Then, in any component (Angular 16+):

```ts
import { Component } from '@angular/core';
import { bellstateSignal, setBellstate, incrBellstate, bellstateConnected } from 'bellstate-angular';

@Component({
  selector: 'app-counter',
  template: `
    <button (click)="incr()">{{ counter() }}</button>
    <span>{{ connected() ? 'online' : 'offline' }}</span>
  `,
})
export class CounterComponent {
  counter = bellstateSignal<number>('counter', 0);
  connected = bellstateConnected();
  incr = () => incrBellstate('counter');
}
```

- `bellstateSignal(key, initial)` → `Signal<T>` — updates when **any process on the machine** writes the key.
- `setBellstate(key, value, opts?)` / `mergeBellstate(key, partial)` / `deleteBellstate(key)` — writes through the daemon; resolve with the new store revision.
- `incrBellstate(key, by?)` — server-side atomic increment.
- `bellstateConnected()` → `Signal<boolean>`, `bellstateRev()` → `Signal<number>`.

Works with the Angular CLI, Vite, or any bundler — everything talks to the `window.bellstate` bridge exposed by the preload script; nothing Node-specific runs in the renderer.

MIT
