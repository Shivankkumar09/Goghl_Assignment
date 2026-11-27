import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { Router } from 'express';
import { config } from './config.js';
import { asyncRoute } from './http-utils.js';
import { getRedis } from './redis.js';

const stateTtlSeconds = 600;
const sessionTtlSeconds = 8 * 60 * 60;
const sessionCookie = 'switchboard_session';
const sessionPrefix = 'switchboard:session:';
const statePrefix = 'switchboard:oidc:state:';

type JsonRecord = Record<string, unknown>;

export type WorkspaceMembership = { id: string; role: 'admin' | 'agent' };
export type AuthenticatedSession = {
  sub: string;
  workspaces: WorkspaceMembership[];
};

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};
type RsaJwk = { kty: 'RSA'; kid: string; n: string; e: string; use?: string; alg?: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function parseMemberships(value: unknown): WorkspaceMembership[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const memberships: WorkspaceMembership[] = [];
  const ids = new Set<string>();
  for (const membership of value) {
    if (
      !isRecord(membership) ||
      !isNonEmptyString(membership.id, 100) ||
      (membership.role !== 'admin' && membership.role !== 'agent') ||
      ids.has(membership.id)
    ) {
      return null;
    }
    ids.add(membership.id);
    memberships.push({ id: membership.id, role: membership.role });
  }
  return memberships;
}

function parseSession(value: unknown): AuthenticatedSession | null {
  if (!isRecord(value) || !isNonEmptyString(value.sub, 200)) return null;
  const workspaces = parseMemberships(value.workspaces);
  return workspaces ? { sub: value.sub, workspaces } : null;
}

function isRsaJwk(value: unknown): value is RsaJwk {
  return isRecord(value) &&
    value.kty === 'RSA' &&
    isNonEmptyString(value.kid, 200) &&
    isNonEmptyString(value.n, 4096) &&
    isNonEmptyString(value.e, 4096) &&
    (!value.use || value.use === 'sig') &&
    (!value.alg || value.alg === 'RS256');
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(cookie.slice(prefix.length));
    } catch {
      return null;
    }
  }
  return null;
}

export async function sessionFromCookie(
  cookieHeader: string | undefined,
): Promise<AuthenticatedSession | null> {
  const token = cookieValue(cookieHeader, sessionCookie);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const redis = getRedis();
  const serialized = await redis.get(`${sessionPrefix}${token}`);
  if (!serialized) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    await redis.del(`${sessionPrefix}${token}`);
    return null;
  }
  const session = parseSession(value);
  if (!session) await redis.del(`${sessionPrefix}${token}`);
  return session;
}

function redirectIsSecure(): boolean {
  return new URL(config.oidc.redirectUri).protocol === 'https:';
}

function issuerMatches(actual: string): boolean {
  return actual.replace(/\/+$/, '') === config.oidc.issuer.replace(/\/+$/, '');
}

function endpoint(value: unknown): URL {
  if (!isNonEmptyString(value, 2048)) throw new Error('OIDC endpoint is missing');
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OIDC endpoint must use HTTP or HTTPS');
  }
  return url;
}

async function loadDiscovery(): Promise<OidcDiscovery> {
  const issuer = config.oidc.issuer.replace(/\/+$/, '');
  const response = await fetch(new URL('/.well-known/openid-configuration', `${issuer}/`), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !isNonEmptyString(body.issuer, 2048) ||
    !issuerMatches(body.issuer) ||
    !isNonEmptyString(body.authorization_endpoint, 2048) ||
    !isNonEmptyString(body.token_endpoint, 2048) ||
    !isNonEmptyString(body.jwks_uri, 2048)
  ) {
    throw new Error('OIDC discovery response is invalid');
  }
  return {
    issuer: body.issuer,
    authorization_endpoint: endpoint(body.authorization_endpoint).toString(),
    token_endpoint: endpoint(body.token_endpoint).toString(),
    jwks_uri: endpoint(body.jwks_uri).toString(),
  };
}

function parseJwt(idToken: string): { header: JsonRecord; claims: JsonRecord; signingInput: string; signature: Buffer } | null {
  const segments = idToken.split('.');
  if (segments.length !== 3) return null;
  try {
    const header: unknown = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (!isRecord(header) || !isRecord(claims)) return null;
    return {
      header,
      claims,
      signingInput: `${segments[0]}.${segments[1]}`,
      signature: Buffer.from(segments[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

async function verifyIdentityToken(
  idToken: string,
  discovery: OidcDiscovery,
  nonce: string,
): Promise<AuthenticatedSession | null> {
  const parsed = parseJwt(idToken);
  const nowSeconds = Date.now() / 1000;
  if (
    !parsed ||
    parsed.header.alg !== 'RS256' ||
    !isNonEmptyString(parsed.header.kid, 200) ||
    !isNonEmptyString(parsed.claims.sub, 200) ||
    !isNonEmptyString(parsed.claims.iss, 2048) ||
    !issuerMatches(parsed.claims.iss) ||
    parsed.claims.nonce !== nonce ||
    typeof parsed.claims.exp !== 'number' ||
    !Number.isFinite(parsed.claims.exp) ||
    parsed.claims.exp <= nowSeconds ||
    typeof parsed.claims.iat !== 'number' ||
    !Number.isFinite(parsed.claims.iat) ||
    parsed.claims.iat > nowSeconds + 60 ||
    (parsed.claims.nbf !== undefined &&
      (typeof parsed.claims.nbf !== 'number' ||
        !Number.isFinite(parsed.claims.nbf) ||
        parsed.claims.nbf > nowSeconds + 60))
  ) {
    return null;
  }

  const audiences = typeof parsed.claims.aud === 'string'
    ? [parsed.claims.aud]
    : Array.isArray(parsed.claims.aud) && parsed.claims.aud.every((item) => typeof item === 'string')
      ? parsed.claims.aud
      : [];
  if (!audiences.includes(config.oidc.clientId)) return null;
  if (audiences.length > 1 && parsed.claims.azp !== config.oidc.clientId) return null;

  const jwksResponse = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(5_000) });
  if (!jwksResponse.ok) throw new Error(`OIDC JWKS returned HTTP ${jwksResponse.status}`);
  const jwksBody: unknown = await jwksResponse.json();
  if (!isRecord(jwksBody) || !Array.isArray(jwksBody.keys)) {
    throw new Error('OIDC JWKS response is invalid');
  }
  const jwk = jwksBody.keys.find(
    (key): key is RsaJwk => isRsaJwk(key) && key.kid === parsed.header.kid,
  );
  if (!jwk) return null;

  const publicKey = createPublicKey({
    format: 'jwk',
    key: { kty: 'RSA', n: jwk.n, e: jwk.e },
  });
  if (!verify('RSA-SHA256', Buffer.from(parsed.signingInput), publicKey, parsed.signature)) {
    return null;
  }
  const workspaces = parseMemberships(parsed.claims.workspaces);
  return workspaces ? { sub: parsed.claims.sub, workspaces } : null;
}

function loginRouter(): ReturnType<typeof Router> {
  const router = Router();

  router.get('/auth/login', asyncRoute(async (_req, res) => {
    const discovery = await loadDiscovery();
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('hex');
    const redis = getRedis();
    const stored = await redis.set(
      `${statePrefix}${state}`,
      JSON.stringify({ verifier, nonce }),
      'EX',
      stateTtlSeconds,
      'NX',
    );
    if (stored !== 'OK') throw new Error('Could not persist OIDC state');

    const authorization = new URL(discovery.authorization_endpoint);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', config.oidc.clientId);
    authorization.searchParams.set('redirect_uri', config.oidc.redirectUri);
    authorization.searchParams.set('scope', 'openid profile email');
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('nonce', nonce);
    authorization.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    authorization.searchParams.set('code_challenge_method', 'S256');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, authorization.toString());
  }));

  router.get('/auth/callback', asyncRoute(async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!/^[a-f0-9]{64}$/.test(state) || !isNonEmptyString(code, 1000)) {
      res.status(400).json({ error: 'invalid_callback' });
      return;
    }
    const redis = getRedis();
    const stored = await redis.getdel(`${statePrefix}${state}`);
    if (!stored) {
      res.status(400).json({ error: 'invalid_state' });
      return;
    }
    let stateData: unknown;
    try {
      stateData = JSON.parse(stored);
    } catch {
      res.status(400).json({ error: 'invalid_state' });
      return;
    }
    if (!isRecord(stateData) || !isNonEmptyString(stateData.verifier, 200) || !isNonEmptyString(stateData.nonce, 200)) {
      res.status(400).json({ error: 'invalid_state' });
      return;
    }
    const discovery = await loadDiscovery();
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: stateData.verifier,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!tokenResponse.ok) {
      res.status(401).json({ error: 'invalid_authorization_code' });
      return;
    }
    const tokenBody: unknown = await tokenResponse.json();
    if (!isRecord(tokenBody) || !isNonEmptyString(tokenBody.id_token, 10_000)) {
      res.status(401).json({ error: 'invalid_identity_token' });
      return;
    }
    const session = await verifyIdentityToken(tokenBody.id_token, discovery, stateData.nonce);
    if (!session) {
      res.status(401).json({ error: 'invalid_identity_token' });
      return;
    }

    const token = randomBytes(32).toString('hex');
    await redis.set(`${sessionPrefix}${token}`, JSON.stringify(session), 'EX', sessionTtlSeconds);
    const cookieParts = [
      `${sessionCookie}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${sessionTtlSeconds}`,
    ];
    if (redirectIsSecure()) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, config.webOrigin);
  }));

  router.get('/api/me', asyncRoute(async (req, res) => {
    const session = await sessionFromCookie(req.headers.cookie);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(session);
  }));

  return router;
}

export const authRouter = loginRouter();

export function sessionWorkspaceRole(
  session: AuthenticatedSession,
  workspace: string,
): WorkspaceMembership['role'] | null {
  return session.workspaces.find((membership) => membership.id === workspace)?.role ?? null;
}
