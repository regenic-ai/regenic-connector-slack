import { credentials, BridgeError, safeError, SlackUserApi } from "./user-api";
import { bridgeDirectory, PrivateStore } from "./user-store";
import { UserSession } from "./user-session";
import { serveSession, UserBridgeClient } from "./user-rpc";
import { requireSessionRisk, requireUserBridgeOptIn } from "./user-risk";

async function main() {
  const args = process.argv.slice(2);
  const store = new PrivateStore(bridgeDirectory());
  if (args[0] === "login" || args[0] === "start") {
    requireUserBridgeOptIn(process.env);
    requireSessionRisk(args, false);
    const allowed = new Set(["--accept-user-session-risk", "--accept-web-session-risk", ...(args[0] === "login" ? ["--stdin"] : [])]);
    if (args.slice(1).some((arg) => !allowed.has(arg)) || (args[0] === "login" && !args.includes("--stdin"))) {
      throw new BridgeError("invalid_command");
    }
  }
  if (args[0] === "login") {
    if (process.stdin.isTTY) throw new BridgeError("login_requires_explicit_secure_stdin");
    const release = await store.lock();
    try {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk.toString();
        if (Buffer.byteLength(input) > 8192) throw new BridgeError("credentials_too_large");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(input) as unknown; }
      catch { throw new BridgeError("invalid_credentials_json"); }
      const auth = credentials(parsed);
      requireSessionRisk(args, auth.token.startsWith("xoxc-") || Boolean(auth.cookie));
      const identity = await new SlackUserApi(auth).identity();
      const previous = await store.read("account.json");
      if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) {
        throw new BridgeError("account_changed_use_new_directory");
      }
      await store.write("account.json", identity);
      await store.write("credentials.json", auth);
      console.log("User session validated and saved locally. Web-cookie mode remains unverified against a real account.");
    } finally { await release(); }
    return;
  }
  if (args[0] === "start") {
    const auth = credentials(await store.read("credentials.json"));
    requireSessionRisk(args, auth.token.startsWith("xoxc-") || Boolean(auth.cookie));
    const service = await serveSession(store, new UserSession(new SlackUserApi(auth), store), {
      onError: (error) => console.error(error.message),
    });
    console.log("Slack user polling service ready on private Unix socket.");
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void service.close().then(() => { process.exitCode = 0; }).catch(() => {
          console.error("Slack user bridge: shutdown_failed"); process.exitCode = 1;
        });
      });
    }
    return;
  }
  const client = new UserBridgeClient();
  if (args.join(" ") === "status") { console.log(JSON.stringify(await client.status(), null, 2)); return; }
  if (args.join(" ") === "list") {
    requireUserBridgeOptIn(process.env);
    let cursor: string | undefined;
    do {
      const page = await client.list(cursor);
      console.log(JSON.stringify(page.conversations, null, 2));
      cursor = page.next;
    } while (cursor);
    return;
  }
  if (args.length === 2 && (args[0] === "select" || args[0] === "unselect")) {
    if (args[0] === "select") requireUserBridgeOptIn(process.env);
    console.log(JSON.stringify(args[0] === "select" ? await client.select(args[1])
      : await client.call({ method: "unselect", channel: args[1] }), null, 2)); return;
  }
  console.log("Default/recommended: official Slack bot read-only mode. User bridge requires REGENIC_SLACK_USER_BRIDGE=1.");
  console.log("Usage: bridge login --stdin --accept-user-session-risk [--accept-web-session-risk] | start --accept-user-session-risk [--accept-web-session-risk] | status | list | select CHANNEL_ID | unselect CHANNEL_ID");
  process.exitCode = 1;
}
void main().catch((error) => { console.error(safeError(error).message); process.exitCode = 1; });
