import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { lstat, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError, channelId, object, safeError, timestamp, type Conversation, type UserMessage } from "./user-api";
import { bridgeDirectory, checkPrivate, PrivateStore } from "./user-store";
import { UserSession, type JournalPage } from "./user-session";

const BODY_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > limit) throw new BridgeError("body_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new BridgeError("invalid_json"); }
}

export async function serveSession(
  store: PrivateStore,
  session: UserSession,
  options: { interval_ms?: number; onError?: (error: BridgeError) => void } = {},
): Promise<{ close(): Promise<void> }> {
  const interval = options.interval_ms ?? 15000;
  if (!Number.isSafeInteger(interval) || interval < 1000) throw new BridgeError("invalid_interval");
  const release = await store.lock();
  const socket = join(store.directory, "bridge.sock");
  let server: Server | undefined;
  let ownsSocket = false;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  try {
    try { await lstat(socket); throw new BridgeError("existing_socket_manual_recovery_required"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await session.initialize();
    server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      try {
        if (stopping || req.method !== "POST" || req.url !== "/rpc" ||
            req.headers.origin !== undefined || req.headers.host !== "localhost" ||
            req.headers["content-type"] !== "application/json") {
          throw new BridgeError("request_rejected");
        }
        const input = await body(req, BODY_LIMIT);
        const result = await session.exclusive(() => dispatch(session, input));
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        const safe = safeError(error);
        res.statusCode = safe.code === "request_rejected" ? 403 : 400;
        res.end(JSON.stringify({ ok: false, error: { code: safe.code, retry_after_ms: safe.retry_after_ms } }));
      }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxRequestsPerSocket = 10;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socket, () => { server!.removeListener("error", reject); resolve(); });
    });
    ownsSocket = true;
    await chmod(socket, 0o600);
    await checkPrivate(socket, "socket");
    const cycle = async () => {
      if (stopping) return;
      try { await session.exclusive(() => session.tick()); }
      catch (error) { options.onError?.(safeError(error)); }
      if (!stopping) timer = setTimeout(() => { void cycle(); }, interval);
    };
    timer = setTimeout(() => { void cycle(); }, 0);
    return {
      async close() {
        if (stopping) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        await session.exclusive(async () => undefined).catch((error) => {
          if (!(error instanceof BridgeError) || error.code !== "storage_failed_restart_required") throw error;
        });
        await removeSocket(socket);
        await release();
      },
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (ownsSocket) await removeSocket(socket);
    await release();
    throw error;
  }
}
async function removeSocket(socket: string) {
  try { await checkPrivate(socket, "socket"); await unlink(socket); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function dispatch(session: UserSession, input: unknown): Promise<unknown> {
  if (!object(input) || typeof input.method !== "string") throw new BridgeError("invalid_request");
  switch (input.method) {
    case "status": return session.status();
    case "directory":
      if (input.cursor !== undefined && typeof input.cursor !== "string") throw new BridgeError("invalid_cursor");
      return session.directory(input.cursor as string | undefined);
    case "select":
      if (!channelId(input.channel)) throw new BridgeError("invalid_channel");
      return session.select({ id: input.channel, label: input.channel, kind: "channel" });
    case "unselect":
      if (!channelId(input.channel)) throw new BridgeError("invalid_channel");
      return session.unselect(input.channel);
    case "poll":
      if (!channelId(input.channel) || (input.cursor !== undefined && typeof input.cursor !== "string")) {
        throw new BridgeError("invalid_request");
      }
      return session.poll(input.channel, input.cursor as string | undefined);
    case "send":
      if (!channelId(input.channel) || typeof input.text !== "string" || typeof input.key !== "string" ||
          (input.root !== undefined && typeof input.root !== "string")) throw new BridgeError("invalid_request");
      return session.send(input.channel, input.text, input.key, input.root as string | undefined);
    default: throw new BridgeError("unknown_method");
  }
}

export class UserBridgeClient {
  readonly directory: string;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.directory = bridgeDirectory(env); }
  async call(input: Record<string, unknown>): Promise<unknown> {
    const socket = join(this.directory, "bridge.sock");
    try {
      await checkPrivate(this.directory, "directory");
      await checkPrivate(socket, "socket");
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("local_service_unavailable");
    }
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: socket, path: "/rpc", method: "POST",
        headers: { Host: "localhost", "Content-Type": "application/json" },
      }, (res) => {
        void body(res, RESPONSE_LIMIT).then((value) => {
          if (!object(value)) throw new BridgeError("invalid_local_response");
          if (value.ok !== true) {
            if (!object(value.error) || typeof value.error.code !== "string") throw new BridgeError("invalid_local_response");
            throw new BridgeError(value.error.code, typeof value.error.retry_after_ms === "number" ? value.error.retry_after_ms : undefined);
          }
          resolve(value.result);
        }).catch(reject);
      });
      req.setTimeout(30000, () => req.destroy(new BridgeError("local_service_timeout")));
      req.on("error", (error) => reject(error instanceof BridgeError ? error : new BridgeError("local_service_unavailable")));
      const encoded = JSON.stringify(input);
      if (Buffer.byteLength(encoded) > BODY_LIMIT) { req.destroy(); reject(new BridgeError("body_too_large")); return; }
      req.end(encoded);
    });
  }
  async status() { return this.call({ method: "status" }); }
  async list(cursor?: string): Promise<{ conversations: Conversation[]; next?: string }> {
    const value = await this.call({ method: "directory", cursor });
    if (!object(value) || !Array.isArray(value.conversations) ||
        (value.next !== undefined && typeof value.next !== "string")) throw new BridgeError("invalid_local_response");
    return { conversations: value.conversations.map(parseConversation), next: value.next as string | undefined };
  }
  async select(channel: string) { return parseConversation(await this.call({ method: "select", channel })); }
  async poll(channel: string, cursor?: string): Promise<JournalPage> {
    const value = await this.call({ method: "poll", channel, cursor });
    if (!object(value) || !object(value.identity) || typeof value.identity.team !== "string" ||
        typeof value.identity.user !== "string" || typeof value.epoch !== "string" || typeof value.next !== "string" ||
        typeof value.has_more !== "boolean" || typeof value.history_pending !== "boolean" ||
        typeof value.live_seeded !== "boolean" || !Array.isArray(value.messages)) {
      throw new BridgeError("invalid_local_response");
    }
    // Both endpoints are same-user local processes. Reject corrupt/unversioned shapes rather than inventing empty pages.
    parseConversation(value.conversation);
    const messages = value.messages.map((message): UserMessage => {
      if (!object(message) || !timestamp(message.ts) || typeof message.text !== "string" ||
          (typeof message.user !== "string" && typeof message.bot_id !== "string") ||
          (message.thread_ts !== undefined && !timestamp(message.thread_ts)) ||
          (message.client_msg_id !== undefined && typeof message.client_msg_id !== "string")) {
        throw new BridgeError("invalid_local_response");
      }
      return {
        ts: message.ts, text: message.text,
        user: typeof message.user === "string" ? message.user : undefined,
        bot_id: typeof message.bot_id === "string" ? message.bot_id : undefined,
        thread_ts: typeof message.thread_ts === "string" ? message.thread_ts : undefined,
        client_msg_id: typeof message.client_msg_id === "string" ? message.client_msg_id : undefined,
      };
    });
    return {
      epoch: value.epoch, identity: { team: value.identity.team, user: value.identity.user },
      conversation: parseConversation(value.conversation), messages, next: value.next,
      has_more: value.has_more, history_pending: value.history_pending, live_seeded: value.live_seeded,
    };
  }
  async send(channel: string, text: string, key: string, root?: string): Promise<{ ts: string }> {
    const value = await this.call({ method: "send", channel, text, key, root });
    if (!object(value) || !timestamp(value.ts)) throw new BridgeError("invalid_local_response");
    return { ts: value.ts };
  }
}
function parseConversation(value: unknown): Conversation {
  if (!object(value) || !channelId(value.id) || typeof value.label !== "string" ||
      (value.kind !== "channel" && value.kind !== "direct")) throw new BridgeError("invalid_local_response");
  return { id: value.id, label: value.label, kind: value.kind };
}
