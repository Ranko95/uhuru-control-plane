# Uhuru Control Plane

Задачи 02–03: Node.js 24 / Fastify / PostgreSQL, административный доступ и
выдача Ссылок подписки по HTTPS через nginx, принятый протокол синхронизации
Rust-агента. Исходный тикет:
`../../uhuru-vpn-plan-v2/.scratch/uhuru-vpn-mvp/ticket-drafts/02-first-profile-happ.md`;
истечение описано в `03-expire-subscription.md` того же каталога.
Принятые контракты находятся в `MVP-SPEC.md` репозитория планирования.
Файлы планирования и исходники существующего агента не изменялись.

The first issuance locks the User and Nodes, takes PostgreSQL time after those
locks, and commits the first Profile, 720-hour Subscription and desired snapshots
together. Repeating issuance for the same User returns the same first Profile and
link, including after restart. Expired subscriptions stay expired; revoked first
Profiles return a status without a link. Price `null` means **not configured**.

## Module structure

The Commercial Access module owns Users, the Plan, Subscriptions and Access Profiles:

- `src/access/access.router.ts` registers routes, validates parameters with schemas and delegates `(req, reply)` to `AccessController`. It inherits the administrative authentication hook.
- `src/access/controller.ts` contains `AccessController`: it reads and normalizes input, invokes injected use-case instances and sends responses after completion.
- `src/access/useCases/*/*.useCase.ts` exposes classes with constructor dependencies and `execute(dto)` for commercial decisions, first issuance, repeat link display and internal access checks for readiness and configuration delivery. Link-producing use cases receive `origin` through their constructors. Domain errors from `src/access/error.ts` are mapped to HTTP in `src/app.ts`; `src/access/profile.ts` shares status and link formatting functions.
- `src/access/repository.ts` provides `AccessRepository(db: Pool | PoolClient)` for commercial data. SQL time comparisons preserve PostgreSQL precision; use cases decide commercial statuses, the profile limit and the issued term. Transactional queries receive `options.tx`; ordinary queries use the injected database.

The Node module exposes Node registration and owns Bearer rotation, synchronization and observed readiness:

- `src/nodes/nodes.router.ts` registers administrative and agent routes, validates parameters with schemas and delegates `(req, reply)` to controller methods. Administrative routes inherit Basic Auth; the agent uses its own Bearer.
- `src/nodes/controller.ts` contains `NodesController` and `NodesAgentController`. They read the request, decode and validate canonical secrets, normalize input, invoke injected use-case instances and send the HTTP response after completion.
- `src/nodes/useCases/*/*.useCase.ts` exposes classes with constructor dependencies and `execute(dto)` for registration, Bearer rotation, Node authentication, ACK decisions and public diagnostics. Domain errors from `src/nodes/error.ts` are mapped to HTTP only in `src/app.ts`.
- `src/nodes/repository.ts` provides `NodesRepository(db: Pool | PoolClient)` for all reads and writes of `nodes` and `node_sync`. Reads and single-statement Bearer rotation use the pool; transactional queries receive `options.tx` without changing the repository's injected database.
- `src/nodes/readiness.ts` checks the confirmed snapshot and exact Profile ID/credential pair once for both administrative readiness and configuration delivery. Historical readiness remains separate from desired access and inclusion in subscriptions.

The Access Distribution module coordinates Commercial Access changes with Nodes:

- `src/access-distribution.ts` provides `AccessDistribution` with injected Node and Commercial Access repositories. Its `distributeAccessChange`, `refreshNodeAccess` and `enrollNode` methods accept DTOs and required `{ tx }` options and own issuance serialization, ordered Node locking, PostgreSQL time selection, desired snapshot updates and initial Node enrollment. It is assembled once in `src/app.ts` and leaves transaction completion to the caller. Commercial decisions remain in the Commercial Access module; synchronization remains in the Node module.

The Configuration Delivery module serves Subscription Links:

- `src/delivery/delivery.router.ts` registers `/s/:secret`, validates the parameter shape with a schema and delegates `(req, reply)` to `DeliveryController`.
- `src/delivery/controller.ts` contains `DeliveryController` with an injected `GetConfigurationsUseCase`. It validates the canonical secret and raw URL before database access and sends the successful text response after COMMIT.
- `src/delivery/roscomvpn-default.json` pins RoscomVPN DEFAULT. `DeliveryController` imports the JSON, adapts its name, preserves the upstream CDN URLs for geo files, and builds the Routing header in `getConfigurations` after the use case completes. Geo files are downloaded by clients directly from the CDN: [deployment and client acceptance](docs/roscomvpn-routing.ru.md).
- `src/delivery/useCases/getConfigurations/getConfigurations.useCase.ts` exposes `GetConfigurationsUseCase` with an injected pool and real `AuthorizeSubscriptionLinkUseCase` and `ListReadyNodesUseCase` instances. Its `execute({ linkSecret })` opens the read transaction with `transaction(pool, work)`, passes `{ tx }` through both nested use cases, authorizes the link, selects ready Nodes and formats the VLESS configurations. Data access stays in the owning modules' repositories; delivery has no tables of its own. One client preserves the existing isolation level, without promising one snapshot across successive SELECTs.

Commercial Access and Nodes meet in Access Distribution instead of importing each other's enrollment operations.
`src/secrets.ts` shares token decoding and hashing independently of HTTP;
`src/snapshot.ts` retains canonical snapshot validation and hashing. `src/app.ts`
assembles the modules and configures administrative authentication,
JSON parsing, response headers and sanitized error handling.
It constructs real use-case instances and injects them into controllers.
Readiness receives `GetProfileAccessUseCase` directly. Configuration Delivery receives
its authorization and readiness use cases through the constructor.
The pool-backed repositories and Access Distribution are assembled once and hold no checked-out client between calls.
Each use case accepts one typed operation DTO. Internal operations that join the caller's
transaction receive technical options separately from that DTO.
`src/database.ts` defines `QueryOptions = { tx?: PoolClient }` for participating queries,
which select `options.tx ?? this.db`, and `TransactionOptions = { tx: PoolClient }` for
explicit locks and Access Distribution operations. Optional query options default to `{}`;
required transaction options have no default. `profileLink` and the two nested delivery
use cases pass options through without opening another transaction.
Controllers, use cases and repositories now use classes throughout, with no functional compatibility adapters.
Readiness, snapshot, secret, validation and profile helpers remain functions; `profileLink` stays a shared helper.
Controller validation precedes database access. First issuance, repeat link display,
registration, synchronization and configuration delivery use the existing `transaction` helper through
their `execute` methods; their responses follow COMMIT.
Each parallel transaction acquires its own client and passes the same `{ tx }` to every
participating query. Repositories and use cases never retain that client after the callback.
The shared helper releases the client after success, an operation error or a failed COMMIT.
Pool queries release their clients automatically.

`src/database.ts` provides the shared transaction implementation. First issuance
locks the User, then the shared enrollment/issuance row, then Nodes in ID order;
only then does it read PostgreSQL time. `src/access-distribution.ts` owns that ordering
and updates desired snapshots on the same database client, hiding snapshot details
behind its seam. Its SQL remains in the owning repositories.
Репозитории не завершают транзакции самостоятельно: Профиль, Подписка и desired
по-прежнему фиксируются вместе. Регистрация Ноды получает начальный Желаемый
доступ через Распределение доступа под общей блокировкой регистрации/выдачи.
Синхронизация сначала блокирует Ноду, затем её sync-state, проверяет происхождение
ACK по ранее отправленному снимку и записывает новый ответ в той же транзакции.
Каждый опрос пересчитывает желаемый состав по времени PostgreSQL после обеих
блокировок, до сравнения ревизий отчёта агента. Блокировка Пользователя после
блокировки Ноды не запрашивается. Повторный ACK сохраняет время первого подтверждения.

See [the domain glossary](CONTEXT.md). The HTTP-backend/PostgreSQL checks remain
the behavioral test surface, alongside direct use-case checks for issuance and
ACK rollback at COMMIT, token rotation, historical readiness and configuration
delivery. Delivery checks also cover URI encoding and response headers.
Client lifetime checks use bounded pools: one client checks release and prevents nested acquisitions;
two clients check that a blocked Node request does not delay another Node's ACK or undo its confirmation on rollback.

## Run the checks

```sh
npm ci --ignore-scripts
npm run lint
npm run format:check
npm run typecheck
npm test
sh stand/run.sh ../node-agent
```

`npm test` creates a private temporary PostgreSQL cluster on a free loopback TCP port with SCRAM passwords,
runs real loopback HTTP tests using a restricted application role, then removes the cluster.
PostgreSQL `initdb`/`pg_ctl` must be on PATH (Homebrew PostgreSQL 18 is detected).
The native Node test runner accepts filters, e.g. `npm test -- --test-name-pattern='ACK'`.

## Run locally on macOS or Linux

Use Node.js 24.11+ and a local PostgreSQL 15+ (Homebrew PostgreSQL 18 is detected by the test runner).
Run the PostgreSQL setup commands as a cluster administrator (the Homebrew user, or `postgres` on Linux).
Create a fresh development database once:

```sh
createdb uhuru
psql -X -v ON_ERROR_STOP=1 -d uhuru -f schema.sql
psql -X -v ON_ERROR_STOP=1 -d uhuru -f deploy/app-role.sql
psql -X -d postgres -c "SET password_encryption = 'scram-sha-256'" -c '\password uhuru'
```

Add `host uhuru uhuru 127.0.0.1/32 scram-sha-256` before other matching rules in `pg_hba.conf`
(find it with `psql -X -At -d postgres -c 'SHOW hba_file'`), then reload with
`psql -X -d postgres -c 'SELECT pg_reload_conf()'`.
Copy `deploy/settings.example.json` to the ignored `settings.json`, enter the database password
and a separate admin password, set `origin` to `https://localhost`, and run:

```sh
chmod 600 settings.json
ulimit -c 0
npm start -- settings.json
```

The local HTTP API listens on `127.0.0.1:8080`; no nginx or systemd is needed for local API work.
Subscription links use the configured HTTPS origin; testing them through HTTPS still requires a TLS proxy.

Use `npm run format` to apply Prettier and `npm run lint -- --fix` to apply ESLint fixes.
Keep `printWidth: 120`, use braces for every branch and loop, and declare one variable per statement.
Separate neighboring functions and logical phases with a blank line: read data, validate, change state, return a result.
Keep related instructions together. ESLint enforces structural separators; the phase boundaries need a manual check.
Write complex SQL as multiline queries and keep Python and shell files readable manually.

The stand builds the existing Rust agent and pinned Xray v26.5.9, then adds this
Control Plane, nginx and PostgreSQL. It uses an ARM64 private privileged systemd container,
with **no host mounts or published ports**. Secrets are generated inside it, the
container is removed on exit, and only sanitized results go to
`target/stand-results.json`. The agent uses HTTPS through nginx; a separate local
TLS 1.3 target and Xray client exercise the
TCP + REALITY + XTLS Vision candidate using the URI returned by this server.
This does not establish public VPS routing or Happ compatibility.

See [acceptance evidence and the manual Happ handoff](docs/acceptance.md).
Для задачи 03 записаны [результаты истечения и оставшиеся проверки Happ](docs/verification/03-expire-subscription.md).

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
install -m 0755 deploy/check-runtime.sh /usr/local/sbin/uhuru-check-runtime
```

These SQL files are a one-time fresh installation, never a startup reset or a
restore procedure. The database remains owned by `postgres`; the service role
cannot delete records or change Profile credentials, owners or `first_profile_id`.
Use `host uhuru uhuru 127.0.0.1/32 scram-sha-256` before other matching rules in `pg_hba.conf`.
Keep local peer authentication for PostgreSQL administration. PostgreSQL listens only on
`127.0.0.1`; never expose its TCP port publicly. Keep `PGDATA` and its `pg_wal` directory owned by PostgreSQL and mode
0700, backups excluded.

Before loading secrets, install [the PostgreSQL logging settings](deploy/postgresql-secrets.conf)
in the dedicated cluster's included configuration directory and restart that cluster.
The settings also enable `password_encryption = 'scram-sha-256'`. Assign the role password with
`runuser -u postgres -- psql -X -d postgres -c '\password uhuru'`, then reload `pg_hba.conf`.
Disable any extension, audit collector or platform collector that records statements,
parameters or process memory. Suppressing parameter logs alone does not suppress
constraint error details; the configuration also suppresses ordinary server errors
and their statement text. See the [PostgreSQL logging reference](https://www.postgresql.org/docs/current/runtime-config-logging.html).

Set both soft and hard `LimitCORE=0` for the actual PostgreSQL cluster unit, as the
provided Control Plane unit already does. Require a file-mode kernel `core_pattern`
without a leading `|`; pipe collectors bypass the usual core limit. Set that host
policy before starting services. The Control Plane refuses startup if these core
prerequisites are absent through the unit's `ExecStartPre` check; the application itself
refuses a privileged database role. Review the same policy
for the separate Node Agent/Xray services.

Create `/etc/uhuru/settings.json` from [the example](deploy/settings.example.json),
with separate unique random database/admin passwords and the final HTTPS origin.
The `database` object contains `host`, `port`, `user`, `password`, `database` and `maxPoolSize`, all required.
`maxPoolSize` is a positive integer limiting the number of connections in the pool; the example uses `10`;
use `127.0.0.1:5432`, role `uhuru` and database `uhuru` on the dedicated VPS. Use root:`uhuru`
0640 for the settings. The application listens on HTTP `127.0.0.1:8080` only;
nginx terminates public HTTPS on port 443. It does not trust forwarded headers.
Install [the nginx site](deploy/uhuru-control-plane.nginx.conf) with a public certificate,
then start:

```sh
systemctl daemon-reload
systemctl enable --now uhuru-control-plane
```

The nginx site disables access/error logs, proxy caching, and request/response
buffering so secret-bearing URLs and bodies are not persisted by the proxy.
Fastify logging is disabled and errors return only fixed codes; no request URL,
body, SQL error or stack is emitted. Follow [the VPS deployment guide](docs/vps-deployment.ru.md)
for certificate issuance, firewall and proxy checks. See the
[Fastify server options](https://fastify.dev/docs/latest/Reference/Server/).

The [recorded VPS deployment and step-by-step runbook](docs/vps-deployment-runbook.ru.md)
contains the commands, host settings and verification results from the deployment on 3 October 2026.
For an existing peer-based installation, follow [the password transition guide](docs/database-password-transition.ru.md)
before deploying the new application; it preserves compatibility with the previous release for rollback.

Для обновлений после push в `main` используйте [GitHub Actions и SSH-автодеплой](docs/autodeploy.ru.md):
обязательные typecheck/тесты, подготовка версии до перезапуска systemd и откат при
неудачном запуске. Инструкция включает разовую настройку ограниченного SSH-доступа
и команду ручного отката.

## Administrative HTTP interface

Every `/admin` route requires Basic Auth over HTTPS. Create the User first and retain
its ID before issuing. Responses use `Cache-Control: no-store`; all IDs below are
canonical lowercase UUIDs. There is no browser UI or billing integration.

| Method and path                       | Body / result                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /admin/users`                   | `{"label":"Alice"}` → `201`, `id`, `label`                                                             |
| `GET /admin/users`                    | IDs and labels only                                                                                    |
| `GET /admin/plan`                     | One setting: 720 hours, 3 unrevoked Profiles, unlimited traffic, RUB, nullable price                   |
| `POST /admin/users/:id/first-profile` | No body → first Profile ID, subscription times, status, link unless revoked                            |
| `GET /admin/users/:id/profiles`       | Profile IDs, revocation time, commercial status; no credentials/links                                  |
| `POST /admin/profiles/:id/link`       | No body → explicit repeat display; does not change the Profile or term                                 |
| `GET /admin/profiles/:id/readiness`   | Per-Node historical readiness, desired access, first ACK time and last received report/time separately |
| `POST /admin/nodes`                   | `label`, `public_connection`, `bearer` → `201`, Node ID and label                                      |
| `GET /admin/nodes`                    | Public connection parameters, revisions and diagnostics; no credentials/verifiers/snapshots            |
| `PUT /admin/nodes/:id/bearer`         | `{"bearer":"<new canonical token>"}` → `204`                                                           |

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

В момент `ends_at` ссылка сразу перестаёт выдавать конфигурации. Каждый опрос
агента удаляет истёкшие Профили из полного desired-снимка, включая пустой
управляемый набор; неизменный состав сохраняет ревизию. Обращение к панели/ссылке
не требуется. Агент сохраняет набор, применяет его через Xray API и проверяет
до ACK без перезапуска Xray. Подписка, Профиль, UUID и секрет ссылки сохраняются,
место в лимите не освобождается. Поздний ACK разрешения не восстанавливает ссылку.

Администратор видит `status: expired` в списке Профилей отдельно от готовности
Ноды. `desired_access: false` при историческом `ready: true` означает, что
последнее подтверждение ещё разрешало доступ. Подтверждённое удаление требует
снимка confirmed без Профиля **и** подтверждения последней desired-ревизии из
`GET /admin/nodes`; одного старого подтверждения пустого состава недостаточно.
При потере связи применение запрета остаётся неподтверждённым. Цель при исправной
связи — отказ **новой** VLESS-аутентификации в пределах 60 секунд; старые
соединения наблюдаются отдельно, без обещания их разрыва.

Продление, операции отзыва, дополнительные Профили и приёмка нескольких Нод
остаются в задачах 04–07. Физические проверки истечения/refresh в Happ на Android
и iOS — **NOT RUN**. Восстановление PostgreSQL не сбрасывает счётчики автоматически;
Q4 остаётся открытым.

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
