'use strict';

// Mock identity provider: OpenID Connect, authorization code flow with PKCE.
// Zero dependencies. It behaves like a real IdP (Google, Auth0, Okta) for the
// parts you need: discovery, /authorize, /token, /userinfo, /jwks.
//
// Instead of a password form, /authorize shows a list of test users.

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4020);
const ISSUER = process.env.IDP_ISSUER || 'http://localhost:' + PORT;
const CLIENT_ID = process.env.IDP_CLIENT_ID || 'switchboard-web';
const CLIENT_SECRET = process.env.IDP_CLIENT_SECRET || 'dev-secret-not-for-production';
const REDIRECTS = (process.env.IDP_REDIRECT_URIS || 'http://localhost:3000/auth/callback,http://localhost:4000/auth/callback,http://localhost:5173/auth/callback').split(',');

const USERS = [
  { sub: 'u_asha', name: 'Asha Rao', email: 'asha@acme.test', workspaces: [{ id: 'ws_acme', role: 'admin' }] },
  { sub: 'u_ben', name: 'Ben Ortiz', email: 'ben@acme.test', workspaces: [{ id: 'ws_acme', role: 'agent' }] },
  { sub: 'u_chloe', name: 'Chloe Martin', email: 'chloe@globex.test', workspaces: [{ id: 'ws_globex', role: 'admin' }] },
  { sub: 'u_dev', name: 'Dev Patel', email: 'dev@globex.test', workspaces: [{ id: 'ws_globex', role: 'agent' }] },
  { sub: 'u_eli', name: 'Eli Novak (contractor)', email: 'eli@contractor.test', workspaces: [{ id: 'ws_acme', role: 'agent' }, { id: 'ws_globex', role: 'agent' }] },
];

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = crypto.randomBytes(6).toString('hex');
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: KID, use: 'sig', alg: 'RS256' });
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[character]);

function signJwt(claims) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url');
  return head + '.' + body + '.' + sig;
}

const codes = new Map(); // code -> { user, redirectUri, challenge, nonce, exp }
const tokens = new Map(); // access token -> user

function readForm(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if ((req.headers['content-type'] || '').includes('json')) {
        try {
          return resolve(JSON.parse(raw));
        } catch (e) {
          return resolve({});
        }
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, ISSUER);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return json(204, {});

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: ISSUER + '/authorize',
        token_endpoint: ISSUER + '/token',
        userinfo_endpoint: ISSUER + '/userinfo',
        jwks_uri: ISSUER + '/jwks',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });

    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      if (q.client_id !== CLIENT_ID) return json(400, { error: 'unauthorized_client' });
      if (!REDIRECTS.includes(q.redirect_uri)) return json(400, { error: 'invalid_request', error_description: 'redirect_uri not registered: ' + q.redirect_uri });
      if (q.response_type !== 'code') return json(400, { error: 'unsupported_response_type' });
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return json(400, { error: 'invalid_request', error_description: 'PKCE with S256 is required' });
      if (q.login) {
        const user = USERS.find((u) => u.sub === q.login);
        if (!user) return json(400, { error: 'access_denied' });
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { user, redirectUri: q.redirect_uri, challenge: q.code_challenge, nonce: q.nonce, exp: Date.now() + 60000 });
        const back = new URL(q.redirect_uri);
        back.searchParams.set('code', code);
        if (q.state) back.searchParams.set('state', q.state);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      const accounts = USERS.map((u) => {
        const next = new URL(url);
        next.searchParams.set('login', u.sub);
        const initials = u.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
        const workspaces = u.workspaces.map((w) =>
          '<span class="workspace-tag">' +
            '<span class="workspace-name">' + escapeHtml(w.id) + '</span>' +
            '<span class="workspace-role">' + escapeHtml(w.role) + '</span>' +
          '</span>',
        ).join('');
        return (
          '<li>' +
            '<a class="account-card" href="' + escapeHtml(next.pathname + next.search) + '" aria-label="Continue as ' + escapeHtml(u.name) + '">' +
              '<span class="avatar" aria-hidden="true">' + escapeHtml(initials) + '</span>' +
              '<span class="account-details">' +
                '<span class="account-heading">' +
                  '<strong>' + escapeHtml(u.name) + '</strong>' +
                  '<span class="account-arrow" aria-hidden="true">→</span>' +
                '</span>' +
                '<span class="account-email">' + escapeHtml(u.email) + '</span>' +
                '<span class="workspace-list">' + workspaces + '</span>' +
              '</span>' +
            '</a>' +
          '</li>'
        );
      }).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Choose an account · Switchboard</title>
    <style>
      :root {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #233531;
        background: #f3f7f5;
        font-synthesis: none;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }

      * { box-sizing: border-box; }

      body {
        min-width: 320px;
        min-height: 100vh;
        margin: 0;
        background:
          radial-gradient(ellipse at 50% 12%, rgba(196, 230, 216, 0.62), transparent 42%),
          #f3f7f5;
      }

      .page-shell {
        display: flex;
        width: min(100% - 40px, 940px);
        min-height: 100vh;
        flex-direction: column;
        margin: 0 auto;
      }

      .site-header {
        display: flex;
        min-height: 88px;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 11px;
        color: inherit;
        text-decoration: none;
      }

      .brand-mark {
        display: grid;
        width: 40px;
        height: 40px;
        place-items: center;
        border-radius: 12px;
        background: #147d66;
        color: #fff;
        font-size: 15px;
        font-weight: 800;
        letter-spacing: -0.5px;
      }

      .brand-copy { display: grid; gap: 2px; }
      .brand-copy strong { font-size: 14px; letter-spacing: -0.2px; }
      .brand-copy span { color: #7d8c87; font-size: 11px; }

      .environment {
        padding: 7px 10px;
        border: 1px solid #dfe9e4;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.58);
        color: #687a73;
        font-size: 11px;
        font-weight: 650;
      }

      main {
        display: grid;
        flex: 1;
        place-items: center;
        padding: 24px 0 42px;
      }

      .auth-card {
        width: min(100%, 590px);
        padding: 38px;
        border: 1px solid #e4ece8;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 22px 65px rgba(35, 67, 55, 0.09);
      }

      .eyebrow {
        margin: 0 0 9px;
        color: #31816b;
        font-size: 10px;
        font-weight: 760;
        letter-spacing: 1.25px;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        color: #233531;
        font-size: clamp(24px, 4vw, 30px);
        letter-spacing: -1px;
        line-height: 1.15;
      }

      .intro {
        max-width: 440px;
        margin: 11px 0 26px;
        color: #71817b;
        font-size: 13px;
        line-height: 1.6;
      }

      .account-list {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .account-card {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        align-items: center;
        gap: 13px;
        padding: 14px;
        border: 1px solid #e6ece9;
        border-radius: 12px;
        background: #fff;
        color: inherit;
        text-decoration: none;
        transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
      }

      .account-card:hover {
        transform: translateY(-1px);
        border-color: #b7d8ca;
        background: #fbfdfc;
      }

      .account-card:focus-visible {
        outline: 3px solid rgba(32, 132, 105, 0.28);
        outline-offset: 2px;
      }

      .avatar {
        display: grid;
        width: 42px;
        height: 42px;
        place-items: center;
        border-radius: 50%;
        background: #e7f3ee;
        color: #28725e;
        font-size: 12px;
        font-weight: 750;
      }

      .account-details { display: grid; min-width: 0; gap: 5px; }
      .account-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .account-heading strong { overflow: hidden; font-size: 13px; font-weight: 720; text-overflow: ellipsis; }
      .account-arrow { color: #7e9c90; font-size: 17px; line-height: 1; }
      .account-email { color: #81908a; font-size: 11px; }
      .workspace-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }

      .workspace-tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 7px;
        border-radius: 5px;
        background: #f1f6f3;
        color: #5e7268;
        font-size: 9px;
      }

      .workspace-name { font-weight: 680; }
      .workspace-role { color: #84938d; }

      .card-note {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 19px 0 0;
        padding-top: 16px;
        border-top: 1px solid #edf1ef;
        color: #87958f;
        font-size: 10px;
        line-height: 1.5;
      }

      .note-icon {
        display: grid;
        width: 17px;
        height: 17px;
        flex: 0 0 auto;
        place-items: center;
        border-radius: 50%;
        background: #eef5f1;
        color: #648274;
        font-size: 11px;
        font-weight: 750;
      }

      footer {
        display: flex;
        min-height: 56px;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: #93a099;
        font-size: 10px;
      }

      @media (max-width: 560px) {
        .page-shell { width: min(100% - 28px, 460px); }
        .site-header { min-height: 72px; }
        .environment { padding: 6px 8px; font-size: 9px; }
        .auth-card { padding: 25px 18px; border-radius: 15px; }
        .intro { font-size: 12px; }
        .account-card { grid-template-columns: 37px minmax(0, 1fr); gap: 10px; padding: 12px; }
        .avatar { width: 37px; height: 37px; }
        footer { align-items: flex-start; flex-direction: column; justify-content: center; padding: 12px 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
      }
    </style>
  </head>
  <body>
    <div class="page-shell">
      <header class="site-header">
        <div class="brand" aria-label="Switchboard identity provider">
          <span class="brand-mark" aria-hidden="true">S</span>
          <span class="brand-copy">
            <strong>switchboard</strong>
            <span>Identity provider</span>
          </span>
        </div>
        <span class="environment">Local development</span>
      </header>
      <main>
        <section class="auth-card" aria-labelledby="page-title">
          <p class="eyebrow">Account selection</p>
          <h1 id="page-title">Choose a test user</h1>
          <p class="intro">Select an identity to continue to Switchboard. Workspace access for each account is shown below.</p>
          <ul class="account-list" aria-label="Available test accounts">${accounts}</ul>
          <p class="card-note">
            <span class="note-icon" aria-hidden="true">i</span>
            <span>This mock identity provider is for local development. No password is required.</span>
          </p>
        </section>
      </main>
      <footer>
        <span>Switchboard assessment environment</span>
        <span>Mock OpenID Connect provider</span>
      </footer>
    </div>
  </body>
</html>`);
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const f = await readForm(req);
      let id = f.client_id;
      let secret = f.client_secret;
      const basic = (req.headers.authorization || '').match(/^Basic (.+)$/);
      if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':');
      if (id !== CLIENT_ID) return json(401, { error: 'invalid_client' });
      // Public clients (SPA) may omit the secret; if one is sent it must be right.
      if (secret !== undefined && secret !== '' && secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      const entry = codes.get(f.code);
      codes.delete(f.code); // single use
      if (f.grant_type !== 'authorization_code' || !entry || entry.exp < Date.now()) return json(400, { error: 'invalid_grant' });
      if (entry.redirectUri !== f.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      const challenge = crypto.createHash('sha256').update(String(f.code_verifier || '')).digest('base64url');
      if (challenge !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const now = Math.floor(Date.now() / 1000);
      const u = entry.user;
      const access = 'at_' + crypto.randomBytes(18).toString('hex');
      tokens.set(access, u);
      return json(200, {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: signJwt({ iss: ISSUER, aud: CLIENT_ID, sub: u.sub, iat: now, exp: now + 3600, nonce: entry.nonce, name: u.name, email: u.email, workspaces: u.workspaces }),
      });
    }

    if (url.pathname === '/userinfo') {
      const u = tokens.get(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!u) return json(401, { error: 'invalid_token' });
      return json(200, { sub: u.sub, name: u.name, email: u.email, workspaces: u.workspaces });
    }

    json(404, { error: 'not_found' });
  })
  .listen(PORT, () => console.log('mock idp on ' + ISSUER + '  client_id=' + CLIENT_ID));
