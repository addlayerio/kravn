import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { newJti } from '../crypto.js';

export interface KravnClaims extends JWTPayload {
  sub: string;
  email: string;
  role: string;
  jti: string;
  /** 'mcp' marks a token issued via the OAuth flow — usable ONLY on MCP endpoints, never the control-plane API. */
  scope?: string;
}

export class JwtService {
  private key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(
    input: { userId: string; email: string; role: string; scope?: string },
    ttlMinutes: number,
    jti: string = newJti(),
  ): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: input.email, role: input.role, ...(input.scope ? { scope: input.scope } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userId)
      .setJti(jti)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + ttlMinutes * 60)
      .setIssuer('kravn')
      .sign(this.key);
  }

  /** Issue a console-session token AND return its jti, so a trackable/revocable session row can be created. */
  async signSession(
    input: { userId: string; email: string; role: string },
    ttlMinutes: number,
  ): Promise<{ token: string; jti: string }> {
    const jti = newJti();
    return { token: await this.sign(input, ttlMinutes, jti), jti };
  }

  /** Verify a token. Throws on any invalid/expired token (fail-closed). */
  async verify(token: string): Promise<KravnClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'kravn' });
    if (!payload.sub || !payload.jti) throw new Error('token missing sub/jti');
    return payload as KravnClaims;
  }
}
