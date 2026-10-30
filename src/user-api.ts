import { LogLevel, WebClient, type WebClientOptions } from "@slack/web-api";

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    readonly retry_after_ms?: number,
  ) {
    super(`Slack user bridge: ${code}`);
    this.name = "BridgeError";
  }
}

export function safeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const value = error as { code?: string; data?: { error?: string }; retryAfter?: number };
  if (value?.code === "slack_webapi_rate_limited_error") {
    return new BridgeError("rate_limited", Math.max(1000, (value.retryAfter ?? 60) * 1000));
  }
  // Never forward upstream error messages, response bodies, headers, or URLs.
  const known = new Set([
    "invalid_auth", "account_inactive", "token_revoked", "not_authed",
    "missing_scope", "not_allowed_token_type", "channel_not_found",
    "not_in_channel", "is_archived", "restricted_action", "invalid_cursor",
    "ratelimited", "msg_too_long", "thread_not_found", "message_not_found", "cannot_reply_to_message",
  ]);
  if (value?.data?.error && known.has(value.data.error)) {
    return new BridgeError(value.data.error, value.data.error === "ratelimited" ? 60000 : undefined);
  }
  return new BridgeError("upstream_unavailable");
}

export interface UserCredentials {
  token: string;
  cookie?: string;
}

export function credentials(value: unknown): UserCredentials {
  if (!object(value) || typeof value.token !== "string" ||
      !/^xox[pc]-[A-Za-z0-9-]+$/.test(value.token)) {
    throw new BridgeError("user_token_required");
  }
  let cookie: string | undefined;
  if (value.cookie !== undefined) {
    if (typeof value.cookie !== "string") throw new BridgeError("invalid_cookie");
    try { cookie = decodeURIComponent(value.cookie); }
    catch { throw new BridgeError("invalid_cookie"); }
    if (!/^xoxd-[A-Za-z0-9+/=_-]+$/.test(cookie)) throw new BridgeError("invalid_cookie");
  }
  if (value.token.startsWith("xoxc-") && !cookie) {
    throw new BridgeError("web_cookie_required");
  }
  return { token: value.token, cookie };
}

export interface UserMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  client_msg_id?: string;
}
export interface Conversation {
  id: string;
  label: string;
  kind: "channel" | "direct";
}
export interface MessagePage {
  messages: UserMessage[];
  next?: string;
  roots: string[];
  newest?: string;
}
export interface UserApi {
  identity(): Promise<{ team: string; user: string }>;
  directory(cursor?: string): Promise<{ conversations: Conversation[]; next?: string }>;
  history(channel: string, cursor?: string, oldest?: string): Promise<MessagePage>;
  replies(channel: string, root: string, cursor?: string, oldest?: string): Promise<MessagePage>;
  send(channel: string, text: string, transaction: string, root?: string): Promise<string>;
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{10,12}\.\d{6}$/.test(value);
}
export function channelId(value: unknown): value is string {
  return typeof value === "string" && /^[CDG][A-Z0-9]+$/.test(value);
}
export function messagePage(value: unknown): MessagePage {
  if (!object(value) || !Array.isArray(value.messages) ||
      (value.has_more !== undefined && typeof value.has_more !== "boolean")) throw new BridgeError("invalid_upstream_page");
  const messages: UserMessage[] = [];
  const roots: string[] = [];
  let newest: string | undefined;
  for (const raw of value.messages) {
    if (!object(raw) || !timestamp(raw.ts)) throw new BridgeError("invalid_upstream_message");
    if (!newest || raw.ts > newest) newest = raw.ts;
    // Edits, deletions, reactions and non-text messages are outside this version.
    if (raw.subtype && !["thread_broadcast", "bot_message", "file_share"].includes(String(raw.subtype))) continue;
    if (!raw.thread_ts || raw.thread_ts === raw.ts) roots.push(raw.ts);
    if (raw.text === "" || raw.text === undefined) continue;
    if (typeof raw.text !== "string" ||
        (typeof raw.user !== "string" && typeof raw.bot_id !== "string") ||
        (raw.thread_ts !== undefined && !timestamp(raw.thread_ts))) {
      throw new BridgeError("invalid_upstream_message");
    }
    messages.push({
      ts: raw.ts, text: raw.text,
      user: typeof raw.user === "string" ? raw.user : undefined,
      bot_id: typeof raw.bot_id === "string" ? raw.bot_id : undefined,
      thread_ts: typeof raw.thread_ts === "string" ? raw.thread_ts : undefined,
      client_msg_id: typeof raw.client_msg_id === "string" ? raw.client_msg_id : undefined,
    });
  }
  const next = nextCursor(value.response_metadata);
  if (value.has_more === true && !next) throw new BridgeError("missing_upstream_cursor");
  return { messages, next, roots, newest };
}
function nextCursor(metadata: unknown): string | undefined {
  if (metadata === undefined) return undefined;
  if (!object(metadata) || (metadata.next_cursor !== undefined && typeof metadata.next_cursor !== "string")) {
    throw new BridgeError("invalid_upstream_cursor");
  }
  return typeof metadata.next_cursor === "string" ? metadata.next_cursor || undefined : undefined;
}

/** Transport injection is for offline protocol fixtures, never exposed by the CLI/config. */
export class SlackUserApi implements UserApi {
  private readonly client: WebClient;
  constructor(auth: UserCredentials, transport?: Pick<WebClientOptions, "fetch">) {
    const validated = credentials(auth);
    this.client = new WebClient(validated.token, {
      ...transport,
      headers: validated.cookie ? { Cookie: `d=${encodeURIComponent(validated.cookie)}` } : {},
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 15000,
      maxRequestConcurrency: 1,
      allowAbsoluteUrls: false,
      // SDK debug and warning payloads may contain credentials. Only safeError exits this boundary.
      logger: {
        debug() {}, info() {}, warn() {}, error() {},
        setLevel() {}, getLevel: () => LogLevel.ERROR,
        setName() {},
      },
    });
  }
  private async call(method: string, args: Record<string, unknown> = {}) {
    try {
      const result: unknown = await this.client.apiCall(method, args);
      if (!object(result)) throw new BridgeError("invalid_upstream_response");
      return result;
    } catch (error) {
      throw safeError(error);
    }
  }
  async identity() {
    const result = await this.call("auth.test");
    if (typeof result.team_id !== "string" || !/^T[A-Z0-9]+$/.test(result.team_id) ||
        typeof result.user_id !== "string" || !/^[UW][A-Z0-9]+$/.test(result.user_id) ||
        result.bot_id || result.is_bot === true || result.user === "bot") {
      throw new BridgeError("user_identity_required");
    }
    return { team: result.team_id, user: result.user_id };
  }
  async directory(cursor?: string) {
    const result = await this.call("users.conversations", {
      types: "public_channel,private_channel,im,mpim", exclude_archived: true, limit: 100, cursor,
    });
    if (!Array.isArray(result.channels)) throw new BridgeError("invalid_upstream_directory");
    const conversations = result.channels.map((raw: unknown): Conversation => {
      if (!object(raw) || !channelId(raw.id)) throw new BridgeError("invalid_upstream_directory");
      return {
        id: raw.id,
        label: typeof raw.name === "string" ? raw.name : typeof raw.user === "string" ? raw.user : raw.id,
        kind: raw.is_im === true || raw.is_mpim === true ? "direct" : "channel",
      };
    });
    return { conversations, next: nextCursor(result.response_metadata) };
  }
  async history(channel: string, cursor?: string, oldest?: string) {
    return messagePage(await this.call("conversations.history", { channel, cursor, oldest, limit: 100 }));
  }
  async replies(channel: string, root: string, cursor?: string, oldest?: string) {
    return messagePage(await this.call("conversations.replies", { channel, ts: root, cursor, oldest, limit: 100 }));
  }
  async send(channel: string, text: string, transaction: string, root?: string) {
    const result = await this.call("chat.postMessage", {
      channel, text, client_msg_id: transaction, thread_ts: root,
      unfurl_links: false, unfurl_media: false,
    });
    if (!timestamp(result.ts)) throw new BridgeError("invalid_upstream_receipt");
    return result.ts;
  }
}
