const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { randomBytes } = require("node:crypto");
const { mkdtemp, rm, stat, writeFile, chmod, symlink, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { request } = require("node:http");
const fixture = require("./fixtures/user-protocol.json");
const { SlackUserApi, BridgeError, messagePage, credentials } = require("../dist/user-api");
const { PrivateStore } = require("../dist/user-store");
const { UserSession } = require("../dist/user-session");
const { serveSession, UserBridgeClient } = require("../dist/user-rpc");
const { slackUserDriver } = require("../dist/slack-user-driver");
const { slackChannelDriver } = require("../dist/slack-channel-driver");
const { USER_RISK_ACK, requireSessionRisk } = require("../dist/user-risk");
const { spawnSync } = require("node:child_process");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const testUtils = process.env.REGENIC_ROOT
  ? require(join(process.env.REGENIC_ROOT, "packages/connector-test-utils/dist"))
  : require("@regenic/connector-test-utils");
const contract = process.env.REGENIC_ROOT
  ? require(join(process.env.REGENIC_ROOT, "packages/connector-contract/dist"))
  : require("@regenic/connector-contract");

const generatedAuth = (web = false) => ({
  token: ["xox", web ? "c-" : "p-", randomBytes(16).toString("hex")].join(""),
  ...(web ? { cookie: ["xoxd-", randomBytes(24).toString("base64")].join("") } : {}),
});
function transport(handler, auth = generatedAuth()) {
  const calls = [];
  const api = new SlackUserApi(auth, {
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, "https://slack.com");
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "POST");
      const method = new URL(url).pathname.split("/").pop();
      const args = Object.fromEntries(new URLSearchParams(init.body));
      calls.push({ method, args, headers: init.headers });
      const response = await handler(method, args);
      if (response instanceof Response) return response;
      return new Response(JSON.stringify(response), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  return { api, calls, auth };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "rs-"));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new PrivateStore(directory);
  await store.prepare();
  return { directory, store, cleanup: (callback) => cleanups.push(callback) };
}
function historyTransport() {
  return transport((method, args) => {
    if (method === "auth.test") return fixture.identity;
    if (method === "users.conversations") return fixture.directory;
    if (method === "conversations.history") {
      if (args.cursor === "older-page") return fixture.older;
      return args.oldest ? fixture.live : fixture.recent;
    }
    if (method === "conversations.replies") return args.ts === "1700000000.000001" ? fixture.lateReply : fixture.empty;
    if (method === "chat.postMessage") return fixture.receipt;
    assert.fail(`Unexpected Slack API method ${method}`);
  });
}

describe("Slack user SDK protocol boundary (offline synthetic response fixtures)", () => {
  it("classifies both one-to-one and multiparty DMs as direct conversations", async () => {
    const { api } = transport(() => ({
      ok: true,
      channels: [
        { id: "DONE", user: "UPEER", is_im: true },
        { id: "GROUP", name: "group-dm", is_mpim: true, is_im: false },
        { id: "CONE", name: "engineering", is_im: false, is_mpim: false },
      ],
    }));
    assert.deepEqual((await api.directory()).conversations.map(({ id, kind }) => ({ id, kind })), [
      { id: "DONE", kind: "direct" },
      { id: "GROUP", kind: "direct" },
      { id: "CONE", kind: "channel" },
    ]);
  });
  it("uses actual WebClient methods and propagates d cookie on every request without putting credentials in URLs", async () => {
    const auth = generatedAuth(true);
    const { api, calls } = transport((method) => {
      if (method === "auth.test") return fixture.identity;
      if (method === "users.conversations") return fixture.directory;
      if (method === "chat.postMessage") return fixture.receipt;
      return fixture.empty;
    }, auth);
    assert.deepEqual(await api.identity(), { team: "TLOCAL", user: "USELF" });
    assert.equal((await api.directory()).conversations[1].kind, "direct");
    await api.history("CONE", "page", "1700000000.000001");
    await api.replies("CONE", "1700000000.000001", "thread-page");
    await api.send("CONE", "hello", "00000000-0000-4000-a000-000000000000", "1700000000.000001");
    assert.equal(calls.length, 5);
    for (const call of calls) {
      const headers = new Headers(call.headers);
      assert.equal(headers.get("cookie"), `d=${encodeURIComponent(auth.cookie)}`);
      assert.equal(headers.get("authorization"), `Bearer ${auth.token}`);
    }
    assert.equal(calls[4].args.thread_ts, "1700000000.000001");
    assert.equal(calls[4].args.client_msg_id, "00000000-0000-4000-a000-000000000000");
  });
  it("rejects bot credentials and bot auth.test identities", async () => {
    assert.throws(() => credentials({ token: ["xox", "b-", randomBytes(10).toString("hex")].join("") }), /user_token_required/);
    assert.throws(() => credentials({ token: generatedAuth(true).token }), /web_cookie_required/);
    const encoded = generatedAuth(true);
    assert.equal(credentials({ ...encoded, cookie: encodeURIComponent(encoded.cookie) }).cookie, encoded.cookie);
    const { api } = transport(() => ({ ...fixture.identity, bot_id: "BONE" }));
    await assert.rejects(api.identity(), /user_identity_required/);
  });
  it("surfaces authentication, malformed upstream pages and rate limits with no unsafe upstream text", async () => {
    const auth = generatedAuth();
    const logs = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push(args.join(" "));
    try {
      const { api } = transport(() => ({ ok: false, error: "invalid_auth", detail: auth.token }), auth);
      await assert.rejects(api.identity(), (error) => error.code === "invalid_auth" && !String(error.stack).includes(auth.token));
      const limited = transport(() => new Response("", { status: 429, headers: { "retry-after": "2" } }));
      await assert.rejects(limited.api.history("CONE"), (error) => error.code === "rate_limited" && error.retry_after_ms === 2000);
      const network = transport(() => { throw new Error(auth.token); }, auth);
      await assert.rejects(network.api.history("CONE"), (error) => error.code === "upstream_unavailable" && !error.message.includes(auth.token));
      assert.throws(() => messagePage({ messages: [{}] }), /invalid_upstream_message/);
      assert.throws(() => messagePage({ messages: [], has_more: true }), /missing_upstream_cursor/);
      assert.throws(() => messagePage({ messages: [], response_metadata: { next_cursor: 42 } }), /invalid_upstream_cursor/);
      assert.throws(() => messagePage({ messages: [], has_more: "yes" }), /invalid_upstream_page/);
      assert.throws(() => messagePage({ ok: true }), /invalid_upstream_page/);
    } finally { console.error = originalError; console.warn = originalWarn; }
    assert.equal(logs.join("").includes(auth.token), false);
  });
});

describe("durable user journal, backfill, thread recovery and transactions", () => {
  it("keeps per-channel sync failures visible when another channel succeeds, without failing healthy polls", async (t) => {
    const { store } = await temporary(t);
    const { api } = historyTransport();
    let denied = true;
    api.history = async (id) => {
      if (id === "CONE" && denied) throw new BridgeError("missing_scope");
      return messagePage(fixture.empty);
    };
    const session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await session.select({ id: "DONE" });
    await assert.rejects(session.tick(), /missing_scope/);
    assert.doesNotThrow(() => session.poll("DONE"));
    await session.tick();
    assert.throws(() => session.poll("CONE"), /missing_scope/);
    assert.deepEqual(session.status().channel_errors, { CONE: "missing_scope" });
    assert.doesNotThrow(() => session.poll("DONE"));
    denied = false;
    await session.tick();
    assert.deepEqual(session.status().channel_errors, {});
    assert.doesNotThrow(() => session.poll("CONE"));
  });
  it("keeps live and history watermarks separate over restart, deduplicates overlap and finds late replies to roots with no thread_ts", async (t) => {
    const { store } = await temporary(t);
    const { api, calls } = historyTransport();
    let session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await session.tick();
    const first = session.poll("CONE");
    assert.equal(first.messages.length, 2);
    assert.equal(first.history_pending, true);
    session = new UserSession(api, store);
    await session.initialize();
    await session.tick();
    await session.tick();
    await session.tick();
    await session.tick();
    const recovered = session.poll("CONE", first.next);
    // Top-level history is done; every newly discovered root still needs its first reply page.
    assert.equal((await store.read("state.json")).channels.CONE.history_done, true);
    assert(recovered.messages.some((m) => m.text === "arrived while offline"));
    assert(recovered.messages.some((m) => m.text === "old root without thread_ts"));
    assert(recovered.messages.some((m) => m.thread_ts === "1700000000.000001"));
    const all = session.poll("CONE").messages;
    assert.equal(new Set(all.map((m) => m.ts)).size, all.length);
    assert(calls.some((call) => call.method === "conversations.history" && call.args.cursor === "older-page" && !call.args.oldest));
    assert(calls.some((call) => call.method === "conversations.history" && call.args.oldest === "1700000200.000002"));
    await session.send("CONE", "reply to a reply", "reply-root", "1700000400.000001");
    assert.equal(calls.find((call) => call.method === "chat.postMessage").args.thread_ts, "1700000000.000001");
    assert.throws(() => session.poll("CONE", "foreign/offset"), /invalid_local_cursor/);
    assert.throws(() => session.poll("CTWO"), /conversation_not_selected/);
  });
  it("persists thread pagination and incrementally visits threads after restart", async (t) => {
    const { store } = await temporary(t);
    const calls = [];
    const api = {
      identity: async () => ({ team: "TLOCAL", user: "USELF" }),
      directory: async () => ({ conversations: [{ id: "CONE", label: "one", kind: "channel" }] }),
      history: async (_id, _cursor, oldest) => messagePage(oldest ? fixture.empty : {
        messages: [{ ts: "1700000000.000001", user: "UPEER", text: "root" }],
      }),
      replies: async (_id, root, cursor, oldest) => {
        calls.push({ root, cursor, oldest });
        if (!cursor && !oldest) return messagePage({
          messages: [{ ts: "1700000400.000001", user: "UPEER", text: "one", thread_ts: root }],
          has_more: true, response_metadata: { next_cursor: "thread-next" },
        });
        return messagePage({
          messages: [{ ts: "1700000500.000001", user: "UPEER", text: "two", thread_ts: root }],
        });
      },
    };
    let session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await session.tick();
    session = new UserSession(api, store);
    await session.initialize();
    await session.tick();
    await session.tick();
    assert.equal(calls[1].cursor, "thread-next");
    assert.equal(calls[1].oldest, undefined);
    assert.equal(calls[2].oldest, "1700000500.000001");
    assert.equal(session.poll("CONE").messages.length, 3);
  });
  it("persists a multi-page live lane without advancing its high watermark early, and pages the local journal at 100 records", async (t) => {
    const { store } = await temporary(t);
    const { api, calls } = transport((method, args) => {
      if (method === "auth.test") return fixture.identity;
      if (method === "users.conversations") return fixture.directory;
      if (method === "conversations.replies") return fixture.empty;
      if (!args.oldest) return {
        ok: true, messages: [{ ts: "1700000000.000001", user: "UPEER", text: "seed" }],
      };
      if (args.cursor === "live-next") return {
        ok: true, messages: [{ ts: "1700000100.000001", user: "UPEER", text: "last page" }],
      };
      if (args.oldest === "1700000000.000001") return {
        ok: true, messages: Array.from({ length: 100 }, (_, index) => ({
          ts: `1700000200.${String(index + 1).padStart(6, "0")}`, user: "UPEER", text: `message ${index}`,
        })), has_more: true, response_metadata: { next_cursor: "live-next" },
      };
      return fixture.empty;
    });
    let session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await session.tick();
    await session.tick();
    let saved = await store.read("state.json");
    assert.equal(saved.channels.CONE.live.oldest, "1700000000.000001");
    assert.equal(saved.channels.CONE.live.cursor, "live-next");
    session = new UserSession(api, store);
    await session.initialize();
    await session.tick();
    saved = await store.read("state.json");
    assert.equal(saved.channels.CONE.live.oldest, "1700000200.000100");
    assert.equal(saved.channels.CONE.live.cursor, undefined);
    const first = session.poll("CONE");
    assert.equal(first.messages.length, 100);
    assert.equal(first.has_more, true);
    const second = session.poll("CONE", first.next);
    assert.equal(second.messages.length, 2);
    assert.equal(second.has_more, false);
    await session.tick();
    assert(calls.some((call) => call.method === "conversations.history" && call.args.oldest === "1700000200.000100"));
    await session.unselect("CONE");
    await session.select({ id: "CONE" });
    await session.tick();
    assert.throws(() => session.poll("CONE", first.next), /invalid_local_cursor/);
  });
  it("reuses the same client_msg_id after a definitive rate-limit rejection", async (t) => {
    const { store } = await temporary(t);
    const { api } = historyTransport();
    const ids = [];
    api.send = async (_channel, _text, transaction) => {
      ids.push(transaction);
      if (ids.length === 1) throw new BridgeError("rate_limited", 1);
      return "1700000500.000001";
    };
    const session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await assert.rejects(session.send("CONE", "hello", "retry-after"), /rate_limited/);
    assert.equal(Object.keys((await store.read("state.json")).transactions).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.send("CONE", "hello", "retry-after");
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  });
  it("does not starve a rate-limited channel behind the first channel, including across restart", async (t) => {
    const { store } = await temporary(t);
    const { api } = historyTransport();
    const ids = [];
    api.history = async (id) => {
      ids.push(id);
      if (ids.length === 2) throw new BridgeError("rate_limited", 1);
      return messagePage(fixture.empty);
    };
    let session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await session.select({ id: "DONE" });
    await session.tick();
    await assert.rejects(session.tick(), /rate_limited/);
    session = new UserSession(api, store);
    await session.initialize();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.tick();
    assert.deepEqual(ids, ["CONE", "DONE", "DONE"]);
    assert.equal(session.poll("DONE").live_seeded, true);
  });
  it("reserves stable transaction ids, replays a successful receipt after restart and rejects conflicting keys", async (t) => {
    const { store } = await temporary(t);
    const { api, calls } = historyTransport();
    let session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    const receipt = await session.send("CONE", "hello", "stable-operation", "1700000000.000001");
    session = new UserSession(api, store);
    await session.initialize();
    assert.deepEqual(await session.send("CONE", "hello", "stable-operation", "1700000000.000001"), receipt);
    assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
    await assert.rejects(session.send("CONE", "changed", "stable-operation"), /idempotency_conflict/);
    const state = JSON.stringify(await store.read("state.json"));
    assert.equal(state.includes("stable-operation"), false);
  });
  it("does not resend an ambiguous timeout; reconciles its client_msg_id from user history", async (t) => {
    const { store } = await temporary(t);
    let transaction;
    let sends = 0;
    const { api } = transport((method, args) => {
      if (method === "auth.test") return fixture.identity;
      if (method === "users.conversations") return fixture.directory;
      if (method === "chat.postMessage") { sends++; transaction = args.client_msg_id; throw new Error("offline"); }
      if (method === "conversations.history") return {
        messages: [{ ts: "1700000600.000001", user: "USELF", text: "hello", client_msg_id: transaction }], ok: true,
      };
      return fixture.empty;
    });
    let session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await assert.rejects(session.send("CONE", "hello", "ambiguous"), /send_outcome_unknown/);
    session = new UserSession(api, store);
    await session.initialize();
    await assert.rejects(session.send("CONE", "hello", "ambiguous"), /send_outcome_unknown/);
    assert.equal(sends, 1);
    await session.tick();
    assert.deepEqual(await session.send("CONE", "hello", "ambiguous"), { ts: "1700000600.000001" });
    assert.equal(sends, 1);
  });
  it("surfaces auth failures instead of reporting an empty successful sync, and rejects account replacement", async (t) => {
    const { store } = await temporary(t);
    const { api } = historyTransport();
    const session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    api.history = async () => { throw new BridgeError("token_revoked"); };
    await assert.rejects(session.tick(), /token_revoked/);
    assert.throws(() => session.poll("CONE"), /token_revoked/);
    api.identity = async () => ({ team: "TOTHER", user: "UOTHER" });
    await assert.rejects(new UserSession(api, store).initialize(), /account_changed/);
  });
  it("resets expired upstream pagination explicitly and restarts backfill without dropping the journal", async (t) => {
    const { store } = await temporary(t);
    const { api } = historyTransport();
    const session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    await session.tick();
    const original = api.history.bind(api);
    api.history = async (id, cursor, oldest) => {
      if (cursor === "older-page") throw new BridgeError("invalid_cursor");
      return original(id, cursor, oldest);
    };
    await assert.rejects(session.tick(), /upstream_cursor_reset_retry/);
    assert.equal((await store.read("state.json")).channels.CONE.history_cursor, undefined);
    assert.equal(session.poll("CONE").messages.length, 2);
  });
  it("blocks all later side effects on storage failure and rejects corrupted state", async (t) => {
    const { store } = await temporary(t);
    const { api, calls } = historyTransport();
    const session = new UserSession(api, store);
    await session.initialize();
    await session.select({ id: "CONE" });
    const originalWrite = store.write.bind(store);
    store.write = async () => { throw new Error("disk full"); };
    await assert.rejects(session.exclusive(() => session.send("CONE", "hello", "no-disk")), /storage_failed/);
    assert.equal(calls.some((call) => call.method === "chat.postMessage"), false);
    await assert.rejects(session.exclusive(() => session.tick()), /storage_failed/);
    store.write = originalWrite;
    await store.write("state.json", { version: 1 });
    await assert.rejects(new UserSession(api, store).initialize(), /corrupt_local_store/);
  });
});

describe("private Unix service and real Regenic SDK adapter", () => {
  it("locks ownership without unlinking active or stale locks, rejects insecure paths and preserves permissions", async (t) => {
    const { store, directory } = await temporary(t);
    const release = await store.lock();
    await assert.rejects(store.lock(), /already_owned/);
    assert.equal((await stat(join(directory, "owner.lock"))).mode & 0o777, 0o600);
    await release();
    await writeFile(join(directory, "owner.lock"), "999999999\n", { mode: 0o600 });
    await assert.rejects(store.lock(), /already_owned/);
    assert.equal(await readFile(join(directory, "owner.lock"), "utf8"), "999999999\n");
    await store.write("state.json", { version: 1 });
    assert.equal((await stat(join(directory, "state.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await chmod(directory, 0o755);
    await assert.rejects(store.prepare(), /unsafe_local_path/);
    await chmod(directory, 0o700);
    await symlink(join(directory, "state.json"), join(directory, "link.json"));
    await assert.rejects(store.read("link.json"), /unsafe_local_path/);
  });
  it("discovers without selecting, maps selected streams and user egress using actual host/contract registries, disposes cleanly", async (t) => {
    const { store, directory, cleanup } = await temporary(t);
    const { api, calls, auth } = historyTransport();
    const session = new UserSession(api, store);
    const service = await serveSession(store, session, { interval_ms: 3600000 });
    cleanup(() => service.close());
    const env = { REGENIC_SLACK_USER_DIR: directory, REGENIC_SLACK_USER_BRIDGE: "1" };
    const client = new UserBridgeClient(env);
    assert.equal((await stat(join(directory, "bridge.sock"))).mode & 0o777, 0o600);
    const fields = await slackUserDriver.listCatalogFieldOptions({ env });
    assert.equal(fields.conversation_ids.length, 2);
    assert.deepEqual((await client.status()).selected, []);
    assert.equal(calls.some((call) => call.method === "conversations.history"), false);
    const installation = slackUserDriver.install({
      id: "user-1", org_id: "local", config: {
        risk_ack: USER_RISK_ACK,
        conversation_ids: fields.conversation_ids[0].value,
        token: generatedAuth().token,
      }, now: "2026-10-29T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(installation.config), ["conversation_ids", "risk_ack"]);
    assert.equal(installation.credentials_ref, undefined);
    testUtils.verifyChannelDriverConformance({ driver: slackUserDriver, enabled: installation });
    const host = await createHost();
    cleanup(() => host.dispose());
    const registry = new testUtils.MemoryConnectorRegistry();
    await host.plugin(definePlugin({ name: "connectors", apply(ctx) { ctx.provide("connectors", registry); } }));
    const source = await slackUserDriver.bindSyncSource(installation, host, env);
    assert.equal((await source.listDirectory(null)).members.length, 1);
    const [stream] = await slackUserDriver.resolveStreams(installation, host, env);
    await session.exclusive(() => session.tick());
    await testUtils.verifyPollConnectorConformance({
      connector: stream.connector, cursor: null, connector_id: installation.id, source: "slack",
    });
    const result = await stream.connector.poll(null);
    assert.equal(contract.validateIngestBatch(result.batch).success, true);
    assert.equal(result.batch.records[0].scope.id, "user:TLOCAL:USELF:CONE");
    assert(result.batch.records.some((r) => r.direction_tags.includes("outbound")));
    const thread = { source: "slack", target: "user:TLOCAL:USELF:CONE" };
    assert.equal(slackChannelDriver.matchesThread({
      ...installation, config: { channel_id: "CONE" }, connector_type: "slack-channel",
    }, thread), false);
    const egress = await slackUserDriver.bindEgress(installation, thread, host, env);
    const intent = { installation_id: installation.id, idempotency_key: "adapter-send", content: [
      { role: "body", media_type: "text/plain", text: "hello" },
    ], target: { external_id: "user:TLOCAL:USELF:CONE:1700000100.000001" } };
    const receipt = await egress.send(intent);
    assert.equal(receipt.accepted, true);
    assert.deepEqual(await egress.send(intent), receipt);
    assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, 1);
    assert.equal(slackUserDriver.outboundId(thread, receipt), `user:TLOCAL:USELF:CONE:out:${receipt.rpc_id}`);
    await egress.send({
      ...intent, idempotency_key: "reply-to-local-outbound",
      target: { external_id: slackUserDriver.outboundId(thread, receipt) },
    });
    assert.equal(calls.filter((c) => c.method === "chat.postMessage")[1].args.thread_ts, "1700000100.000001");
    await assert.rejects(egress.send({ ...intent, idempotency_key: undefined }), /Stable idempotency/);
    await assert.rejects(egress.send({ ...intent, content: [{ role: "attachment", media_type: "image/png", external_locator: "not-supported" }] }), /plain text/);
    await assert.rejects(slackUserDriver.resolveThreadStream(installation, { source: "slack", target: "user:TLOCAL:USELF:DONE" }, host, env), /not selected/);
    await host.dispose();
    assert.equal(registry.listStreams("user-1").length, 0);
    const privateState = await readFile(join(directory, "state.json"), "utf8");
    assert.equal(privateState.includes(auth.token), false);
  });
  it("rejects browser Origin, wrong methods, unsafe socket files and second service ownership", async (t) => {
    const { store, directory, cleanup } = await temporary(t);
    const { api } = historyTransport();
    const service = await serveSession(store, new UserSession(api, store), { interval_ms: 3600000 });
    cleanup(() => service.close());
    await assert.rejects(serveSession(store, new UserSession(api, store)), /already_owned/);
    const response = await new Promise((resolve, reject) => {
      const req = request({
        socketPath: join(directory, "bridge.sock"), method: "POST", path: "/rpc",
        headers: { Host: "localhost", Origin: "https://example.invalid", "Content-Type": "application/json" },
      }, async (res) => { let value = ""; for await (const chunk of res) value += chunk; resolve({ status: res.statusCode, value }); });
      req.on("error", reject);
      req.end('{"method":"status"}');
    });
    assert.equal(response.status, 403);
    assert.match(response.value, /request_rejected/);
    await chmod(join(directory, "bridge.sock"), 0o666);
    await assert.rejects(new UserBridgeClient({ REGENIC_SLACK_USER_DIR: directory }).status(), /unsafe_local_path/);
    await chmod(join(directory, "bridge.sock"), 0o600);
    await service.close();
    await writeFile(join(directory, "bridge.sock"), "", { mode: 0o600 });
    await assert.rejects(serveSession(store, new UserSession(api, store)), /existing_socket/);
    assert.equal((await stat(join(directory, "bridge.sock"))).isFile(), true);
  });
  it("paginates discovery, accepts enterprise user IDs and mounts multiple independent selected streams", async (t) => {
    const { store, directory, cleanup } = await temporary(t);
    const { api, calls } = transport((method, args) => {
      if (method === "auth.test") return { ...fixture.identity, user_id: "WSELF" };
      if (method === "users.conversations") return args.cursor ? {
        ok: true, channels: [fixture.directory.channels[1]],
      } : {
        ok: true, channels: [fixture.directory.channels[0]],
        response_metadata: { next_cursor: "directory-next" },
      };
      return fixture.empty;
    });
    const service = await serveSession(store, new UserSession(api, store), { interval_ms: 3600000 });
    cleanup(() => service.close());
    const env = { REGENIC_SLACK_USER_DIR: directory, REGENIC_SLACK_USER_BRIDGE: "1" };
    const options = await slackUserDriver.listCatalogFieldOptions({ env });
    assert.equal(options.conversation_ids.length, 2);
    assert(calls.some((call) => call.method === "users.conversations" && call.args.cursor === "directory-next"));
    const installation = slackUserDriver.install({
      id: "multi", org_id: "local", config: { risk_ack: USER_RISK_ACK, conversation_ids: options.conversation_ids.map((item) => item.value) },
      now: "2026-10-29T00:00:00.000Z",
    });

    const disabled = { ...installation, status: "disabled" };
    testUtils.verifyChannelDriverConformance({ driver: slackUserDriver, enabled: installation, disabled });
    const host = await createHost();
    cleanup(() => host.dispose());
    const registry = new testUtils.MemoryConnectorRegistry();
    await host.plugin(definePlugin({ name: "connectors", apply(ctx) { ctx.provide("connectors", registry); } }));
    assert.deepEqual(await slackUserDriver.resolveStreams(disabled, host, env), []);
    const [streams, again] = await Promise.all([
      slackUserDriver.resolveStreams(installation, host, env),
      slackUserDriver.resolveStreams(installation, host, env),
    ]);
    assert.equal(streams.length, 2);
    assert.equal(again.length, 2);
    assert.equal(registry.listStreams("multi").length, 2);
    assert.equal(new Set(streams.map((stream) => stream.thread_id)).size, 2);
    await host.dispose();
    assert.equal(registry.listStreams("multi").length, 0);
  });
});

describe("non-default user bridge risk consent", () => {
      it("keeps bot first and unchanged, defaults consent off, and does not probe or discover a user service without opt-in", async () => {
        const manifest = require("../package.json");
        assert.equal(manifest.regenic.contributes.drivers[0], "slackChannelDriver");
        const bot = slackChannelDriver.install({
          id: "bot-default", org_id: "local", config: { channel_id: "CONE" },
          now: "2026-10-29T00:00:00.000Z",
        });
        assert.equal(bot.connector_type, "slack-channel");
        assert.equal(bot.credentials_ref, "env:REGENIC_SLACK_TOKEN");
        assert.equal(bot.config.risk_ack, undefined);
        // Invalid path proves disabled catalog paths do not even try constructing a socket client.
        const env = { REGENIC_SLACK_USER_DIR: "not-an-absolute-path" };
        assert.equal((await slackUserDriver.probeCatalog({ env })).services.slack_user.ready, false);
        assert.deepEqual(await slackUserDriver.listCatalogFieldOptions({ env }), { conversation_ids: [] });
        const catalog = slackUserDriver.installCatalog();
        assert.equal(catalog.fields.find((field) => field.key === "risk_ack").default, "not-accepted");
        assert.deepEqual(catalog.install_confirm.when, { field: "risk_ack", value: USER_RISK_ACK });
        const config = { conversation_ids: "user:TLOCAL:USELF:CONE" };
        for (const risk_ack of [undefined, false, true, "not-accepted", "accept"]) {
          assert.throws(() => slackUserDriver.install({
            id: "no-consent", org_id: "local", config: { ...config, risk_ack }, now: "2026-10-29T00:00:00.000Z",
          }), /risk acknowledgement required/);
        }
        const legacy = { id: "legacy", org_id: "local", connector_type: "slack-user", status: "enabled", config, created_at: "2026-10-29T00:00:00.000Z" };
        assert.equal(slackUserDriver.capabilities(legacy).sync, false);
        assert.equal(slackUserDriver.matchesThread(legacy, { source: "slack", target: config.conversation_ids }), false);
        await assert.rejects(slackUserDriver.resolveStreams(legacy, {}, env), /risk acknowledgement required/);
        await assert.rejects(slackUserDriver.bindSyncSource(legacy, {}, env), /risk acknowledgement required/);
        const optedIn = { ...legacy, config: { ...config, risk_ack: USER_RISK_ACK } };
        await assert.rejects(slackUserDriver.resolveStreams(optedIn, {}, env), /explicit_opt_in_required/);
      });
      it("requires a separate web-cookie account-risk acknowledgement", () => {
        assert.throws(() => requireSessionRisk([], false), /user_session_risk_ack_required/);
        assert.doesNotThrow(() => requireSessionRisk(["--accept-user-session-risk"], false));
        assert.throws(() => requireSessionRisk(["--accept-user-session-risk"], true), /account_suspension_risk_ack_required/);
        assert.doesNotThrow(() => requireSessionRisk(["--accept-user-session-risk", "--accept-web-session-risk"], true));
      });
      it("rejects xoxc/cookie login and startup without the additional acknowledgement before any upstream call", async (t) => {
        const { store, directory } = await temporary(t);
        const auth = generatedAuth(true);
        await store.write("credentials.json", auth);
        for (const command of ["login", "start"]) {
          const result = spawnSync(process.execPath, [
            "dist/user-cli.js", command, ...(command === "login" ? ["--stdin"] : []),
            "--accept-user-session-risk",
          ], {
            cwd: join(__dirname, ".."), input: JSON.stringify(auth), encoding: "utf8",
            env: { ...process.env, REGENIC_SLACK_USER_BRIDGE: "1", REGENIC_SLACK_USER_DIR: directory },
          });
          assert.equal(result.status, 1);
          assert.match(result.stderr, /web_session_account_suspension_risk_ack_required/);
          assert.equal(result.stderr.includes(auth.token), false);
          assert.equal(result.stderr.includes(auth.cookie), false);
          await assert.rejects(stat(join(directory, "account.json")), { code: "ENOENT" });
          await assert.rejects(stat(join(directory, "bridge.sock")), { code: "ENOENT" });
          await assert.rejects(stat(join(directory, "owner.lock")), { code: "ENOENT" });
        }
      });
      it("rejects unconfirmed CLI login/start before creating files, consuming credentials or contacting Slack", async (t) => {
        const { directory } = await temporary(t);
        const absent = join(directory, "not-created");
        for (const [command, enabled] of [["start", ""], ["login", ""], ["start", "1"], ["login", "1"]]) {
          const result = spawnSync(process.execPath, ["dist/user-cli.js", command, ...(command === "login" ? ["--stdin"] : [])], {
            cwd: join(__dirname, ".."), input: "", encoding: "utf8",
            env: { ...process.env, REGENIC_SLACK_USER_BRIDGE: enabled, REGENIC_SLACK_USER_DIR: absent },
          });
          assert.equal(result.status, 1);
          assert.match(result.stderr, enabled ? /user_session_risk_ack_required/ : /explicit_opt_in_required/);
          await assert.rejects(stat(absent), { code: "ENOENT" });
        }
      });
});
