import net from 'node:net';
import dns from 'node:dns';
import { Agent } from 'undici';
import type { SettingsService } from '../settings/settings.service.js';
import type { Logger } from 'pino';

/**
 * SSRF defense.
 *
 * Node has no built-in SSRF protection, so this is hand-built and security-critical:
 *  - DNS is resolved by us and the resulting IP is PINNED for the socket (anti-rebinding).
 *  - Every resolved IP is classified; private/reserved ranges are blocked UNLESS the operator
 *    has enabled private networks (default ON, because an in-cluster gateway must reach in-cluster
 *    services). Cloud metadata endpoints stay blocked regardless.
 *  - Fail-closed: any resolution/parse error rejects the connection.
 *
 * The guard reads live settings on every lookup, so toggling the policy in the UI takes effect
 * immediately without rebuilding the dispatcher.
 */

function ipv4ToInt(ip: string): number | null {
  const m = ip.split('.');
  if (m.length !== 4) return null;
  let n = 0;
  for (const part of m) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local (includes metadata 169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function isPrivateOrReservedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparoseable -> fail closed
  return PRIVATE_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

function isPrivateOrReservedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedV4(mapped[1]);
  if (lower.startsWith('fe80') || lower.startsWith('fec0')) return true; // link-local / site-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (fc00::/7)
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('2001:db8')) return true; // documentation
  return false;
}

export function isPrivateOrReserved(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateOrReservedV4(ip);
  if (fam === 6) return isPrivateOrReservedV6(ip);
  return true; // not an IP -> fail closed
}

export class SsrfGuard {
  readonly agent: Agent;

  constructor(private settings: SettingsService, private log: Logger) {
    this.agent = new Agent({
      connect: {
        // Custom lookup: resolve, validate, and pin.
        lookup: (hostname, options, callback) => this.lookup(hostname, options, callback),
      },
    });
  }

  private hostBlocked(hostname: string): boolean {
    const blocked = this.settings.get().security.ssrfBlockedHosts.map((h) => h.toLowerCase());
    return blocked.includes(hostname.toLowerCase());
  }

  private ipAllowed(ip: string): boolean {
    const allowPrivate = this.settings.get().security.ssrfAllowPrivateNetworks;
    const blockedHosts = this.settings.get().security.ssrfBlockedHosts;
    if (blockedHosts.includes(ip)) return false; // explicit metadata IPs always blocked
    // 169.254.169.254 family metadata stays blocked even when private is allowed.
    if (ip === '169.254.169.254' || ip === '169.254.170.2' || ip === '100.100.100.200') return false;
    if (isPrivateOrReserved(ip)) return allowPrivate;
    return true;
  }

  private lookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
  ): void {
    if (this.hostBlocked(hostname)) {
      callback(new Error(`SSRF: host '${hostname}' is blocked`), null);
      return;
    }

    const literal = net.isIP(hostname);
    if (literal) {
      if (!this.ipAllowed(hostname)) {
        callback(new Error(`SSRF: address '${hostname}' is not allowed`), null);
        return;
      }
      if (options && (options as any).all) return callback(null, [{ address: hostname, family: literal }] as any);
      return callback(null, hostname, literal);
    }

    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        callback(err ?? new Error(`SSRF: cannot resolve '${hostname}'`), null);
        return;
      }
      const allowed = addresses.find((a) => this.ipAllowed(a.address));
      if (!allowed) {
        callback(new Error(`SSRF: all addresses for '${hostname}' are blocked`), null);
        return;
      }
      if (options && (options as any).all) {
        return callback(null, [{ address: allowed.address, family: allowed.family }] as any);
      }
      callback(null, allowed.address, allowed.family);
    });
  }

  /** Pre-flight check for a URL string (used for friendly validation before connecting). */
  async assertUrlAllowed(rawUrl: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new Error('Invalid URL.');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed.');
    }
    if (this.hostBlocked(u.hostname)) throw new Error(`Host '${u.hostname}' is blocked.`);
    // Resolution-time validation is enforced by the dispatcher lookup; this is an early hint.
  }
}
