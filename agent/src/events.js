// In-process broadcaster. audit.js publishes every step here; the SSE endpoint
// (GET /events, Phase 7) subscribes and forwards to the dashboard.
import { EventEmitter } from 'node:events';

export function createEvents() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // one listener per open dashboard tab
  return {
    publish: (event) => emitter.emit('event', event),
    subscribe: (fn) => {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
  };
}
