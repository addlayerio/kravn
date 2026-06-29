import { EventEmitter } from 'node:events';

export interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  context?: Record<string, unknown>;
}

/**
 * In-memory ring buffer + live fan-out for the admin log viewer (consumed over SSE).
 * Single-node by design; a multi-replica build would back this with Redis pub/sub.
 */
export class LogStore extends EventEmitter {
  private buffer: LogEntry[] = [];

  constructor(private capacity = 500) {
    super();
    this.setMaxListeners(0);
  }

  add(level: LogEntry['level'], msg: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg, context };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emit('entry', entry);
  }

  recent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit);
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.on('entry', fn);
    return () => this.off('entry', fn);
  }
}
