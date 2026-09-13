# Uhuru Control Plane

Ticket 02: Node.js 24 / Fastify / PostgreSQL, direct HTTPS administration and
subscription delivery, and the accepted Rust Node Agent sync protocol. The source
ticket is `../../uhuru-vpn-plan-v2/.scratch/uhuru-vpn-mvp/ticket-drafts/02-first-profile-happ.md`;
its accepted contracts are in that planning repository's `MVP-SPEC.md`. Planning
files and the existing agent are unchanged.

The first issuance locks the User and Nodes, takes PostgreSQL time after those
locks, and commits the first Profile, 720-hour Subscription and desired snapshots
together. Repeating issuance for the same User returns the same first Profile and
link, including after restart. Expired subscriptions stay expired; revoked first
Profiles return a status without a link. Price `null` means **not configured**.

## Module structure

The Commercial Access module owns Users, the Plan, Subscriptions and Access Profiles:

- `src/access/controller.ts` is the HTTP adapter: input schemas, normalization, use-case calls and responses. It inherits the administrative authentication hook.
- `src/access/use-cases.ts` is the module interface: commercial decisions, first issuance and its transaction, repeat link display, and internal access checks for Node enrollment and configuration delivery. It does not depend on Fastify or HTTP errors.
- `src/access/repository.ts` is the internal PostgreSQL adapter for commercial data. SQL time comparisons preserve PostgreSQL precision; use cases decide commercial statuses, the profile limit and the issued term.

The Node module owns Node registration, Bearer rotation, synchronization and observed readiness:

- `src/nodes/controller.ts` contains the administrative and agent HTTP adapters, input schemas and canonical token decoding. Administrative routes inherit Basic Auth; the agent uses its own Bearer.
- `src/nodes/use-cases.ts` handles registration and synchronization transactions, Node authentication, ACK decisions and public diagnostics. Domain errors are mapped to HTTP only in `src/app.ts`.
- `src/nodes/repository.ts` is the PostgreSQL adapter for all reads and writes of `nodes` and `node_sync`.
- `src/nodes/readiness.ts` checks the confirmed snapshot and exact Profile ID/credential pair once for both administrative readiness and configuration delivery. Historical readiness remains separate from desired access and inclusion in subscriptions.

The Configuration Delivery module serves Subscription Links:

- `src/delivery/controller.ts` validates the canonical secret and raw URL before database access, calls the use case and sets the successful response content type.
- `src/delivery/use-cases.ts` owns the read transaction, obtains authorized access and ready Node connections through those modules, and formats the VLESS configurations. Data access stays in the owning modules' repositories; delivery has no tables of its own.

Modules call each other's use cases or the desired-access operation, not repositories.
`src/secrets.ts` shares token decoding and hashing independently of HTTP;
`src/snapshot.ts` retains canonical snapshot validation and hashing. `src/app.ts`
assembles the three modules and configures TLS, administrative authentication,
JSON parsing, response headers and sanitized error handling.

`src/database.ts` provides the shared transaction implementation. First issuance
locks the User, then the shared enrollment/issuance row, then Nodes in ID order;
only then does it read PostgreSQL time. `src/nodes/desired-access.ts` locks the Node
state and returns its update operation on that same database client, hiding snapshot
details behind an internal seam. Its SQL is in `src/nodes/repository.ts`.
Repositories never commit independently: Profile, Subscription and desired snapshots
still commit together. Node enrollment obtains its initial desired access through
the access module under the same enrollment/issuance lock. Synchronization locks
the Node before its sync state, validates ACK provenance against the previous sent
snapshot, then records the new response in that same transaction. It never takes
a User lock after a Node lock. Repeated ACKs retain the first confirmation time.

See [the domain glossary](CONTEXT.md). The existing HTTPS/PostgreSQL checks remain
the behavioral test surface, alongside direct use-case checks for issuance and
ACK rollback at COMMIT, token rotation, historical readiness and configuration
delivery. Delivery checks also cover URI encoding and response headers.

## Run the checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
sh stand/run.sh ../node-agent
```

`npm test` creates a private temporary PostgreSQL cluster with no TCP listener,
runs real HTTPS tests using a restricted application role, then removes the cluster.
PostgreSQL `initdb`/`pg_ctl` must be on PATH (Homebrew PostgreSQL 18 is detected).
The native Node test runner accepts filters, e.g. `npm test -- --test-name-pattern='ACK'`.

The stand builds the existing Rust agent and pinned Xray v26.5.9, then adds this
Control Plane and PostgreSQL. It uses an ARM64 private privileged systemd container,
with **no host mounts or published ports**. Secrets are generated inside it, the
container is removed on exit, and only sanitized results go to
`target/stand-results.json`. A local TLS 1.3 target and Xray client exercise the
TCP + REALITY + XTLS Vision candidate using the URI returned by this server.
This does not establish public VPS routing or Happ compatibility.

See [acceptance evidence and the manual Happ handoff](docs/acceptance.md).

## Install on a dedicated Linux Control Plane

Use Node.js 24.11+ within the 24.x line, PostgreSQL 15+, and the committed npm lockfile.
Install the source at `/opt/uhuru`, root-owned and not writable by the service:

```sh
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin uhuru
install -d -o root -g uhuru -m 0750 /etc/uhuru
# From /opt/uhuru:
npm ci --omit=dev --ignore-scripts
runuser -u postgres -- createdb uhuru
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d uhuru -f schema.sql
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d uhuru -f deploy/app-role.sql
install -m 0644 deploy/uhuru-control-plane.service /etc/systemd/system/
```

These SQL files are a one-time fresh installation, never a startup reset or a
restore procedure. The database remains owned by `postgres`; the service role
cannot delete records or change Profile credentials, owners or `first_profile_id`.
Use local Unix peer authentication for `uhuru` in `pg_hba.conf`; do not add a trust
or TCP rule. Keep `PGDATA` and its `pg_wal` directory owned by PostgreSQL and mode
0700, backups excluded, and the database port closed.

Before loading secrets, install [the PostgreSQL logging settings](deploy/postgresql-secrets.conf)
in the dedicated cluster's included configuration directory and restart that cluster.
Disable any extension, audit collector or platform collector that records statements,
parameters or process memory. Suppressing parameter logs alone does not suppress
constraint error details; the configuration also suppresses ordinary server errors
and their statement text. See the [PostgreSQL logging reference](https://www.postgresql.org/docs/current/runtime-config-logging.html).

Set both soft and hard `LimitCORE=0` for the actual PostgreSQL cluster unit, as the
provided Control Plane unit already does. Require a file-mode kernel `core_pattern`
without a leading `|`; pipe collectors bypass the usual core limit. Set that host
policy before starting services. The Control Plane refuses startup if these core
prerequisites or its restricted database role are absent. Review the same policy
for the separate Node Agent/Xray services.

Create `/etc/uhuru/settings.json` from [the example](deploy/settings.example.json),
with a unique random admin password and the final HTTPS origin. Use root:`uhuru`
0640 for the settings and TLS key; use a valid certificate for that origin. The
server terminates TLS directly on port 8443 and does not trust forwarded headers.
Restrict access with the VPS firewall as appropriate, then start:

```sh
systemctl daemon-reload
systemctl enable --now uhuru-control-plane
```

No proxy or server response cache is installed. If a proxy is later added, disable
its access/error request dumps and caching before routing secrets through it, and
repeat the log-leak checks. Fastify logging is disabled and errors return only fixed
codes; no request URL, body, SQL error or stack is emitted. See the
[Fastify server options](https://fastify.dev/docs/latest/Reference/Server/).

## Administrative HTTP interface

Every `/admin` route requires Basic Auth over HTTPS. Create the User first and retain
its ID before issuing. Responses use `Cache-Control: no-store`; all IDs below are
canonical lowercase UUIDs. There is no browser UI or billing integration.

| Method and path | Body / result |
| --- | --- |
| `POST /admin/users` | `{"label":"Alice"}` → `201`, `id`, `label` |
| `GET /admin/users` | IDs and labels only |
| `GET /admin/plan` | One setting: 720 hours, 3 unrevoked Profiles, unlimited traffic, RUB, nullable price |
| `POST /admin/users/:id/first-profile` | No body → first Profile ID, subscription times, status, link unless revoked |
| `GET /admin/users/:id/profiles` | Profile IDs, revocation time, commercial status; no credentials/links |
| `POST /admin/profiles/:id/link` | No body → explicit repeat display; does not change the Profile or term |
| `GET /admin/profiles/:id/readiness` | Per-Node historical readiness, desired access, first ACK time and last received report/time separately |
| `POST /admin/nodes` | `label`, `public_connection`, `bearer` → `201`, Node ID and label |
| `GET /admin/nodes` | Public connection parameters, revisions and diagnostics; no credentials/verifiers/snapshots |
| `PUT /admin/nodes/:id/bearer` | `{"bearer":"<new canonical token>"}` → `204` |

Node registration accepts the following **public connection candidate**:

```json
{
  "inbound_tag": "vless",
  "host": "vpn.example.com",
  "port": 443,
  "server_name": "chosen-reality-target.example",
  "public_key": "<canonical 43-character REALITY public key>",
  "short_id": "abcd",
  "fingerprint": "chrome"
}
```

Prepare the Node using the existing [agent installation instructions](../node-agent/README.md).
Match its inbound, endpoint, TCP + REALITY transport, `xtls-rprx-vision` flow, level
0, short ID and server name. The REALITY private key stays on the Node. Select and
verify the real target before deployment; the local stand target is only a test.
Transport parameters and URI formatting remain Q1/Q2 candidates, based on
[Xray's REALITY configuration](https://xtls.github.io/en/config/transports/reality.html).

Generate the independent Node Bearer as 32 CSPRNG bytes, canonical base64url without
padding. Store/transfer it in protected files, never command arguments, environment,
terminal output or logs. Send the registration body using a protected request file.
The Control Plane retains only SHA-256 of the decoded bytes. Manually install the
original Bearer and returned Node ID on the Node. To rotate, replace the server
verifier with the PUT operation, atomically replace the Node's protected file, then
restart the agent; the old secret stops working immediately, with no overlap.

For manual HTTP calls, use a mode-0600 curl config for URL/Basic credentials and a
mode-0600 JSON request file. Use `curl --config /protected/request.curl --data-binary
@/protected/body.json --output /protected/result.json`; omit `--data-binary` for
bodyless operations and set the method in that config. Do not use verbose/trace
output or put a subscription URL in argv. Keep result files private and remove them
when no longer needed. The Administrator manually transfers the returned link in
a private channel; suspected compromise requires future permanent revocation and
a new Profile, not repeated display.

## Subscription and sync contracts

`GET /s/:secret` rejects noncanonical encodings before database lookup. The candidate
responses are 404 unknown, 410 revoked, 403 expired, 503 without a ready included
Node, or 200 UTF-8 `vless://` lines with `text/plain; charset=utf-8`. A Node is eligible
only when its confirmed snapshot contains the exact Profile ID **and** credential.
Historical readiness survives disconnection and unrelated Profile changes. These
headers and status codes make no claim about Happ's own cache.

`POST /agent/v1/sync` accepts exactly `node_id`, `saved`, `verified`, `error` with the
accepted Q3 shapes. It validates canonical revisions, hashes and duplicate keys,
checks hashes against stored contents, and processes ACK provenance before recording
the response snapshot in the same Node transaction. All five ACK statuses are
implemented. Confirmed/sent revisions never roll back; repeat ACKs preserve the
first confirmation time. A verified current ACK returns compact `up_to_date`.
The existing agent supplies the 15-second cadence and 5-second timeout/retry behavior.

Automatic expiration of desired Xray membership, renewal, revocation operations,
additional Profiles and multi-Node acceptance belong to tickets 03–07. The link
already denies expired/revoked prepared data, but this slice alone does not revoke
previously distributed access in Xray. Access remains experimental until subsequent
acceptance. Restoring PostgreSQL never resets counters automatically; Q4 is open.

## Storage and copies

PostgreSQL stores readable VLESS UUIDs, original 32-byte link secrets, and UUID-bearing
desired/sent/confirmed JSONB. Only the service, PostgreSQL and trusted Administrator/
DBA/root may read this active storage. OS/role restrictions do not protect against
compromise of those trusted parties or a full disk copy.

Disable unencrypted exports, WAL archives, automatic backups and VPS disk snapshots
that contain these secrets. If a copy is explicitly made, stream directly into an
encrypted archive without an intermediate plain dump, restrict archive access, and
keep its recovery key with the Administrator separately from both VPS and archive.
No backup is created by this implementation. Backup encryption and successful restore
are **NOT RUN**; schedule, RPO, tooling and rehearsal remain Q4/ticket 15. Node secret
files retain their separate prohibition on automatic backups and full VPS snapshots.
