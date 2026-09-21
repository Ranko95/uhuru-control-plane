# Ticket 02 acceptance and Happ handoff

Implementation scope: first issuance and the accepted Q3 data/time/secrets/sync
contracts in the planning repository's `MVP-SPEC.md`. Starting commit:
`9c32c7a`. The existing agent source is pinned by the stand to the checked-out
repository; the accepted ticket-01 source is
`29ac4bde5a30709be92905cac38c7c4974604e3c`.

## Automated evidence — PASS, 2026-09-13

Typechecking and all 17 PostgreSQL/HTTPS tests passed after extracting Commercial
Access, Nodes and Configuration Delivery into modules. The final real-agent stand
also passed; its saved, sanitized [machine-readable evidence](stand-results.json)
records Node.js 24.11.0, PostgreSQL 15.19, agent source
`29ac4bde5a30709be92905cac38c7c4974604e3c`, Xray 26.5.9 and the tested Control Plane
source digest, including nested module files. Local contract tests used PostgreSQL 18.3. Fault fixtures are set up
by the test DBA, not exposed in production routes.

The final stand issued at `2026-09-13T17:52:09.211Z` and accepted the first ACK at
`2026-09-13T17:52:24.676Z`. It proved a successful HTTPS request through a real Xray
client configured from the returned URI, and repeated confirmation without a second
live Xray account. This is local-container egress, not the physical Happ/VPS check.

| Check                                                         | Evidence                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript                                                    | `npm run typecheck`                                                                                                            |
| Schema ownership, uniqueness, finite term and restricted role | `test/control-plane.test.ts`                                                                                                   |
| First issuance, concurrent retries, lost response and restart | Same HTTPS test file; dropped response bodies are actual closed TLS connections                                                |
| Atomic rollback                                               | Deferred database trigger fails at COMMIT after all desired updates                                                            |
| Time after User/Node locks; month/DST; exact end              | Held PostgreSQL row locks plus SQL boundary fixtures, 2,592,000 seconds                                                        |
| Expired/revoked retry and prepared limit                      | Existing data retains the same Profile/term; no implicit replacement                                                           |
| Bearer ownership/rotation and canonical secret input          | Real HTTPS requests, old token and verifier-as-token rejected                                                                  |
| Every ACK status and loss/staleness/conflict                  | ACK provenance checked before send; confirmation/time remain stable                                                            |
| JCS content validation                                        | Golden hash from Rust agent's test, reversed users, corrupt stored hash                                                        |
| Module interfaces                                             | Direct use cases for issuance, ACK rollback at COMMIT, token rotation, historical readiness and encoded configuration delivery |
| Real Rust agent and pinned Xray                               | `sh stand/run.sh ../node-agent`, sanitized result in `target/stand-results.json`                                               |

The log scan included malformed HTTPS input and deliberate database uniqueness
errors for VLESS UUID, raw link-secret bytes, and the Node verifier. It searched
application/agent/Xray journals and PostgreSQL logs for the disposable values,
including bytea hex encodings, full links and Basic credentials. No matches occurred.
The stand also verified private active database/WAL directories and zero soft/hard
core limits in the running services. [Independent review](code-review.md) records
the original ticket-02 implementation review. The module extraction was validated
by the updated tests and real-agent stand above.

The server's expiration predicate is already strict at `t = ends_at`; the HTTP
denial is exercised with prepared expired data. An independent SQL-boundary check
supplies precisely equal timestamps without adding a production clock override.
Automatic desired-membership expiry belongs to ticket 03.

The stand checks direct TLS, so proxy log/caching checks are **N/A: no proxy**.
The production deployment's actual VPS firewall, provider snapshot policy, filesystem
permissions and certificate provisioning still require verification on that VPS.
No encrypted archive was made: backup encryption and restore are **NOT RUN**.

## Q1/Q2 first import: NOT RUN on Android and iOS

The user will perform these checks after implementation; no prepared VPS or physical
devices were available during development. The transport and MIME remain candidates,
and neither Q1 nor Q2 is closed by the automated stand.

| Item                                             | Android | iOS     |
| ------------------------------------------------ | ------- | ------- |
| Device model, OS version/build                   | NOT RUN | NOT RUN |
| Happ version/build and installation source       | NOT RUN | NOT RUN |
| Q2-B: import before first ACK, proposed HTTP 503 | NOT RUN | NOT RUN |
| Q2-A: import after ACK without editing URI       | NOT RUN | NOT RUN |
| Q1-A: control HTTPS resource via VPN             | NOT RUN | NOT RUN |
| Public egress IP equals the Node's IP            | NOT RUN | NOT RUN |
| Unknown secret, proposed HTTP 404                | NOT RUN | NOT RUN |
| Refresh/retry behavior and existing cache        | NOT RUN | NOT RUN |

For the manual run:

1. Record the deployed Control Plane commit, agent commit/binary hash, Xray binary
   version/hash, both Happ builds and OS builds. Record sanitized public server
   parameters and the chosen REALITY target. Never include private keys, VLESS UUIDs,
   Bearers, link secrets or full links in the evidence.
2. Prepare one real Node and HTTPS Control Plane using the README. Store transport
   private keys in the agent's protected local template. The Administrator installs
   or changes those keys manually; changes require repeating this affected Q1/Q2 run.
3. Register the Node, create a User, issue once while the agent is stopped. Record
   issuance time. Check `Cache-Control: no-store` and no active configuration before
   ACK; attempt a first Happ import on each physical platform and record its behavior.
4. Start the agent. Observe saved/apply/verify events and the server's accepted ACK.
   Record `confirmed_at`, `last_seen_at`, and the separate last report. The link must
   now return exactly one configuration with the Profile credential confirmed on that
   Node. Preserve the same first confirmation time across a later poll.
5. Import or retry that unchanged link in Happ without editing parameters on each
   device. Open a controlled HTTPS resource through a new VPN transport, and verify
   that an external-IP check matches the real Node's egress IP. Record connection
   time and evidence from each platform; a connection icon or simulator is insufficient.
6. Record import/error/retry/refresh behavior for an unknown test secret and for the
   pre-ACK link. Distinguish observed cache behavior from server headers. Metadata
   extensions are **N/A: not included** in this candidate.
7. Check application/PostgreSQL and any installed proxy/platform logs using disposable
   test credentials, including deliberate malformed input and a database constraint
   error. Verify database/WAL permissions, network isolation, service core limits and
   the provider's disabled secret-bearing snapshots/backups. Keep the evidence free
   of the searched values.

Report each row as PASS / FAIL / NOT RUN with UTC issue/ACK/connect times and any
measured clock skew. Keep the full client-format decisions open for later expiry,
renewal, permanent revocation, multiple Nodes and cache scenarios in tickets 03–16.
