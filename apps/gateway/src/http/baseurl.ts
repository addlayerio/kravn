import type { FastifyRequest } from 'fastify';
import type { SettingsService } from '../settings/settings.service.js';
import type { Env } from '../config/env.js';

/** Resolve the externally-visible base URL: explicit config wins, else derive from the request. */
export function deriveBaseUrl(req: FastifyRequest, settings: SettingsService, env: Env): string {
  const configured = settings.get().general.publicUrl || env.publicUrl;
  if (configured) return configured.replace(/\/$/, '');
  const proto = ((req.headers['x-forwarded-proto'] as string) || req.protocol || 'http').split(',')[0];
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}
