import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import { handleMessage } from "./events.js";

/** Resolved at startup via auth.test */
let botUserId = "";

/**
 * Create and configure the Bolt app with Socket Mode.
 */
export function createApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.DEBUG,
  });

  // Resolve bot user ID for mention detection in channels
  app.client.auth.test().then((res) => {
    botUserId = res.user_id ?? "";
    console.log(`Bot user ID resolved: ${botUserId}`);
  });

  // Handle @mentions in channels (kept as fallback in case Slack fixes delivery)
  app.event("app_mention", async (args) => {
    console.log("[app_mention] Received event from", args.event.user, "in", args.event.channel);
    await handleMessage(args);
  });

  // Handle DMs and channel messages that mention the bot
  // (message.channels / message.groups subscriptions required)
  app.event("message", async (args) => {
    const { event } = args;
    console.log("[message] Received event:", JSON.stringify(event).slice(0, 300));
    if ("channel_type" in event && event.channel_type === "im") {
      console.log("[message] Processing DM from", "user" in event ? event.user : "unknown");
      await handleMessage(args);
    } else if (
      "channel_type" in event &&
      (event.channel_type === "channel" || event.channel_type === "group") &&
      "text" in event &&
      typeof event.text === "string" &&
      event.text.includes(`<@${botUserId}>`)
    ) {
      console.log("[message] Processing channel mention from", "user" in event ? event.user : "unknown", "in", event.channel);
      await handleMessage(args);
    }
  });

  // Catch unhandled errors
  app.error(async (error) => {
    console.error("[app.error]", error);
  });

  return app;
}
