// Shared types for the renderer, which runs as a plain script (no modules).

// Type alias (not interface) so it's structurally assignable to JsonValue.
type Todo = {
  id: string;
  text: string;
  done: boolean;
};

interface Window {
  bellstate: import('bellstate/preload').BellstateRendererApi;
}
