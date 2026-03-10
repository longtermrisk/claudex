import { WebClient } from "@slack/web-api";

/**
 * Managed Slack WebClient singleton with transparent reinitialization.
 *
 * The Bolt framework provides a `client` on every event, but if that instance
 * enters a bad state (e.g. after a WebSocket reconnect cycle, token rotation,
 * or internal SDK error) every tool call using it will fail.  This module
 * keeps a single WebClient that can be cheaply re-created from the bot token
 * whenever a non-transient Slack API error is detected.
 */

let _client: WebClient | null = null;
let _initCount = 0;

/** Create a fresh WebClient from the environment token. */
function makeClient(): WebClient {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  _initCount++;
  console.log(`[slack-client] Initializing WebClient (count: ${_initCount})`);
  return new WebClient(token, {
    // The built-in retry handles 429s automatically, but we add our own
    // layer on top for broader error coverage.
    retryConfig: { retries: 2 },
  });
}

/** Return the current WebClient, creating one if needed. */
export function getClient(): WebClient {
  if (!_client) _client = makeClient();
  return _client;
}

/**
 * Discard the current client and create a fresh one.
 * Call this when a Slack API error suggests the client is in a bad state
 * (e.g. `not_authed`, `invalid_auth`, `token_revoked`, `account_inactive`).
 */
export function reinitializeClient(): WebClient {
  console.warn("[slack-client] Reinitializing WebClient due to suspected bad state");
  _client = null;
  return getClient();
}

/** How many times the client has been (re)initialized — useful for tests/logs. */
export function initCount(): number {
  return _initCount;
}
