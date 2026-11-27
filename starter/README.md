# Switchboard

Switchboard is a small, multi-tenant support inbox for customer messages. It
uses an Express/TypeScript API, MongoDB, Redis, a React/Vite web client, the
simulated Pigeon messaging provider, and a mock OpenID Connect identity
provider.

The code in this directory is the assessment application root. The repository
root is one directory above it.

## Contents

- [Requirements](#requirements)
- [Run locally](#run-locally)
- [Sign in and try the inbox](#sign-in-and-try-the-inbox)
- [Architecture](#architecture)
- [HTTP and WebSocket API](#http-and-websocket-api)
- [Data and reliability](#data-and-reliability)
- [Configuration](#configuration)
- [Tests and assessment checks](#tests-and-assessment-checks)
- [Troubleshooting](#troubleshooting)
- [Current scope and limitations](#current-scope-and-limitations)

## Requirements

- Node.js 22 or newer
- Docker Desktop / Docker Engine with Docker Compose
- Ports available for the local services:
  - `27017` MongoDB
  - `6379` Redis
  - `4010` Pigeon
  - `4020` mock IdP
  - `4030` Paybox mock (optional for this application)
  - `4000` backend
  - `5173` Vite development server

## Run locally

Run these commands from this directory (`starter/`).

### 1. Start dependencies

```sh
npm run up
```

This starts the Docker Compose services and runs the environment doctor. The
backend itself runs on your host, not in Docker.

### 2. Install the scaffold dependencies

```sh
npm run scaffold:install
```

### 3. Start the backend

```sh
npm run scaffold:server
```

This starts the TypeScript server in watch mode. Keep this terminal open. The
server listens on port `4000` by default and is ready when its MongoDB and
Redis connections succeed.

Check readiness from another terminal:

```sh
curl -i http://localhost:4000/healthz
```

A healthy response is HTTP `200` with `{"ok":true}`.

### 4. Start the web app

In another terminal, also from `starter/`:

```sh
npm run scaffold:web
```

Open <http://localhost:5173>. Vite proxies `/api`, `/auth`, `/healthz`, and
`/ws` to the backend at port `4000`.

To run the backend without the development watcher, use:

```sh
npm run start:server
```

This is the start command declared in `switchboard.json`. Stop development
processes with `Ctrl+C`. To stop this project's Compose services, run
`npm run down`.

## Sign in and try the inbox

Choose a test account from the mock IdP's account-selection page; no password
is required.

| User | Workspace(s) | Role(s) |
| --- | --- | --- |
| `u_asha` | `ws_acme` | admin |
| `u_ben` | `ws_acme` | agent |
| `u_chloe` | `ws_globex` | admin |
| `u_dev` | `ws_globex` | agent |
| `u_eli` | `ws_acme`, `ws_globex` | agent in both |

The web app supports workspace selection, searching contacts, filtering by
open/closed status, viewing message history, claiming an unassigned
conversation, closing/reopening it, and sending replies. Changes are saved
through the backend; WebSocket events prompt the client to reload current data.

Pigeon also sends simulated customer messages periodically. To send a test
inbound message immediately:

```sh
curl -X POST http://localhost:4010/v1/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"workspace":"ws_acme","from":"+14155550101","text":"Hello from a test customer"}'
```

Use `npm run quiet` to stop Pigeon's automatic traffic and `npm run drizzle` to
turn it back on.

## Architecture

```text
Simulated customer
       |
       v
Pigeon :4010 --signed webhook--> Express API :4000 <--same-origin proxy-- React :5173
                                      |  \
                                      |   +-- Redis: sessions, coordination, Pub/Sub
                                      +------ MongoDB: durable application data
       ^                                      |
       +----------- durable outbox worker ----+

Browser --OIDC + PKCE--> Mock IdP :4020
```

### Backend

The backend is organized under `scaffold/server/src/`:

- `index.ts` wires Express routes, webhook handling, health checks, startup,
  workers, and graceful shutdown.
- `auth.ts` implements OIDC login/callback, PKCE state, identity-token
  validation, workspace membership, and Redis-backed sessions.
- `inbox-api.ts` implements the authenticated inbox endpoints.
- `conversation-service.ts` contains shared conversation claim and status
  operations.
- `webhook-auth.ts` verifies Pigeon's signature against the raw request body.
- `outbox.ts` persists outbound jobs, sends them to Pigeon, handles retries,
  and processes delivery statuses.
- `events.ts` persists ordered workspace events and publishes notifications
  through Redis.
- `realtime.ts` authenticates WebSocket connections, authorizes workspace
  access, and replays persisted events.
- `db.ts` connects to MongoDB, creates indexes, seeds configured workspaces,
  and recovers eligible outbox jobs after startup.

### Frontend

The React app is under `scaffold/web/src/`. `App.tsx` coordinates session,
workspace, API, and WebSocket state. UI sections are separated into
`components/AuthScreen.tsx`, `components/InboxSidebar.tsx`, and
`components/ConversationPanel.tsx`. Shared API helpers and model types are in
`lib/api.ts` and `types.ts`.

The frontend uses relative URLs and same-origin cookies. It keeps the latest
workspace event sequence and reconnects with that sequence so the backend can
replay missed events. Event frames are notifications, not the permanent source
of truth; the client refreshes inbox data over HTTP.

## HTTP and WebSocket API

### Health and webhooks

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Readiness check; verifies MongoDB and Redis after startup. |
| `POST /webhooks/pigeon` | Receives signed inbound-message and delivery-status events. |

Pigeon signatures are HMAC-SHA256 values over the timestamp and **raw** request
body. Invalid signatures and stale timestamps are rejected. Valid events are
deduplicated and durably recorded before successful acknowledgement.

### Authentication

| Method and path | Purpose |
| --- | --- |
| `GET /auth/login` | Starts OIDC authorization-code login with PKCE. |
| `GET /auth/callback` | Validates the callback, exchanges the code, and sets the session cookie. |
| `GET /api/me` | Returns the signed-in subject and workspace memberships. |

The browser receives an HttpOnly session cookie, not OIDC tokens. Session
records and temporary PKCE state are held in Redis. Workspace access is
authorized from the validated session on every protected API request.

### Inbox

Every inbox route requires a session and a `workspace` query parameter. A
signed-in user must be a member of that workspace.

| Method and path | Purpose |
| --- | --- |
| `GET /api/conversations?workspace=<id>` | List the workspace's conversations. |
| `GET /api/conversations/:contact?workspace=<id>` | Fetch a conversation and its message history. |
| `POST /api/conversations/:contact/replies?workspace=<id>` | Persist an idempotent reply and outbox job; responds `202` when queued. |
| `POST /api/conversations/:contact/claim?workspace=<id>` | Atomically claim the conversation for the signed-in user. |
| `PATCH /api/conversations/:contact?workspace=<id>` | Set the conversation status to `open` or `closed`. |

The list is currently capped at 100 conversations and a conversation response
at 500 messages. The API returns `401` without a session and `403` when the
session does not include the requested workspace.

### WebSockets

Connect to:

```text
ws://localhost:4000/ws?workspace=ws_acme&after=0
```

The browser authenticates with its session cookie. The requested workspace
must be in the session. `after` is the last event sequence received; persisted
events with higher sequence numbers are replayed before live notifications.
Each workspace has an increasing sequence. Redis Pub/Sub carries cross-instance
wakeups, while MongoDB stores replayable event records.

### Grader-only endpoints

These endpoints require the `x-grader-token` header matching `GRADER_TOKEN`.
They are for the assessment harness, not normal browser use.

| Method and path | Purpose |
| --- | --- |
| `POST /__grader/reset` | Deletes application data and reseeds configured workspaces. |
| `GET /__grader/snapshot` | Returns the harness snapshot of conversations and message statuses. |
| `POST /__grader/reply` | Persists a reply using `{ "workspace", "contact", "text", "client_ref" }`. |
| `POST /__grader/claim` | Claims a conversation using `{ "workspace", "contact", "agent" }`. |

**Warning:** `/__grader/reset` deletes application data. Do not call it against
data you need to keep.

## Data and reliability

MongoDB is the durable source of truth. Workspace identifiers scope every
application query. The database uses these collections:

| Collection | Stored data |
| --- | --- |
| `workspaces` | Workspace records and coordination state such as event sequence and send scheduling. |
| `conversations` | One workspace/contact conversation, status, assignee, and activity time. |
| `messages` | Inbound customer messages and outbound replies/statuses. |
| `events` | Deduplication records for provider webhook events. |
| `outbox` | Durable outbound jobs, retry timing, leases, and delivery state. |
| `events_websocket` | Sequenced, replayable workspace event records. |

Unique indexes protect workspace/contact conversations, provider message IDs,
client references, provider event IDs, outbox idempotency keys, and workspace
event sequences/keys.

Outbound replies are written to the MongoDB outbox before the API responds
`202`. Workers atomically lease pending jobs, send Pigeon requests with the
client reference as the `Idempotency-Key`, respect `Retry-After`, and retry
transient failures with backoff. Expired leases allow abandoned work to be
recovered after a worker or server stops. MongoDB transactions are used when
available; the standalone assessment database uses a durable outbox fallback.

Inbound webhook processing verifies the raw bytes, validates timestamps,
deduplicates events/messages, and persists the message before acknowledging
Pigeon. Outbound status events are persisted and broadcast using the same
sequenced event mechanism.

Redis provides shared session storage and Pub/Sub notifications across server
instances. It is not the source of truth for messages, jobs, or replayable
events.

## Configuration

Defaults are documented in `.env.example` and match the backend configuration;
a local `.env` file is optional. If present, `starter/.env` is loaded. Override
values there for local development, but do not commit it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Backend HTTP/WebSocket listener. |
| `WEB_ORIGIN` | `http://localhost:5173` | Frontend origin. |
| `MONGO_URL` | `mongodb://localhost:27017/switchboard` | MongoDB connection. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection. |
| `GRADER_TOKEN` | assessment default | Grader endpoint authentication. |
| `PIGEON_URL` | `http://localhost:4010` | Pigeon API URL. |
| `PIGEON_WEBHOOK_SECRET` | development default | Pigeon webhook verification secret. |
| `PIGEON_KEY_WS_ACME` / `PIGEON_KEY_WS_GLOBEX` | assessment defaults | Per-workspace Pigeon API keys. |
| `OIDC_ISSUER` | `http://localhost:4020` | Mock IdP issuer. |
| `OIDC_CLIENT_ID` | `switchboard-web` | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | development default | OIDC client secret. |
| `OIDC_REDIRECT_URI` | `http://localhost:4000/auth/callback` | Registered OIDC callback. |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Optional search service; search is not implemented. |
| `PAYBOX_*` | assessment defaults | Bonus-track mock provider settings; billing is not implemented. |

See `.env.example` for the complete variable list and the provider-specific
settings.

## Tests and assessment checks

Run the focused checks from `starter/`:

```sh
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/server test
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
```

The assessment harness can be run with:

```sh
npm run check                 # level 1
npm run check -- --levels 5   # login, tenant isolation, and WebSockets
npm run check:full            # levels 1, 2, 3, and 5
```

**The harness resets application data and changes Pigeon's traffic mode.** Stop
your own backend first, and do not run it if you need to preserve local
application data. Use `npm run drizzle` afterward to restore Pigeon's regular
simulated traffic.

The checked-in [CHECK_REPORT.json](./CHECK_REPORT.json) records 75/75 for the
runnable levels 1, 2, 3, and 5. Level 4 is not included in the public runnable
harness. The standalone assessment MongoDB does not exercise the transaction
branch.

## Troubleshooting

### `npm run up` says port 27017 is already allocated

Another MongoDB process or container is already listening on the default port.
Check available assessment services first:

```sh
npm run doctor
docker ps --filter publish=27017
lsof -nP -iTCP:27017 -sTCP:LISTEN
```

If `npm run doctor` reports MongoDB and the other required services as ready,
continue with `npm run scaffold:install` and `npm run scaffold:server`; a
second MongoDB container is not needed. Do not stop or remove an unfamiliar
database container just to free the port.

If the doctor reports a missing service, identify which process owns its port
before stopping it. For a service managed by this Compose project, start the
required services with `npm run up`.

### Backend exits during startup

Confirm MongoDB and Redis are available with `npm run doctor`. Check that
`MONGO_URL` and `REDIS_URL` point to the running services. The backend does
not become healthy until its database connections and startup initialization
complete.

### Login fails or redirects to the wrong host

Use the development URLs consistently (`localhost`, not a mix of `localhost`
and `127.0.0.1`). Check `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and
`OIDC_REDIRECT_URI`; the callback must match one of the mock IdP's registered
redirect URIs. Restart the backend after changing `.env`.

### The IdP page still has its old appearance

The mock IdP does not watch its source file. Restart the process or container
serving port `4020` after editing `idp/server.js`.

## Current scope and limitations

- The conversation list is capped at 100 and each history response at 500
  messages. Pagination is not implemented.
- Contact search and status filtering happen in the browser.
- No encrypted private notes, Elasticsearch search, billing, or production
  deployment configuration is implemented.
- The frontend has no dedicated unit-test runner; it is typechecked,
  production-built, and was manually exercised.
- The public harness does not run level 4, and the standalone MongoDB setup
  does not test the transaction path.

See [DECISIONS.md](./DECISIONS.md) for implementation choices and additional
known limitations. Provider behavior is documented in [PIGEON.md](./PIGEON.md).
