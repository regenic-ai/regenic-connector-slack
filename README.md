# regenic-connector-slack

Independent, local-first Regenic plugin. No core changes, Matrix/homeserver, cloud
relay, browser-cookie extraction, or telemetry. Node >=20, pnpm 9, macOS/Linux.
Windows and network filesystems are not supported by the Unix-socket service.

| Mode | Driver | Identity and capabilities |
|---|---|---|
| Default/recommended: official bot | `slackChannelDriver` / `slack-channel` | `REGENIC_SLACK_TOKEN`, one channel, read-only; existing config/API unchanged |
| Non-default, risk opt-in: local user | `slackUserDriver` / `slack-user` | Separate user-session process, explicit risk acknowledgement and conversation selection, paginated history/incremental polling, plain-text sends and thread replies |

**Prefer the official bot read-only mode. The user bridge is disabled unless you
explicitly opt in.** User-session automation may violate workspace/platform policies
and trigger account restrictions or suspension, especially private `xoxc/cookie`
automation. Official `xoxp` OAuth uses documented permissions and approval policies,
but is not a promise of zero account risk or platform approval for every use.
Private browser sessions have additional protocol-maintenance and account risks;
they are neither equally safe nor recommended. If an existing supported browser
integration or another approved safer route meets your needs, prefer that route.
**This Slack package does not provide a browser-plugin path** and does not invent one.
Opening Engine/probing never starts a user bridge, imports credentials, or migrates
an existing bot installation.

**This is a polling user-identity bridge, not a high-fidelity Beeper replacement.**
It has no WebSocket/Events API transport. It does not implement reactions,
edits/deletions, media transfer, channel creation, read receipts, or automatic login
refresh. A text caption may be imported without its attachment. Unsupported Slack
message subtypes are excluded. There has been **no real-account integration test**.

## Build and load as an external plugin

```sh
pnpm install --frozen-lockfile
pnpm build
```

Regenic only bundles Feishu, DSH and Cursor. Load this package explicitly:

```sh
# Set before starting Regenic:
export REGENIC_CHANNEL_PLUGIN=/absolute/path/to/regenic-connector-slack
# Or link it into the plugin directory:
ln -s /absolute/path/to/regenic-connector-slack ~/.regenic/plugins/slack-connector
```

For the original bot connector, set `REGENIC_SLACK_TOKEN` before starting Regenic
and install **Slack bot (read-only, recommended)** from Engine. This mode does not start or use
the user-session service.

## User credentials and permissions

The documented Slack user-token path is an **`xoxp` OAuth user token**, not an
`xoxb` bot token. Obtain it using your own Slack application's user OAuth flow and
your workspace's approval policy. The bridge imports an existing authorized
session; it does not implement an OAuth browser callback or request broader access
on your behalf. `auth.test` validates the identity at import/start and rejects bot
identities. All sends use that user's token; there is no bot fallback.

Required user scopes depend on the selected conversation types:
`channels:read`, `groups:read`, `im:read`, `mpim:read` for discovery, corresponding
`:history` scopes for reads, and `chat:write` for sends. Slack app/workspace policies,
membership, retention, token type and API limits still apply. The adapter's reply
capability indicates implemented functionality, not a guarantee of Slack permissions.

The optional **`xoxc` + `d` (`xoxd`) cookie path is unverified with real Slack
accounts**. It uses the same Web API calls, not reverse-engineered browser login
endpoints. SDK-level tests verify that a percent-encoded `Cookie: d=...` header is
attached to *every* request, including auth/discovery/history/replies/send, and
accept either raw or percent-encoded cookie input without double encoding.
These tests establish transport behavior only: they do **not** establish that Slack
accepts these APIs for a given browser session. Slack may reject this private
session type, require client boot metadata, expire it, or change its behavior.
Use the official user OAuth path where available. Never supply bot credentials or
automatically extract someone else's browser session.

### Secure local import

Only proceed after accepting the platform/account risks above. To expose user
discovery and permit user-driver operations, explicitly set
`REGENIC_SLACK_USER_BRIDGE=1` for the CLI **and** Regenic process. It is unset/off
by default; disabled catalog probes do not connect to a user service.
Login and each service start additionally require `--accept-user-session-risk`;
`xoxc` **or any cookie** additionally requires `--accept-web-session-risk`.
Missing confirmation is rejected before network requests. Engine defaults the
`risk_ack` field to **Not accepted**, requires an explicit selection and displays
the `install_confirm` warning/checkbox. The driver enforces the versioned
`risk_ack=accept-user-session-risk-v1` value even for programmatic installation or
old saved configurations; it never silently upgrades them.

```sh
# Deliberate non-default user-bridge opt-in; do not set for normal bot use.
export REGENIC_SLACK_USER_BRIDGE=1
```

Default data directory: `~/.regenic/slack-user`. To use another account/directory,
set the same **absolute** `REGENIC_SLACK_USER_DIR` for the CLI and Regenic process.
One directory is pinned to one Slack workspace/user identity.

The only import entry is `pnpm bridge login --stdin --accept-user-session-risk`: JSON with a `token` string
and an optional `cookie` string. Do not put credentials in the Engine installation,
environment variables, command arguments, URLs, files in this repository, or
shell history. Do not use `echo SECRET`, command substitution, `tee`, or shell tracing.
In an interactive local terminal, this optional Python helper reads the token
without echo and pipes it directly to the import process:

```sh
python3 -c 'import getpass,json; print(json.dumps({"token":getpass.getpass("Slack user token: ")}))' | pnpm bridge login --stdin --accept-user-session-risk
```

For the unverified browser-session path, use a trusted local credential provider
that produces the same JSON on a private pipe, with `token` and `cookie` fields.
This higher-risk import also requires `--accept-web-session-risk`; do not use
that flag to imply a supported or account-safe protocol.
There is no credential import over HTTP/socket and no token-printing diagnostic.
Login performs `auth.test` but does not read or send messages. Stop the service
before importing/replacing credentials. Revoked credentials must be reimported.

### Start, discover, and explicitly select

```sh
pnpm bridge start --accept-user-session-risk
```

Keep this foreground process running in a dedicated local terminal. In another
terminal using the same data-directory setting. Starting with an imported `xoxc`
or cookie additionally requires `--accept-web-session-risk` on every start:

```sh
pnpm bridge status
pnpm bridge list
```

Listing enumerates accessible conversations, **without selecting or syncing them**.
In Regenic Engine, deliberately choose **Slack user (opt-in, account risk)**,
accept the risk field and confirmation, and select conversations from the
dynamically discovered options. Config contains qualified IDs
(`user:TEAM:USER:CHANNEL`) and the explicit versioned risk acknowledgement, never credentials or socket bind settings. Bot and user
threads have distinct identities. Only the selected conversations are mounted in
the installation's sync directory.

For standalone operation without Regenic, explicitly select a returned channel ID:

```sh
pnpm bridge select C01234567
pnpm bridge unselect C01234567
```

The local service owns its durable selection independently of Engine. Disabling,
editing or removing an Engine installation stops its Regenic stream, **not** its
already-selected local-service channel. Use `unselect` or stop the service to stop
that local collection. Unselect removes that channel's journal/cursors; reselect
starts a new backfill, and old Regenic cursors must not be reused.
Stop with Ctrl-C or SIGTERM. Nothing installs a daemon or deploys a service.

## Sync, recovery and outbound guarantees

The service uses real Slack Web API methods: `auth.test`, `users.conversations`,
`conversations.history`, `conversations.replies`, and `chat.postMessage`. Each
15-second cycle visits one selected channel, requesting one history page and one
thread page rather than downloading a whole workspace in one blocking call.
Live/history pages alternate during backfill, and channels rotate fairly; a
rate-limited history lane retains its turn so later channels cannot starve.
Slack `Retry-After` suspends upstream work across the service.
Network failures are surfaced and retried on later cycles. Auth/permission errors
are surfaced through diagnostics/poll failures, not converted to empty directories.
Some Slack app distributions may be limited to **one history/replies request per
minute and 15 messages per page**; polling is not a latency guarantee. Large
selections can take much longer and consume API quota.

The latest-page watermark and historical pagination cursor are separate. Newest
messages are collected while older history is backfilled. All page results,
upstream cursors, per-thread reply cursors and channel journals are atomically
persisted before they become acknowledged local progress. Reconnect means resuming
the incremental history lane after a network/process restart. Expired Slack page
cursors cause an explicit diagnostic and replay from the saved watermark/start,
deduplicating against the journal; no cursor error is treated as end-of-history.
Regenic consumes an append-only per-channel journal via durable, account-qualified
offset cursors. Ingest IDs are stable and batches carry content-derived delivery IDs.

**Late thread replies:** every root discovered by top-level history (including roots
with no previous `thread_ts` or replies) gets a replies lane. One root is visited
when its selected channel gets a turn, with paginated threads finished before rotating.
After backfill discovers an old root, later replies on it are covered by this
rotation. Before that root is discovered, replies can be delayed; retention or
inaccessible roots cannot be recovered. With N roots, idle-thread revisit latency
is approximately N visits to that channel (multiplied by the number of selected
channels in service cycles), and can be worse under rate limits or pagination.
This intentionally favors correctness/explicit coverage over a false realtime claim.

Plain-text egress requires the host's stable `idempotency_key`. A deterministic
`client_msg_id` and payload fingerprint are reserved on disk **before** sending;
successful receipts are reused across process restarts. Reusing the key with a
different payload is rejected. Replying to a known reply resolves its root thread.
SDK automatic retries are disabled. Definitive Slack rejections (including 429)
can be retried with the same key after correction/backoff.

A timeout/disconnect after submission is **ambiguous**: the bridge will not resend
blindly or return a fake success. The pending transaction can be reconciled if a
later history/replies page contains its `client_msg_id` under the same user. If
Slack omits that field or the message is unavailable, the operation stays pending
and requires manual verification; this is not an exactly-once guarantee from Slack.
Do not delete transaction state or invent a new operation key just to retry an
unknown outcome. `status` reports the number of pending sends.

**Current Regenic host boundary:** the verified core's ordinary reply path supplies
`client_request_id` as the idempotency key. Some legacy forwarding/work send paths
omit a stable key; this driver intentionally rejects those instead of inventing one.
The adapter/RPC can route Slack threads when `SendIntent.target.external_id`/`root`
is explicitly supplied. The verified core's quote/reply path currently passes only
`scope_id`, so quoting a message in that UI sends channel-level text, **not** a
native Slack thread reply. This plugin does not change the core to add that routing.

## Local data and diagnostics

The service binds only `bridge.sock` inside its private directory: **no TCP bind
option**. Directory owner/type/permissions are checked (`0700`), socket and files
must belong to the current UID and be private (`0600`), symlink leaf paths are
rejected. The socket owner/type/mode is checked by the adapter before connecting.
Only bounded JSON POST requests to `/rpc` with no browser Origin are accepted.
OS UID/filesystem permissions are the local authentication boundary; other
processes under the same UID are trusted, as with the user's other local files.

`credentials.json` is **plaintext restricted local storage**, not OS-keychain or
application-level encryption. `state.json` contains private message text, journal
and transaction metadata; `account.json` pins imported identity. Files are written
using exclusive private temporary files, fsync and atomic rename. Put the directory
on a trusted local filesystem, protect backups, and use OS full-disk encryption.
The first version retains selected history and transaction metadata without
automatic pruning, and rewrites JSON snapshots: intended for modest local
selections, not a large workspace archival service.

An exclusive `owner.lock` prevents a second start or login process. **Stale locks
and existing sockets are never automatically removed.** If `already_owned...` or
`existing_socket...` appears, stop and verify that no instance is alive (the lock
contains its PID). Only after verifying ownership and that the process is gone,
remove those exact stale artifacts manually. Never remove the whole directory to
recover an unknown send. Storage failures stop further operations until restart.

`pnpm bridge status` displays safe identity/selection/error codes, per-channel sync
errors (`channel_errors`) and retry delay,
not credentials or raw Slack responses. `missing_scope`, `token_revoked`,
`not_allowed_token_type` and `rate_limited` require permission/relogin/policy/wait
actions respectively. A missing socket means the foreground service is not running
or the CLI/Regenic processes use different directory settings. Unsafe paths are
rejected rather than silently chmodded. Requests have timeouts and size limits.

## Development and offline verification

```sh
pnpm typecheck
pnpm test
# Optional: exercise conformance helpers and validators from an existing built core.
# This reads its dist packages only; it does not edit/build the other checkout.
REGENIC_ROOT=/absolute/path/to/built/regenic pnpm test
```

Tests use the real installed Slack WebClient with an injected fetch transport,
synthetic Slack response fixtures, a real private Unix-socket HTTP server, and the
real Regenic plugin host/connector registry/conformance/schema helpers. The
optional `REGENIC_ROOT` selects that core's built conformance/schema helpers;
normal TypeScript compilation still targets the declared published SDK dependencies.
No tests load local credentials, contact Slack, read a real user's messages or
send a real message. Fixture testing cannot establish workspace/session acceptance,
real API quotas or retention completeness.

## Sources and licenses

This repository is MIT-licensed. Runtime protocol library:
[`@slack/web-api` **8.2.0**](https://github.com/slackapi/node-slack-sdk/tree/main/packages/web-api)
(MIT, fixed in package manifest/lockfile); its notice is in `THIRD_PARTY_NOTICES`.
Transitive dependencies retain their own distributed notices.

Design references only:
[Beeper bridge-manager](https://github.com/beeper/bridge-manager),
[`mautrix/slack` at 8a06d2da08a16053d5b0ad0ba935cc823cfc3d07](https://github.com/mautrix/slack/tree/8a06d2da08a16053d5b0ad0ba935cc823cfc3d07)
(AGPL-3.0; **no application code copied**), and
[`beeper/slackgo` at 4b61f4fcd5e0aef337cd9d3a3e1f03aece47478e](https://github.com/beeper/slackgo/tree/4b61f4fcd5e0aef337cd9d3a3e1f03aece47478e)
(BSD-2-Clause; evaluated cookie/history/replies/RTM APIs, **not vendored or linked**).
The latter requires a Go 1.25+/1.26 toolchain; this version keeps a single Node
runtime instead. No Matrix code, homeserver, or WhatsApp implementation is included.
