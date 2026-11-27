# Decisions

I kept the supplied Express/TypeScript and React scaffold. MongoDB remains
the durable source of truth for workspaces, conversations, messages, the
outbox, and sequenced real-time events. Redis stores opaque login sessions
and carries Pub/Sub wakeups between instances; clients replay events from
MongoDB after their last workspace sequence and reload REST data after each
change. This avoids making a WebSocket frame the permanent record.

Login uses authorization-code PKCE. The verifier, nonce, and one-time state
are stored in Redis with a short expiry; the server verifies the ID-token
signature and issuer, audience, expiry, nonce, subject, and workspace roles.
Only identity claims are kept in the session. The browser receives an
HttpOnly, SameSite=Lax cookie, marked Secure when the configured callback is
HTTPS.

Outbound replies are persisted before returning `202`. MongoDB transactions
are used when supported; the standalone assessment database uses a durable
outbox document containing the message payload until the message mirror can
be materialized. Workers lease jobs and rely on Pigeon's idempotency key for
safe recovery. Workspace event sequence allocation uses transactions on
replica sets and a MongoDB lease on standalone deployments.

I prioritized webhook correctness, durable replies, tenant isolation,
authentication, and replayable real-time updates. I did not implement
encrypted private notes, Elasticsearch search, billing, or a full-featured
agent administration UI. The web inbox is intentionally small. Its current
API returns at most 100 conversations and 500 messages per conversation;
cursor pagination and server-side contact search are still needed for larger
workspaces. The frontend has no dedicated unit-test runner; it was typechecked,
production-built, and manually exercised for login, claim, close/reopen, and a
reply.

The final `npm run check:full` run passed **75/75** across levels 1, 2, 3,
and 5. Level 4 is not part of the runnable public harness. The assessment
MongoDB is standalone, so the transaction branch is not exercised; the
standalone outbox and event-sequencing fallbacks are exercised instead.

The `ai-logs/` transcript records the conversation messages available in this
session; it is not a native platform export and does not include tool-call
records. Replace it with the platform export if one is available and required.
