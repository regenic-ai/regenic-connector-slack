import { createHash, randomUUID } from "node:crypto";
import { BridgeError, channelId, object, safeError, timestamp, type Conversation, type MessagePage, type UserApi, type UserMessage } from "./user-api";
import { PrivateStore } from "./user-store";

interface Lane {
  cursor?: string;
  oldest?: string;
  max?: string;
  seeded?: boolean;
}
interface Channel {
  epoch: string;
  conversation: Conversation;
  log: UserMessage[];
  seeded: boolean;
  history_done: boolean;
  history_cursor?: string;
  backfill_next: boolean;
  live: Lane;
  roots: Record<string, Lane>;
  root_index: number;
}
interface Transaction {
  fingerprint: string;
  transaction: string;
  channel: string;
  ts?: string;
  root?: string;
}
interface SessionState {
  version: 1;
  epoch: string;
  identity: { team: string; user: string };
  channels: Record<string, Channel>;
  transactions: Record<string, Transaction>;
  channel_index: number;
}
export interface JournalPage {
  epoch: string;
  identity: { team: string; user: string };
  conversation: Conversation;
  messages: UserMessage[];
  next: string;
  has_more: boolean;
  history_pending: boolean;
  live_seeded: boolean;
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function emptyRecord<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }

export class UserSession {
  private state!: SessionState;
  private queue: Promise<unknown> = Promise.resolve();
  private lastError?: BridgeError;
  private readonly syncErrors = new Map<string, BridgeError>();
  private retryAt = 0;
  private faulted = false;
  constructor(private readonly api: UserApi, private readonly store: PrivateStore) {}

  async initialize() {
    const identity = await this.api.identity();
    const saved = await this.store.read("state.json");
    if (saved !== undefined) {
      validateState(saved);
      if (saved.identity.team !== identity.team || saved.identity.user !== identity.user) {
        throw new BridgeError("account_changed_use_new_directory");
      }
      this.state = saved;
    } else {
      this.state = {
        version: 1, epoch: randomUUID(), identity,
        channels: emptyRecord(), transactions: emptyRecord(), channel_index: 0,
      };
      await this.persist();
    }
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.faulted) throw new BridgeError("storage_failed_restart_required");
      return work();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async directory(cursor?: string) {
    this.checkRetry();
    try { return await this.api.directory(cursor); }
    catch (error) { throw this.remember(error); }
  }
  status() {
    return {
      identity: this.state.identity,
      mode: "user-polling",
      selected: Object.values(this.state.channels).map((channel) => channel.conversation),
      error: this.lastError?.code,
      channel_errors: Object.fromEntries([...this.syncErrors].map(([id, error]) => [id, error.code])),
      retry_after_ms: Math.max(0, this.retryAt - Date.now()),
      storage_failed: this.faulted,
      pending_sends: Object.values(this.state.transactions).filter((entry) => !entry.ts).length,
    };
  }
  async select(conversation: Conversation) {
    if (!channelId(conversation.id)) throw new BridgeError("invalid_channel");
    if (!this.state.channels[conversation.id]) {
      // Validate membership through Slack's actual paginated user directory.
      let cursor: string | undefined;
      const visited = new Set<string>();
      let found: Conversation | undefined;
      do {
        const page = await this.directory(cursor);
        found = page.conversations.find((entry) => entry.id === conversation.id);
        cursor = page.next;
        if (found) break;
        if (cursor && visited.has(cursor)) throw new BridgeError("repeated_upstream_cursor");
        if (cursor) visited.add(cursor);
      } while (cursor);
      if (!found) throw new BridgeError("conversation_not_accessible");
      this.state.channels[found.id] = {
        epoch: randomUUID(), conversation: found, log: [], seeded: false, history_done: false, backfill_next: true,
        live: {}, roots: emptyRecord(), root_index: 0,
      };
      await this.persist();
    }
    return this.state.channels[conversation.id].conversation;
  }
  async unselect(id: string) {
    this.selected(id);
    delete this.state.channels[id];
    this.syncErrors.delete(id);
    await this.persist();
    return { removed: true };
  }
  async tick() {
    this.checkRetry();
    const channels = Object.values(this.state.channels);
    if (!channels.length) return;
    const index = this.state.channel_index % channels.length;
    let progressed = false;
    try {
      await this.sync(channels[index], () => { progressed = true; });
      this.state.channel_index = (index + 1) % channels.length;
      await this.persist();
      this.syncErrors.delete(channels[index].conversation.id);
      this.lastError = undefined;
    } catch (error) {
      this.syncErrors.set(channels[index].conversation.id, safeError(error));
      // Do not repeatedly give quota to the first channel while starving a denied one.
      if (!this.faulted && (progressed || !safeError(error).retry_after_ms)) {
        this.state.channel_index = (index + 1) % channels.length;
        await this.persist();
      }
      throw this.remember(error);
    }
  }
  private async sync(channel: Channel, progress: () => void) {
    const id = channel.conversation.id;
    if (!channel.seeded) {
      const page = await this.api.history(id);
      this.append(channel, page);
      channel.seeded = true;
      channel.history_cursor = page.next;
      channel.history_done = !page.next;
      channel.live.oldest = page.newest;
      await this.persist();
    } else if (!channel.history_done && channel.backfill_next) {
      const older = await this.page(() => this.api.history(id, channel.history_cursor), () => {
        channel.history_cursor = undefined;
      }, channel.history_cursor);
      this.append(channel, older);
      channel.history_cursor = older.next;
      channel.history_done = !older.next;
      channel.backfill_next = false;
      await this.persist();
    } else {
      const page = await this.page(() => this.api.history(id, channel.live.cursor, channel.live.oldest), () => {
        channel.live.cursor = undefined;
      }, channel.live.cursor);
      this.append(channel, page);
      this.advance(channel.live, page);
      channel.backfill_next = true;
      await this.persist();
    }
    progress();
    // Visit every discovered root, even roots that had no replies when discovered.
    // This covers late replies to old roots once backfill reaches those roots.
    const roots = Object.keys(channel.roots).sort();
    if (roots.length) {
      const root = roots[channel.root_index % roots.length];
      const lane = channel.roots[root];
      let page: MessagePage;
      try {
        page = await this.page(() => this.api.replies(id, root, lane.cursor, lane.oldest), () => {
          lane.cursor = undefined;
        }, lane.cursor);
      } catch (error) {
        if (["thread_not_found", "message_not_found"].includes(safeError(error).code)) {
          delete channel.roots[root];
          await this.persist();
        }
        throw error;
      }
      this.append(channel, page, false);
      this.advance(lane, page);
      if (!page.next) channel.root_index = (channel.root_index + 1) % roots.length;
      await this.persist();
    }
  }
  private async page(fetch: () => Promise<MessagePage>, reset: () => void, cursor?: string): Promise<MessagePage> {
    try {
      const page = await fetch();
      if (page.next && page.next === cursor) {
        reset();
        await this.persist();
        throw new BridgeError("repeated_upstream_cursor_reset_retry");
      }
      return page;
    }
    catch (error) {
      if (safeError(error).code === "invalid_cursor") {
        reset();
        await this.persist();
        throw new BridgeError("upstream_cursor_reset_retry");
      }
      throw error;
    }
  }
  private advance(lane: Lane, page: MessagePage) {
    if (page.newest && (!lane.max || page.newest > lane.max)) lane.max = page.newest;
    lane.cursor = page.next;
    if (!page.next) {
      lane.oldest = lane.max ?? lane.oldest;
      lane.max = undefined;
      lane.seeded = true;
    }
  }
  private append(channel: Channel, page: MessagePage, discover = true) {
    const seen = new Set(channel.log.map((message) => message.ts));
    for (const message of page.messages) {
      if (!seen.has(message.ts)) { channel.log.push(message); seen.add(message.ts); }
      if (message.client_msg_id && message.user === this.state.identity.user) {
        for (const operation of Object.values(this.state.transactions)) {
          if (operation.transaction === message.client_msg_id && operation.channel === channel.conversation.id) {
            operation.ts = message.ts;
          }
        }
      }
    }
    if (discover) for (const root of page.roots) channel.roots[root] ??= {};
  }
  poll(id: string, cursor?: string): JournalPage {
    const channel = this.selected(id);
    let offset = 0;
    const prefix = `${this.state.epoch}/${channel.epoch}/${id}/`;
    if (cursor !== undefined) {
      if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length))) throw new BridgeError("invalid_local_cursor");
      offset = Number(cursor.slice(prefix.length));
      if (!Number.isSafeInteger(offset) || offset > channel.log.length) throw new BridgeError("invalid_local_cursor");
    }
    const messages = channel.log.slice(offset, offset + 100);
    const syncError = this.syncErrors.get(id);
    if (!messages.length && syncError) throw syncError;
    const nextOffset = offset + messages.length;
    return {
      epoch: this.state.epoch, identity: this.state.identity, conversation: channel.conversation,
      messages, next: `${prefix}${nextOffset}`, has_more: nextOffset < channel.log.length,
      history_pending: !channel.history_done ||
        Object.values(channel.roots).some((lane) => !lane.seeded || Boolean(lane.cursor)),
      live_seeded: channel.seeded,
    };
  }
  async send(id: string, text: string, key: string, root?: string) {
    const channel = this.selected(id);
    if (!key || key.length > 512 || !text.trim() || text.length > 40000 || (root && !timestamp(root))) {
      throw new BridgeError("invalid_send");
    }
    if (root) {
      const parent = channel.log.find((message) => message.ts === root);
      const sent = Object.values(this.state.transactions).find((entry) => entry.channel === id && entry.ts === root);
      root = parent?.thread_ts ?? sent?.root ?? root;
    }
    const fingerprint = hash(JSON.stringify([id, text, root ?? null]));
    const operationKey = hash(key);
    const existing = this.state.transactions[operationKey];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new BridgeError("idempotency_conflict");
      if (!existing.ts) throw new BridgeError("send_outcome_unknown_wait_for_reconciliation");
      return { ts: existing.ts };
    }
    this.checkRetry();
    const digest = hash(`${this.state.identity.team}/${this.state.identity.user}/${key}`);
    const transaction = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const operation: Transaction = { fingerprint, transaction, channel: id, root };
    this.state.transactions[operationKey] = operation;
    // Reserve BEFORE the upstream side effect. A crash/timeout is ambiguous, never blindly retried.
    await this.persist();
    try {
      operation.ts = await this.api.send(id, text, transaction, root);
      await this.persist();
      return { ts: operation.ts };
    } catch (error) {
      const safe = safeError(error);
      const definitelyRejected = new Set([
        "rate_limited", "ratelimited", "invalid_auth", "account_inactive", "token_revoked",
        "not_authed", "missing_scope", "not_allowed_token_type", "channel_not_found",
        "not_in_channel", "is_archived", "restricted_action", "msg_too_long",
        "thread_not_found", "message_not_found", "cannot_reply_to_message",
      ]);
      if (definitelyRejected.has(safe.code)) {
        delete this.state.transactions[operationKey];
        await this.persist();
      }
      throw this.remember(safe.code === "upstream_unavailable"
        ? new BridgeError("send_outcome_unknown_wait_for_reconciliation") : safe);
    }
  }
  private selected(id: string) {
    if (!channelId(id) || !this.state.channels[id]) throw new BridgeError("conversation_not_selected");
    return this.state.channels[id];
  }
  private async persist() {
    try { await this.store.write("state.json", this.state); }
    catch { this.faulted = true; throw new BridgeError("storage_failed_restart_required"); }
  }
  private checkRetry() {
    if (this.retryAt > Date.now()) throw new BridgeError(this.lastError?.code ?? "retry_later", this.retryAt - Date.now());
  }
  private remember(error: unknown) {
    const safe = safeError(error);
    this.lastError = safe;
    this.retryAt = Date.now() + (safe.retry_after_ms ?? (safe.code === "upstream_unavailable" ? 15000 : 0));
    return safe;
  }
}

function validateState(value: unknown): asserts value is SessionState {
  const invalid = () => { throw new BridgeError("corrupt_local_store"); };
  if (!object(value) || value.version !== 1 || typeof value.epoch !== "string" ||
      !object(value.identity) || typeof value.identity.team !== "string" || typeof value.identity.user !== "string" ||
      !object(value.channels) || !object(value.transactions) ||
      !Number.isSafeInteger(value.channel_index) || Number(value.channel_index) < 0) return invalid();
  const lane = (entry: unknown) => object(entry) &&
    (entry.cursor === undefined || typeof entry.cursor === "string") &&
    [entry.oldest, entry.max].every((v) => v === undefined || timestamp(v)) &&
    (entry.seeded === undefined || typeof entry.seeded === "boolean");
  for (const [id, channel] of Object.entries(value.channels)) {
    if (!channelId(id) || !object(channel) || typeof channel.epoch !== "string" ||
        !object(channel.conversation) || channel.conversation.id !== id ||
        typeof channel.conversation.label !== "string" || !["channel", "direct"].includes(String(channel.conversation.kind)) ||
        !Array.isArray(channel.log) || typeof channel.seeded !== "boolean" || typeof channel.history_done !== "boolean" ||
        typeof channel.backfill_next !== "boolean" ||
        (channel.history_cursor !== undefined && typeof channel.history_cursor !== "string") ||
        !lane(channel.live) || !object(channel.roots) || !Number.isSafeInteger(channel.root_index) || Number(channel.root_index) < 0) return invalid();
    for (const message of channel.log) {
      if (!object(message) || !timestamp(message.ts) || typeof message.text !== "string" ||
          (typeof message.user !== "string" && typeof message.bot_id !== "string") ||
          (message.thread_ts !== undefined && !timestamp(message.thread_ts))) return invalid();
    }
    for (const [root, entry] of Object.entries(channel.roots)) if (!timestamp(root) || !lane(entry)) return invalid();
  }
  for (const [key, operation] of Object.entries(value.transactions)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(operation) || typeof operation.fingerprint !== "string" ||
        typeof operation.transaction !== "string" || !channelId(operation.channel) ||
        (operation.ts !== undefined && !timestamp(operation.ts)) ||
        (operation.root !== undefined && !timestamp(operation.root))) return invalid();
  }
}
