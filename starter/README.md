# Switchboard

Switchboard is a multi-tenant support inbox built with Express, TypeScript,
MongoDB, Redis, and React. Pigeon supplies customer messaging and the mock
OpenID Connect provider supplies agent identity and workspace memberships.

## Run locally

Requirements: Node.js 22 or newer, Docker Compose, and the services declared
in `docker-compose.yml`.

```sh
cd starter
npm run up
npm run scaffold:install
npm run scaffold:server
```

In another terminal, start the React app:

```sh
cd starter
npm run scaffold:web
```

Open <http://localhost:5173>. The app uses same-origin relative API paths;
Vite proxies `/api`, `/auth`, `/healthz`, and `/ws` to the backend. The login
screen redirects to the mock IdP. Its test users include `u_asha` and `u_ben`
in `ws_acme`, `u_chloe` and `u_dev` in `ws_globex`, and `u_eli` in both.

The harness defaults are in `.env.example` and are loaded without a local
`.env` file. Copy that file to `.env` only when you need to override a setting.
Do not commit `.env`.

## What is implemented

- Signed Pigeon webhooks with raw-body verification, deduplication, and
  durable inbound message storage.
- MongoDB-backed outbound outbox with Pigeon idempotency keys, leased worker
  claims, retry handling, and delivery status tracking.
- OIDC authorization-code login with PKCE, verified identity claims, opaque
  Redis sessions, and HttpOnly cookies.
- Workspace-scoped inbox listing, message history, replies, claims, and
  close/reopen actions.
- Persisted, sequenced workspace events with Redis Pub/Sub notifications,
  authenticated WebSockets, and replay using the client's last sequence.
- A compact React inbox with login, workspace selection, search/status
  filters, conversation actions, message status, reconnect, and loading/error
  states.

MongoDB is the source of truth. WebSocket notifications cause the client to
reload the affected inbox data; frames are not treated as durable records.

## Checks

```sh
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/server test
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
npm run check:full
```

The assessment harness resets application data and turns off Pigeon drizzle.
Turn customer traffic back on afterward with `npm run drizzle`.

## Current scope

The inbox list is limited to 100 conversations and each conversation response
includes at most 500 messages. Search is local contact matching; Elasticsearch,
private notes, billing, and a production deployment configuration are not
implemented.
