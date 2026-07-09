import { EventEmitter } from 'node:events';

/**
 * In-process event bus for pushing state changes to connected operator UIs over SSE (see /api/events),
 * so the console reflects changes as they happen instead of polling. Process-local: each replica notifies
 * only the UIs connected to it (fine — the operator reconnects/reloads on navigation anyway).
 */
export type KravnEvent =
  | 'registry' // servers/tools/plugins changed → refresh the registry views
  | 'approvals'; // a tool-call approval was requested/resolved → refresh the approvals queue

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // one listener per connected SSE client; don't warn on many
  }
  fire(event: KravnEvent): void {
    this.emit(event);
  }
}
