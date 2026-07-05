import { KRAVN_VERSION } from '@kravn/contracts';

/**
 * The running gateway version reported to the console (dashboard), the bootstrap/system info and MCP
 * serverInfo. It is injected into the image at build time as the `KRAVN_VERSION` env var (from the release
 * git tag / chart `appVersion` — the single source of truth). For local/dev runs where that env isn't set,
 * it falls back to the `KRAVN_VERSION` constant in `@kravn/contracts`.
 */
export const APP_VERSION = process.env.KRAVN_VERSION?.trim() || KRAVN_VERSION;
