/**
 * Minimal HS256 JWT signing and verification on node:crypto (no dependencies).
 *
 * The verifier is deliberately strict:
 *  - it accepts only alg=HS256, which shuts out "alg":"none" and RS/HS confusion attacks
 *  - it compares signatures in constant time
 *  - `exp` is required, and `nbf` / `aud` / `iss` are enforced
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims {
  sub: string;
  role: string;
  aud?: string;
  iss?: string;
  exp: number;
  nbf?: number;
  iat?: number;
  [k: string]: unknown;
}

export class JwtError extends Error {}

const b64url = (buf: Buffer) => buf.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}

export interface VerifyOptions {
  audience?: string;
  issuer?: string;
  nowSeconds?: number;
  clockToleranceSeconds?: number;
}

export function verifyJwt(token: string, secret: string, opts: VerifyOptions = {}): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let claims: JwtClaims;
  try {
    header = JSON.parse(fromB64url(h).toString("utf8"));
    claims = JSON.parse(fromB64url(p).toString("utf8"));
  } catch {
    throw new JwtError("malformed token");
  }
  if (header.alg !== "HS256") throw new JwtError("unsupported alg");

  const expected = hmac(secret, `${h}.${p}`);
  const actual = fromB64url(s);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError("invalid signature");
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const leeway = opts.clockToleranceSeconds ?? 30;
  if (typeof claims.exp !== "number") throw new JwtError("missing exp");
  if (now - leeway >= claims.exp) throw new JwtError("token expired");
  if (typeof claims.nbf === "number" && now + leeway < claims.nbf) throw new JwtError("token not yet valid");
  if (opts.audience !== undefined && claims.aud !== opts.audience) throw new JwtError("invalid audience");
  if (opts.issuer !== undefined && claims.iss !== opts.issuer) throw new JwtError("invalid issuer");
  if (typeof claims.sub !== "string" || typeof claims.role !== "string") throw new JwtError("missing sub/role");
  return claims;
}
