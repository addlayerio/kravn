import { EventEmitter } from 'node:events';
import { appSettingsSchema, defaultSettings, mergeSettings, type AppSettings } from '@kravn/contracts';
import type { SettingsRepo } from '../db/repos.js';
import type { Logger } from 'pino';

/**
 * The runtime application-config service — the engine behind "configuration lives in the app".
 *
 * - Loads settings from the DB, merged over schema defaults (so new fields get sane defaults).
 * - Keeps a validated in-memory snapshot for fast synchronous reads.
 * - Persists updates and emits 'change' so consumers (SSRF policy, rate limiter, transports)
 *   hot-apply WITHOUT a restart. In a multi-replica future, the same 'change' event is what a
 *   Redis pub/sub subscriber would fire on every node.
 */
export class SettingsService extends EventEmitter {
  private current: AppSettings = defaultSettings();
  private loaded = false;

  constructor(private repo: SettingsRepo, private log: Logger) {
    super();
  }

  async init(): Promise<void> {
    const raw = await this.repo.getRaw();
    if (!raw) {
      this.current = defaultSettings();
      await this.repo.setRaw(JSON.stringify(this.current));
    } else {
      try {
        const parsed = appSettingsSchema.parse(JSON.parse(raw));
        this.current = parsed;
      } catch (err) {
        this.log.warn({ err }, 'stored settings failed validation; falling back to defaults merged over stored values');
        try {
          this.current = mergeSettings(defaultSettings(), JSON.parse(raw));
          await this.repo.setRaw(JSON.stringify(this.current));
        } catch {
          this.current = defaultSettings();
        }
      }
    }
    this.loaded = true;
    this.emit('change', this.current);
  }

  get(): AppSettings {
    return this.current;
  }

  /** Validate a deep-merge patch, persist, swap the snapshot, and notify subscribers. */
  async update(patch: unknown): Promise<AppSettings> {
    const next = mergeSettings(this.current, patch);
    await this.repo.setRaw(JSON.stringify(next));
    this.current = next;
    this.log.info('application settings updated');
    this.emit('change', next);
    return next;
  }

  onChange(fn: (s: AppSettings) => void): void {
    this.on('change', fn);
    if (this.loaded) fn(this.current);
  }
}
