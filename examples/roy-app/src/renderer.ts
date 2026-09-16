// Runs as a plain script in the renderer; talks to the store via
// window.bellstate (exposed by the preload). Types come from types.d.ts.

const TODOS_KEY = 'todos';

let todos: Todo[] = [];

const listEl = document.getElementById('list') as HTMLUListElement;
const inputEl = document.getElementById('new-todo') as HTMLInputElement;
const formEl = document.getElementById('add-form') as HTMLFormElement;
const revEl = document.getElementById('rev') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;

function setStatus(text: string, ok: boolean): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok);
  statusEl.classList.toggle('bad', !ok);
}

function render(): void {
  listEl.replaceChildren();
  emptyEl.hidden = todos.length > 0;

  for (const todo of todos) {
    const li = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.done;
    checkbox.addEventListener('change', () => {
      todos = todos.map((t) => (t.id === todo.id ? { ...t, done: checkbox.checked } : t));
      void write();
    });

    const label = document.createElement('span');
    label.textContent = todo.text;
    label.classList.toggle('done', todo.done);

    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      todos = todos.filter((t) => t.id !== todo.id);
      void write();
    });

    li.append(checkbox, label, remove);
    listEl.append(li);
  }
}

function write(): Promise<number> {
  return window.bellstate.set(TODOS_KEY, todos);
}

function applyState(state: Record<string, unknown>, rev: number): void {
  todos = (state[TODOS_KEY] as Todo[] | undefined) ?? [];
  revEl.textContent = String(rev);
  render();
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  todos = [...todos, { id: crypto.randomUUID(), text, done: false }];
  inputEl.value = '';
  void write();
  render();
});

async function init(): Promise<void> {
  const { state, rev } = await window.bellstate.snapshot();
  applyState(state, rev);
  setStatus('connected', true);
  console.log(`bellstate ready — rev ${rev}, ${todos.length} todo(s)`);

  window.bellstate.onChange((payload) => {
    if (payload.type === 'change' && payload.key === TODOS_KEY) {
      todos = (payload.value as Todo[] | undefined) ?? [];
      revEl.textContent = String(payload.rev);
      render();
    } else if (payload.type === 'sync') {
      applyState(payload.state, payload.rev);
    } else if (payload.type === 'clear') {
      applyState({}, payload.rev);
    } else if (payload.type === 'disconnect') {
      setStatus('daemon lost — respawning…', false);
    } else if (payload.type === 'reconnect') {
      setStatus('connected', true);
    }
  });
}

void init();
