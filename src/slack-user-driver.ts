import { createHash } from "node:crypto";
import { definePlugin } from "@regenic/plugin-host";
import {
  CONNECTOR_PROTOCOL, INGEST_SCHEMA_VERSION, ChannelDriverError,
  channelRecord, defineLocaleTables, requireConnectorStream,
  type ChannelDriver, type ConnectorCursor, type ConnectorHost, type ConnectorInstallation,
  type ConversationThread, type PollResult,
} from "@regenic/connector-contract";
import { BridgeError, object, timestamp } from "./user-api";
import { UserBridgeClient } from "./user-rpc";
import { requireUserBridgeOptIn, USER_RISK_ACK } from "./user-risk";

const userLocales = defineLocaleTables({
  en: {
    title: "Slack user (opt-in, account risk)",
    channel: "Slack user",
    description: "Not recommended by default. User sessions can trigger platform restrictions or account suspension, especially private xoxc/cookie sessions. Prefer official read-only bot mode.",
    risk: "User-session risk acknowledgement",
    riskOff: "Not accepted (default; user bridge disabled)",
    riskAccept: "I accept user-session platform/account risks",
    riskWarning: "User-session automation may violate workspace/platform policies or lead to account restrictions/suspension. Official xoxp OAuth is permission-governed, not risk-free. Private xoxc/cookie sessions have additional unverified protocol and account risks. Prefer official bot read-only mode; no Slack browser-plugin path is provided here.",
    riskConfirm: "I understand and explicitly choose the non-default user bridge",
    hint: "Credentials stay in the local service, not in this form.",
    conversations: "Conversations to sync",
    service: "Local Slack user service",
    serviceHint: "Non-default: set REGENIC_SLACK_USER_BRIDGE=1 and explicitly accept user-session risk before starting the service.",
    setup: "Validate a user session, then start the local service",
    setupBody: "See the plugin README for secure stdin login. Bot tokens are rejected.",
  },
  zh: {
    title: "Slack 用户（需主动启用，有账号风险）",
    channel: "Slack 用户",
    description: "默认不推荐。用户会话自动化可能导致平台限制或封号，尤其是私有 xoxc/cookie 会话。优先使用官方 bot 只读模式。",
    risk: "用户会话风险确认",
    riskOff: "未确认（默认；用户桥禁用）",
    riskAccept: "我接受用户会话的平台及账号风险",
    riskWarning: "用户会话自动化可能违反工作区或平台政策，导致账号限制或封号。官方 xoxp OAuth 受权限及政策约束，并非零风险；私有 xoxc/cookie 另有未经验证的协议与账号风险。推荐官方 bot 只读模式；本插件未提供 Slack 浏览器插件路径。",
    riskConfirm: "我已理解并主动选择非默认用户桥",
    hint: "凭据仅保存在本机服务中，不填写到此表单。",
    conversations: "选择需要同步的会话",
    service: "本地 Slack 用户服务",
    serviceHint: "非默认模式：需设置 REGENIC_SLACK_USER_BRIDGE=1 并明确接受用户会话风险后才能启动服务。",
    setup: "验证用户会话，然后启动本机服务",
    setupBody: "安全 stdin 登录方法见插件 README。不接受 bot token。",
  },
});

function targets(config: Record<string, unknown>): string[] {
  const raw = config.conversation_ids;
  const ids = typeof raw === "string" ? raw.split(",").map((id) => id.trim()).filter(Boolean)
    : Array.isArray(raw) ? raw : [];
  if (!ids.length || ids.some((id) => typeof id !== "string" || !/^user:T[A-Z0-9]+:[UW][A-Z0-9]+:[CDG][A-Z0-9]+$/.test(id))) {
    throw new ChannelDriverError("invalid_config", "Select qualified Slack user conversations");
  }
  const unique = [...new Set(ids.map((id: unknown) => {
    if (typeof id !== "string") throw new ChannelDriverError("invalid_config", "Invalid conversation selection");
    return id;
  }))];
  if (new Set(unique.map((id) => id.split(":").slice(1, 3).join(":"))).size !== 1) {
    throw new ChannelDriverError("invalid_config", "One local user account per installation");
  }
  return unique;
}
function accountTarget(identity: { team: string; user: string }, channel: string) {
  return `user:${identity.team}:${identity.user}:${channel}`;
}
function assertEnabled(installation: ConnectorInstallation) {
  if (installation.status !== "enabled") throw new ChannelDriverError("invalid_config", "Slack user installation is disabled");
  requireRiskAck(installation.config);
}
function requireRiskAck(config: Record<string, unknown>) {
  if (config.risk_ack !== USER_RISK_ACK) {
    throw new ChannelDriverError("invalid_config", "Explicit user-session platform/account risk acknowledgement required");
  }
}
async function assertAccount(client: UserBridgeClient, target: string) {
  const status = await client.status();
  if (!object(status) || !object(status.identity) ||
      accountTarget({ team: String(status.identity.team), user: String(status.identity.user) }, target.split(":")[3]) !== target) {
    throw new ChannelDriverError("invalid_config", "Slack user service account does not match installation");
  }
}
function selected(installation: ConnectorInstallation, thread: ConversationThread) {
  assertEnabled(installation);
  if (thread.source !== "slack" || !targets(installation.config).includes(thread.target)) {
    throw new ChannelDriverError("unsupported_channel", "Conversation is not selected for this Slack user installation");
  }
}

export class SlackUserConnector {
  readonly source = "slack";
  constructor(
    private readonly client: UserBridgeClient,
    private readonly installation: Pick<ConnectorInstallation, "id" | "org_id">,
    private readonly target: string,
  ) {}
  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const channel = this.target.split(":")[3];
    const page = await this.client.poll(channel, cursor?.value);
    if (accountTarget(page.identity, channel) !== this.target) throw new BridgeError("account_changed");
    const records = page.messages.map((message) => {
      if (!timestamp(message.ts)) throw new BridgeError("invalid_local_message");
      const reply = message.thread_ts && message.thread_ts !== message.ts;
      return channelRecord({
        channel: "slack", kind: message.bot_id ? "assistant" : "user",
        direction: message.user === page.identity.user ? "outbound" : "inbound",
        external_id: `${this.target}:${message.ts}`,
        occurred_at: new Date(Number(message.ts) * 1000).toISOString(),
        actor_id: message.user ?? `bot:${message.bot_id}`, scope_id: this.target,
        scope_name: page.conversation.label, conversation_kind: page.conversation.kind,
        type: reply ? "thread_reply" : "message",
        parent_external_id: reply ? `${this.target}:${message.thread_ts}` : undefined,
        text: message.text,
      });
    });
    const delivery = createHash("sha256").update(JSON.stringify([this.target, cursor?.value, page.next, records])).digest("hex");
    return {
      batch: {
        schema_version: INGEST_SCHEMA_VERSION, connector_id: this.installation.id,
        org_id: this.installation.org_id, delivery_id: `slack-user:${delivery}`,
        received_at: new Date().toISOString(), next_cursor: page.next, records,
      },
      next_cursor: page.next, has_more: page.has_more,
      poll_hint: { live_seeded: page.live_seeded, history_pending: page.history_pending },
    };
  }
}
const userStreamPlugin = definePlugin<{
  installation: ConnectorInstallation; target: string; client: UserBridgeClient; label: string;
}>({
  name: "slack-user-stream", inject: ["connectors"],
  apply(ctx, config) {
    ctx.effect(() => ctx.get("connectors").register(config.installation.id,
      new SlackUserConnector(config.client, config.installation, config.target), {
        stream_key: config.target, thread_id: `slack:${config.target}`, label: config.label,
      }));
  },
});
const mounting = new WeakMap<ConnectorHost, Map<string, Promise<void>>>();
async function mount(installation: ConnectorInstallation, target: string, host: ConnectorHost, env: NodeJS.ProcessEnv) {
  assertEnabled(installation);
  requireUserBridgeOptIn(env);
  let pending = mounting.get(host);
  if (!pending) { pending = new Map(); mounting.set(host, pending); }
  const key = `${installation.id}\0${target}`;
  let work = pending.get(key);
  if (!work) {
    work = (async () => {
      const client = new UserBridgeClient(env);
      await assertAccount(client, target);
      if (!host.get("connectors").getStream(installation.id, target)) {
        const conversation = await client.select(target.split(":")[3]);
        await host.plugin(userStreamPlugin, { installation, target, client, label: conversation.label });
      }
    })();
    pending.set(key, work);
  }
  try { await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
  return requireConnectorStream(host.get("connectors"), installation.id, target);
}

export const slackUserDriver: ChannelDriver = {
  connector_type: "slack-user", source: "slack", connector_protocol: CONNECTOR_PROTOCOL,
  install(input) {
    requireRiskAck(input.config);
    const ids = targets(input.config);
    return {
      id: input.id, org_id: input.org_id, connector_type: "slack-user", status: "enabled",
      config: { conversation_ids: ids.join(","), risk_ack: USER_RISK_ACK }, created_at: input.now,
    };
  },
  matchesThread(installation, thread) {
    return installation.status === "enabled" && installation.config.risk_ack === USER_RISK_ACK &&
      thread.source === "slack" && targets(installation.config).includes(thread.target);
  },
  ownsThread(installation, thread) { return this.matchesThread(installation, thread); },
  capabilities(installation) {
    const enabled = installation.status === "enabled" && installation.config.risk_ack === USER_RISK_ACK;
    return { sync: enabled, reply: enabled,
      create: false, list_title: "conversation", hydrate_on_open: true };
  },
  async resolveStreams(installation, host, env) {
    if (installation.status !== "enabled") return [];
    const streams = [];
    for (const target of targets(installation.config)) streams.push(await mount(installation, target, host, env));
    return streams;
  },
  async resolveThreadStream(installation, thread, host, env) {
    selected(installation, thread);
    return mount(installation, thread.target, host, env);
  },
  async bindSyncSource(installation, _host, env) {
    assertEnabled(installation);
    requireUserBridgeOptIn(env);
    return {
      async listDirectory() {
        const client = new UserBridgeClient(env);
        const members = [];
        for (const target of targets(installation.config)) {
          await assertAccount(client, target);
          const conversation = await client.select(target.split(":")[3]);
          members.push({ stream_key: target, thread_id: `slack:${target}`, label: conversation.label, kind: conversation.kind });
        }
        return { members, complete: true, replaces: true };
      },
    };
  },
  async bindEgress(installation, thread, _host, env) {
    selected(installation, thread);
    requireUserBridgeOptIn(env);
    const client = new UserBridgeClient(env);
    await assertAccount(client, thread.target);
    await client.select(thread.target.split(":")[3]);
    return {
      source: "slack",
      capabilities: () => ({ reply: true, edit: false, tombstone: false }),
      async send(intent) {
        if (intent.installation_id !== installation.id || !intent.idempotency_key) {
          throw new ChannelDriverError("invalid_config", "Stable idempotency_key and matching installation_id required");
        }
        const content = intent.content.filter((part) => part.role !== "metadata");
        if (!content.length || content.some((part) => part.role !== "body" || part.media_type !== "text/plain" || !("text" in part))) {
          throw new ChannelDriverError("unsupported_channel", "Slack user v1 sends plain text only");
        }
        const text = content.map((part) => "text" in part ? part.text : "").join("\n");
        let root: string | undefined;
        if (intent.target?.scope_id && intent.target.scope_id !== thread.target) {
          throw new ChannelDriverError("unsupported_channel", "Slack send scope mismatch");
        }
        if (intent.target?.external_id) {
          const prefix = `${thread.target}:`;
          const id = intent.target.external_id;
          const suffix = id.slice(prefix.length);
          const parent = suffix.startsWith("out:") ? suffix.slice(4) : suffix;
          if (!id.startsWith(prefix) || !timestamp(parent)) {
            throw new ChannelDriverError("unsupported_channel", "Invalid Slack reply target");
          }
          root = parent;
        }
        await assertAccount(client, thread.target);
        const receipt = await client.send(thread.target.split(":")[3], text, intent.idempotency_key, root);
        return { accepted: true, rpc_id: receipt.ts, channel_message_ids: [`${thread.target}:${receipt.ts}`] };
      },
    };
  },
  outboundId(thread, receipt) { return `${thread.target}:out:${receipt.rpc_id}`; },
  locales: () => userLocales,
  installCatalog() {
    return {
      title: "title", channel_label: "channel", description: "description", credential_hint: "hint",
      fields: [
        { key: "risk_ack", label: "risk", required: true, default: "not-accepted", options: [
          { value: "not-accepted", label: "riskOff" }, { value: USER_RISK_ACK, label: "riskAccept" },
        ] },
        { key: "conversation_ids", label: "conversations", required: true, multiple: true },
      ],
      install_confirm: { when: { field: "risk_ack", value: USER_RISK_ACK }, warning: "riskWarning", ack: "riskConfirm" },
      prerequisites: [{ kind: "local_service", key: "slack_user", label: "service", required: true, hint: "serviceHint" }],
      setup_steps: [{ title: "setup", body: "setupBody", command: "pnpm bridge start --accept-user-session-risk" }],
    };
  },
  async probeCatalog({ env }) {
    if (env.REGENIC_SLACK_USER_BRIDGE !== "1") {
      return { services: { slack_user: { ready: false, hint: "riskWarning" } } };
    }
    await new UserBridgeClient(env).status();
    return { services: { slack_user: { ready: true } } };
  },
  async listCatalogFieldOptions({ env }) {
    if (env.REGENIC_SLACK_USER_BRIDGE !== "1") return { conversation_ids: [] };
    const client = new UserBridgeClient(env);
    const status = await client.status();
    if (!object(status) || !object(status.identity) || typeof status.identity.team !== "string" || typeof status.identity.user !== "string") {
      throw new BridgeError("invalid_local_identity");
    }
    const identity = { team: status.identity.team, user: status.identity.user };
    const options = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.list(cursor);
      for (const entry of page.conversations) options.push({
        value: accountTarget(identity, entry.id), label: { literal: entry.label }, kind: entry.kind,
      });
      cursor = page.next;
      if (cursor && seen.has(cursor)) throw new BridgeError("repeated_upstream_cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { conversation_ids: options };
  },
  presentInstall(installation) {
    return { label: { literal: "Slack user" }, detail: { literal: targets(installation.config).join(", ") } };
  },
};
