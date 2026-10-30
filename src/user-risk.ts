import { BridgeError } from "./user-api";

export const USER_RISK_ACK = "accept-user-session-risk-v1";

export function requireUserBridgeOptIn(env: NodeJS.ProcessEnv) {
  if (env.REGENIC_SLACK_USER_BRIDGE !== "1") {
    throw new BridgeError("user_bridge_disabled_explicit_opt_in_required");
  }
}

export function requireSessionRisk(args: readonly string[], web: boolean) {
  if (!args.includes("--accept-user-session-risk")) {
    throw new BridgeError("user_session_risk_ack_required");
  }
  if (web && !args.includes("--accept-web-session-risk")) {
    throw new BridgeError("web_session_account_suspension_risk_ack_required");
  }
}
