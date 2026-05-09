import type { RunEvent } from "@claudeos/runtime-client/contracts";

type Listener = (event: RunEvent) => void;

/**
 * In-process pub/sub. WebSocket handlers subscribe to a run_id; the run
 * orchestrator publishes each RunEvent. Subscribers receive only events
 * published after they subscribe — replay of older events comes from the
 * database, not the bus.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(runId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, event: RunEvent): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const l of set) {
      try {
        l(event);
      } catch {
        // Listener errors must not stop the run.
      }
    }
  }
}
