import { Worker } from 'node:worker_threads';
import type { Logger } from 'pino';

/**
 * Runs model-generated Python in a Pyodide (WASM) sandbox on a worker thread.
 *
 * - Pluggable boundary: the chat tool depends on this CodeExecutor interface, not on Pyodide — a
 *   container/microVM executor can be swapped in later without touching the tool or the chat.
 * - The worker lazy-loads Pyodide on first run (boot stays fast). A hard timeout terminates the
 *   worker (the only reliable way to interrupt synchronous WASM); it respawns on the next call.
 * - Executions are serialized (one VM, modest interactive use); concurrent calls queue.
 */
export interface CodeFile {
  name: string;
  b64: string;
}
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: { name: string; b64: string; mime: string; size: number }[];
  timedOut?: boolean;
}
export interface CodeExecutor {
  run(code: string, files?: CodeFile[]): Promise<ExecResult>;
  dispose(): Promise<void>;
}

// dev (tsx) runs the .ts worker; prod runs the compiled .js — pick the right extension.
const WORKER_URL = new URL(`./worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);

export class PyodideExecutor implements CodeExecutor {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: Logger,
    private readonly timeoutMs = 30_000,
  ) {}

  private spawn(): Worker {
    // The WASM-memory cap is applied inside the worker via v8.setFlagsFromString (worker execArgv
    // rejects V8 flags). resourceLimits bounds the JS heap; the worker caps WASM linear memory itself.
    const w = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: 768 } });
    w.on('error', (err) => this.log.warn({ err }, 'interpreter worker error'));
    w.unref(); // don't keep the process alive for an idle interpreter
    return w;
  }

  run(code: string, files: CodeFile[] = []): Promise<ExecResult> {
    // Chain onto the queue so executions never overlap on the single VM.
    const result = this.queue.then(() => this.runExclusive(code, files));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private runExclusive(code: string, files: CodeFile[]): Promise<ExecResult> {
    if (!this.worker) this.worker = this.spawn();
    const worker = this.worker;
    return new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        worker.terminate().catch(() => {});
        this.worker = null; // respawn next time
        resolve({ ok: false, stdout: '', stderr: `Execution timed out after ${this.timeoutMs} ms.`, outputs: [], timedOut: true });
      }, this.timeoutMs);

      const onMessage = (m: ExecResult) => {
        cleanup();
        resolve(m);
      };
      const onError = (err: Error) => {
        cleanup();
        this.worker = null;
        resolve({ ok: false, stdout: '', stderr: err.message, outputs: [] });
      };
      const onExit = () => {
        cleanup();
        this.worker = null;
        resolve({ ok: false, stdout: '', stderr: 'Interpreter worker exited unexpectedly.', outputs: [] });
      };
      function cleanup() {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      }
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ code, files });
    });
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate().catch(() => {});
      this.worker = null;
    }
  }
}
