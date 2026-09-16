'use strict';

// MultiBoard renderer. All board state lives in bellstate; this file
// projects the store onto an SVG canvas and turns gestures into intents.
//
// Motion architecture:
//  - OUTBOUND: adaptive coalescing senders. Intermediate positions collapse
//    into one write per tick, and the tick length scales with how many
//    users are on the board (a fixed total write budget is divided among
//    everyone), so the daemon's load stays flat as users join.
//  - INBOUND: network updates only set *targets*. A requestAnimationFrame
//    loop interpolates shapes and cursors toward their targets every
//    display frame and moves them with cheap transform updates — so remote
//    motion renders at your monitor's refresh rate (120Hz+ on ProMotion)
//    no matter how often packets arrive. Structural changes (add/delete,
//    color, text, z-order, locks) still trigger a full repaint.

const svg = document.getElementById('canvas');
const cursorsEl = document.getElementById('cursors');
const toastsEl = document.getElementById('toasts');
const peersEl = document.getElementById('peers');
const statusEl = document.getElementById('status');
const revEl = document.getElementById('rev');
const rateEl = document.getElementById('rate');
const shapeCountEl = document.getElementById('shape-count');
const createdEl = document.getElementById('created-count');

const SWATCH_COLORS = ['#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444'];

let me = { name: '…', color: '#888', cursorKey: '' };
const shapes = new Map(); // id -> shape (authoritative store state)
const assets = new Map(); // assetId -> dataURL
const locks = new Map(); // shapeId -> {name, color}
const peers = new Map(); // presenceKey -> {name, color}
const nodeMap = new Map(); // shapeId -> <g> element (rebuilt on repaint)
let selection = null;
let fill = SWATCH_COLORS[0];
let drag = null; // {id, startX, startY, origX, origY, held, upEarly}
let queuePoll = null; // offline-queue status polling during outages

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- motion streaming: the pulse lane -------------------------------------
// Cursors and drag motion ride bellstate's transient pulse lane: no
// revision, no WAL, no ack — pure daemon fan-out, benchmarked here at
// ~350k msgs/sec with ~0.05ms median latency. That's headroom for ~2,900
// users at 120Hz, so every user streams at their display's native refresh
// rate (rAF-gated: one pulse per rendered frame). Committed state (final
// positions) still goes through the durable KV lane.
//
// A frameskip guard divides a 6,000 pulse/sec board-wide budget among live
// users — it only starts skipping frames past ~50 simultaneous users.

let pendingCursor = null; // {x, y}
let pendingDrag = null; // {id, x, y}
let pulsesSent = 0;
let frameCount = 0;

const frameskip = () =>
  Math.max(1, Math.ceil((Math.max(1, peers.size) * 120) / 6000));

function flushMotion() {
  frameCount++;
  if (frameCount % frameskip() !== 0) return;
  if (pendingCursor) {
    window.bellstate.pulse(me.cursorKey, { ...pendingCursor, name: me.name, color: me.color });
    pendingCursor = null;
    pulsesSent++;
  }
  if (pendingDrag) {
    window.bellstate.pulse(`drag:${pendingDrag.id}`, pendingDrag);
    pendingDrag = null;
    pulsesSent++;
  }
}

setInterval(() => {
  const active = pulsesSent > 0;
  const hz = Math.round(120 / frameskip());
  rateEl.textContent = `pulse ${active ? pulsesSent : hz}Hz · ${Math.max(1, peers.size)} user${peers.size === 1 ? '' : 's'}`;
  pulsesSent = 0;
}, 1000);

function updateRateDisplay() {} // live counter above handles it

// ---- interpolation loop ---------------------------------------------------
// anim: shapeId -> {cx, cy, tx, ty}; cursorAnim: key -> {el, cx, cy, tx, ty}

const anim = new Map();
const cursorAnim = new Map();

function setShapeTarget(id, x, y) {
  let a = anim.get(id);
  if (!a) {
    const prev = shapes.get(id);
    a = { cx: prev?.x ?? x, cy: prev?.y ?? y, tx: x, ty: y };
    anim.set(id, a);
  }
  a.tx = x;
  a.ty = y;
}

let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(50, t - lastFrame);
  lastFrame = t;
  // Exponential smoothing: frame-rate independent. With pulses arriving at
  // display rate, a short ~35ms time constant tracks tightly with no step.
  const alpha = 1 - Math.exp(-dt / 35);

  for (const [id, a] of anim) {
    a.cx += (a.tx - a.cx) * alpha;
    a.cy += (a.ty - a.cy) * alpha;
    if (Math.abs(a.tx - a.cx) < 0.4 && Math.abs(a.ty - a.cy) < 0.4) {
      a.cx = a.tx;
      a.cy = a.ty;
    }
    nodeMap.get(id)?.setAttribute('transform', `translate(${a.cx} ${a.cy})`);
    if (a.cx === a.tx && a.cy === a.ty) anim.delete(id);
  }

  for (const [key, a] of cursorAnim) {
    a.cx += (a.tx - a.cx) * alpha;
    a.cy += (a.ty - a.cy) * alpha;
    if (Math.abs(a.tx - a.cx) < 0.3 && Math.abs(a.ty - a.cy) < 0.3) {
      a.cx = a.tx;
      a.cy = a.ty;
    }
    a.el.style.transform = `translate3d(${a.cx}px, ${a.cy}px, 0)`;
    if (!a.el.isConnected) cursorAnim.delete(key);
  }

  flushMotion(); // outbound pulses, gated to one per rendered frame
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- painting -------------------------------------------------------------

function noteLines(text, width) {
  const perLine = Math.max(8, Math.floor(width / 8.2));
  const words = String(text || '').split(/\s+/);
  const lines = [''];
  for (const w of words) {
    if ((lines[lines.length - 1] + ' ' + w).trim().length > perLine) lines.push(w);
    else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim();
  }
  return lines.slice(0, 5);
}

// Shape bodies are drawn at the origin; position lives in the group's
// transform, which is what the interpolation loop animates cheaply.
function shapeSvg(s, pos) {
  const lock = locks.get(s.id);
  const mineLock = lock && lock.name === me.name;
  const selected = selection === s.id;
  const cls = `shape${lock && !mineLock ? ' locked-other' : ''}`;
  let body = '';

  if (s.type === 'rect') {
    body = `<rect width="${s.w}" height="${s.h}" rx="10" fill="${esc(s.fill)}"/>`;
  } else if (s.type === 'ellipse') {
    body = `<ellipse cx="${s.w / 2}" cy="${s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" fill="${esc(s.fill)}"/>`;
  } else if (s.type === 'note') {
    const lines = noteLines(s.text, s.w)
      .map((l, i) => `<text x="14" y="${30 + i * 20}" font-size="14" fill="#4b3d10">${esc(l)}</text>`)
      .join('');
    body = `<rect width="${s.w}" height="${s.h}" rx="6" fill="${esc(s.fill || '#FEF3C7')}"/>${lines}`;
  } else if (s.type === 'image') {
    const data = assets.get(s.assetId);
    body = data
      ? `<image width="${s.w}" height="${s.h}" href="${data}" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect width="${s.w}" height="${s.h}" rx="10" fill="#2c2c33"/>` +
        `<text x="${s.w / 2}" y="${s.h / 2}" font-size="13" fill="#8b8b94" text-anchor="middle">receiving image…</text>`;
  }

  let outline = '';
  if (lock && !mineLock) {
    outline =
      `<rect x="-4" y="-4" width="${s.w + 8}" height="${s.h + 8}" rx="12" fill="none" stroke="${esc(lock.color)}" stroke-width="2" stroke-dasharray="6 4"/>` +
      `<text class="lock-tag" x="0" y="-10" fill="${esc(lock.color)}">${esc(lock.name)} ✋</text>`;
  } else if (selected) {
    outline = `<rect x="-3" y="-3" width="${s.w + 6}" height="${s.h + 6}" rx="12" fill="none" stroke="#6d6df0" stroke-width="1.5"/>`;
  }

  return `<g class="${cls}" data-id="${esc(s.id)}" transform="translate(${pos.x} ${pos.y})">${body}${outline}</g>`;
}

function repaint() {
  // z is a fractional-index string: plain lexicographic order.
  const ordered = [...shapes.values()].sort((a, b) =>
    String(a.z ?? '') < String(b.z ?? '') ? -1 : 1
  );
  svg.innerHTML = ordered
    .map((s) => {
      const a = anim.get(s.id);
      // Keep mid-flight shapes at their animated position through a repaint.
      return shapeSvg(s, a ? { x: a.cx, y: a.cy } : s);
    })
    .join('');
  nodeMap.clear();
  for (const g of svg.querySelectorAll('.shape')) nodeMap.set(g.dataset.id, g);
  shapeCountEl.textContent = `${shapes.size} shape${shapes.size === 1 ? '' : 's'}`;
}

function repaintPeers() {
  peersEl.innerHTML = '';
  for (const p of peers.values()) {
    const el = document.createElement('div');
    el.className = 'avatar';
    el.title = p.name;
    el.textContent = p.name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2);
    el.style.background = p.color;
    peersEl.appendChild(el);
  }
  updateRateDisplay();
}

function setCursorTarget(key, c) {
  if (key === me.cursorKey) return;
  let a = cursorAnim.get(key);
  if (!a) {
    const el = document.createElement('div');
    el.className = 'cursor';
    el.innerHTML =
      `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1 L16 8 L9 10 L6 17 Z" stroke="#111" stroke-width="1"/></svg>` +
      `<span class="name"></span>`;
    cursorsEl.appendChild(el);
    a = { el, cx: c.x, cy: c.y, tx: c.x, ty: c.y }; // first sight: snap
    cursorAnim.set(key, a);
  }
  a.el.querySelector('path').setAttribute('fill', c.color);
  const name = a.el.querySelector('.name');
  name.textContent = c.name;
  name.style.background = c.color;
  a.tx = c.x;
  a.ty = c.y;
}

function removeCursor(key) {
  cursorAnim.get(key)?.el.remove();
  cursorAnim.delete(key);
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok);
}

// ---- store wiring ---------------------------------------------------------

function structurallyDiffers(a, b) {
  return (
    !a ||
    a.type !== b.type ||
    a.w !== b.w ||
    a.h !== b.h ||
    a.fill !== b.fill ||
    a.text !== b.text ||
    a.z !== b.z ||
    a.assetId !== b.assetId
  );
}

function absorb(key, value, deleted) {
  if (key.startsWith('shape:')) {
    const id = key.slice(6);
    if (deleted) {
      shapes.delete(id);
      anim.delete(id);
      if (selection === id) selection = null;
      repaint();
      return;
    }
    if (drag && drag.id === id) {
      shapes.set(id, { ...value, x: shapes.get(id)?.x ?? value.x, y: shapes.get(id)?.y ?? value.y });
      return; // my drag owns this node's position
    }
    const prev = shapes.get(id);
    shapes.set(id, value);
    if (!structurallyDiffers(prev, value) && nodeMap.has(id)) {
      setShapeTarget(id, value.x, value.y); // pure motion → interpolate
    } else {
      repaint();
    }
  } else if (key.startsWith('asset:')) {
    if (deleted) assets.delete(key.slice(6));
    else assets.set(key.slice(6), value);
    repaint();
  } else if (key.startsWith('lock:shape:')) {
    const id = key.slice(11);
    if (deleted) locks.delete(id);
    else locks.set(id, value);
    repaint();
  } else if (key.startsWith('presence:')) {
    if (deleted) peers.delete(key);
    else peers.set(key, value);
    repaintPeers();
  } else if (key.startsWith('cursor:')) {
    if (deleted) removeCursor(key);
    else setCursorTarget(key, value);
  } else if (key.startsWith('toast:')) {
    if (deleted) document.getElementById(`toast-${key.slice(6)}`)?.remove();
    else {
      const el = document.createElement('div');
      el.className = 'toast';
      el.id = `toast-${key.slice(6)}`;
      el.textContent = value.text;
      toastsEl.appendChild(el);
    }
  } else if (key === 'stat:created') {
    createdEl.textContent = `${value} created all-time`;
  } else if (key === 'vault:note') {
    // Arrives already decrypted (this app holds the machine key). On disk
    // and to key-less clients it's an AES-256-GCM envelope.
    const el = document.getElementById('vault-note');
    if (deleted || !value?.text) {
      el.hidden = true;
    } else {
      el.hidden = false;
      document.getElementById('vault-text').textContent = value.text;
      document.getElementById('vault-by').textContent = `— ${value.by}`;
    }
  }
}

function appendChat({ name, color, text }) {
  const log = document.getElementById('chat-log');
  const el = document.createElement('div');
  el.className = 'msg';
  const who = document.createElement('b');
  who.textContent = name;
  who.style.color = color;
  el.append(who, document.createTextNode(` ${text}`));
  log.appendChild(el);
  while (log.children.length > 40) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function rebuildAll(state) {
  shapes.clear();
  assets.clear();
  locks.clear();
  peers.clear();
  anim.clear();
  for (const a of cursorAnim.values()) a.el.remove();
  cursorAnim.clear();
  for (const [key, value] of Object.entries(state)) absorb(key, value, false);
  repaint();
  repaintPeers();
}

async function init() {
  me = await window.board.me();
  const chip = document.getElementById('me-chip');
  chip.textContent = me.name;
  chip.style.background = me.color;
  chip.style.color = '#111';

  const { state, rev } = await window.bellstate.snapshot();
  rebuildAll(state);
  revEl.textContent = `rev ${rev}`;
  setStatus('live', true);
  console.log(`bellstate ready — rev ${rev}, ${shapes.size} shape(s)`);

  // Stream backfill: this window may have opened mid-conversation — pull
  // the chat channel's bounded history (kept in the daemon, memory-only).
  const backlog = await window.bellstate.history('chat', 40);
  for (const msg of backlog) appendChat(msg);

  window.bellstate.onChange((payload) => {
    if (payload.type === 'pulse') {
      // Transient motion lane: cursor and drag streams at display rate.
      if (payload.ch === 'chat') {
        appendChat(payload.value);
      } else if (payload.ch.startsWith('cursor:')) {
        setCursorTarget(payload.ch, payload.value);
      } else if (payload.ch.startsWith('drag:')) {
        const id = payload.ch.slice(5);
        if (!(drag && drag.id === id)) {
          const s = shapes.get(id);
          if (s) {
            s.x = payload.value.x;
            s.y = payload.value.y;
            setShapeTarget(id, s.x, s.y);
          }
        }
      }
    } else if (payload.type === 'change') {
      revEl.textContent = `rev ${payload.rev}`;
      absorb(payload.key, payload.value, payload.deleted);
    } else if (payload.type === 'sync') {
      revEl.textContent = `rev ${payload.rev}`;
      rebuildAll(payload.state);
    } else if (payload.type === 'clear') {
      rebuildAll({});
    } else if (payload.type === 'disconnect') {
      setStatus('daemon lost — recovering…', false);
      // Offline queue: writes made during the outage are held in the main
      // process and flushed on reconnect — show how many are waiting.
      queuePoll = setInterval(async () => {
        const queued = await window.board.queue();
        setStatus(`daemon lost — recovering… (${queued} queued)`, false);
      }, 250);
    } else if (payload.type === 'reconnect') {
      clearInterval(queuePoll);
      setStatus('live', true);
    }
  });
}

// ---- tools ----------------------------------------------------------------

const jitter = () => Math.round((Math.random() - 0.5) * 160);

function addShape(type) {
  const base = {
    x: Math.round(svg.clientWidth / 2 - 90) + jitter(),
    y: Math.round(svg.clientHeight / 2 - 60) + jitter(),
  };
  if (type === 'note') {
    window.board.add({ type, ...base, w: 210, h: 140, fill: '#FEF3C7', text: 'Double-click to edit' });
  } else {
    window.board.add({ type, ...base, w: 180, h: 120, fill });
  }
}

document.getElementById('tool-rect').addEventListener('click', () => addShape('rect'));
document.getElementById('tool-ellipse').addEventListener('click', () => addShape('ellipse'));
document.getElementById('tool-note').addEventListener('click', () => addShape('note'));

const imageInput = document.getElementById('image-input');
document.getElementById('tool-image').addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  imageInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(440, img.naturalWidth);
      const h = Math.round((w / img.naturalWidth) * img.naturalHeight);
      window.board.addImage({
        dataUrl: reader.result,
        x: Math.round(svg.clientWidth / 2 - w / 2) + jitter(),
        y: Math.round(svg.clientHeight / 2 - h / 2) + jitter(),
        w,
        h,
      });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

const swatchesEl = document.getElementById('swatches');
for (const color of SWATCH_COLORS) {
  const el = document.createElement('button');
  el.className = 'swatch' + (color === fill ? ' active' : '');
  el.style.background = color;
  el.addEventListener('click', () => {
    fill = color;
    swatchesEl.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
    el.classList.add('active');
    if (selection) window.board.patch(selection, { fill: color });
  });
  swatchesEl.appendChild(el);
}

document.getElementById('tool-front').addEventListener('click', () => {
  if (selection) window.board.front(selection);
});
document.getElementById('tool-back').addEventListener('click', () => {
  if (selection) window.board.back(selection);
});
document.getElementById('tool-delete').addEventListener('click', () => {
  if (selection) window.board.remove(selection);
});
document.getElementById('tool-undo').addEventListener('click', () => window.bellstate.undo());
document.getElementById('tool-redo').addEventListener('click', () => window.bellstate.redo());
document.getElementById('tool-vault').addEventListener('click', () => {
  const text = prompt('Shared secret note (encrypted at rest):');
  if (text != null) window.board.vault(text);
});

const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !chatInput.value.trim()) return;
  // Stream lane: broadcast now, and the daemon retains the last 40 in
  // memory so late-joining windows backfill (see init()).
  window.bellstate.pulse('chat', { name: me.name, color: me.color, text: chatInput.value.trim() }, 40);
  chatInput.value = '';
});
document.getElementById('tool-template').addEventListener('click', () => window.board.template());
document.getElementById('tool-clear').addEventListener('click', () => window.board.clear());
document.getElementById('tool-crash').addEventListener('click', () => window.board.crashDaemon());

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) window.bellstate.redo();
    else window.bellstate.undo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
    window.board.remove(selection);
  } else if (e.key === 'Escape') {
    selection = null;
    repaint();
  } else if (e.key === ']' && (e.metaKey || e.ctrlKey) && selection) window.board.front(selection);
  else if (e.key === '[' && (e.metaKey || e.ctrlKey) && selection) window.board.back(selection);
  else if (e.key === 'r') addShape('rect');
  else if (e.key === 'o') addShape('ellipse');
  else if (e.key === 'n') addShape('note');
});

// ---- drag (with machine-global locking) -----------------------------------

svg.addEventListener('pointerdown', async (e) => {
  const g = e.target.closest('.shape');
  if (!g) {
    selection = null;
    repaint();
    return;
  }
  const id = g.dataset.id;
  const s = shapes.get(id);
  if (!s) return;
  selection = id;
  repaint();

  drag = { id, startX: e.clientX, startY: e.clientY, origX: s.x, origY: s.y, held: false, upEarly: false };
  const ok = await window.board.grab(id); // machine-global lock
  if (!drag || drag.id !== id) {
    if (ok) window.board.drop(id);
    return;
  }
  if (!ok) {
    drag = null; // someone else is holding it; the dashed outline says who
    return;
  }
  drag.held = true;
  anim.delete(id); // I own this node's position now — no lerp on my side
  // Crash safety: commit the in-flight position to the durable lane every
  // 400ms; live motion itself rides the pulse lane at display rate.
  drag.commitTimer = setInterval(() => {
    const s = shapes.get(id);
    if (s) window.board.patch(id, { x: Math.round(s.x), y: Math.round(s.y) });
  }, 400);
  if (drag.upEarly) {
    clearInterval(drag.commitTimer);
    window.board.drop(id);
    drag = null;
  }
});

window.addEventListener('pointermove', (e) => {
  if (drag && drag.held) {
    const s = shapes.get(drag.id);
    if (s) {
      s.x = drag.origX + (e.clientX - drag.startX);
      s.y = drag.origY + (e.clientY - drag.startY);
      // Zero-latency locally: move just this node's transform, no rebuild.
      nodeMap.get(drag.id)?.setAttribute('transform', `translate(${s.x} ${s.y})`);
      pendingDrag = { id: drag.id, x: Math.round(s.x), y: Math.round(s.y) };
    }
  }
});

window.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.held) {
    clearInterval(drag.commitTimer);
    pendingDrag = null;
    const s = shapes.get(drag.id);
    if (s) window.board.patch(drag.id, { x: Math.round(s.x), y: Math.round(s.y) });
    window.board.drop(drag.id);
    drag = null;
  } else {
    drag.upEarly = true; // grab still in flight; release once it resolves
  }
});

svg.addEventListener('dblclick', (e) => {
  const g = e.target.closest('.shape');
  if (!g) return;
  const s = shapes.get(g.dataset.id);
  if (s?.type !== 'note') return;
  const text = prompt('Note text:', s.text || '');
  if (text != null) window.board.patch(s.id, { text });
});

// My cursor: motion streams on the pulse lane at display rate; a low-rate
// ephemeral + TTL KV write (same key) is the liveness marker — its deletion
// is what removes my cursor from other screens when this app dies.
let lastCursorKv = 0;
document.getElementById('stage').addEventListener('pointermove', (e) => {
  const rect = svg.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left);
  const y = Math.round(e.clientY - rect.top);
  pendingCursor = { x, y };
  const t = performance.now();
  if (t - lastCursorKv > 2000) {
    lastCursorKv = t;
    window.board.cursor(x, y);
  }
});

init();
