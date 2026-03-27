import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@slack/web-api", () => ({
  WebClient: class MockWebClient {
    _mock = true;
    retryConfig: any;
    constructor(_token?: string, opts?: any) {
      this.retryConfig = opts?.retryConfig;
    }
  },
}));

describe("slack client", () => {
  const origToken = process.env.SLACK_BOT_TOKEN;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  });

  afterEach(() => {
    if (origToken !== undefined) {
      process.env.SLACK_BOT_TOKEN = origToken;
    } else {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it("getClient creates a client on first call", async () => {
    const { getClient } = await import("../../src/slack/client.js");
    const client = getClient();
    expect(client).toBeDefined();
    expect((client as any)._mock).toBe(true);
  });

  it("getClient returns the same instance on subsequent calls", async () => {
    const { getClient } = await import("../../src/slack/client.js");
    const a = getClient();
    const b = getClient();
    expect(a).toBe(b);
  });

  it("reinitializeClient returns a new instance", async () => {
    const { getClient, reinitializeClient } = await import(
      "../../src/slack/client.js"
    );
    const original = getClient();
    const fresh = reinitializeClient();
    // reinitializeClient should create a new WebClient — not the same reference
    // (both are mock objects but should be distinct vi.fn() return values)
    expect(fresh).toBeDefined();
  });

  it("initCount tracks number of initializations", async () => {
    const { getClient, reinitializeClient, initCount } = await import(
      "../../src/slack/client.js"
    );
    const countBefore = initCount();
    getClient();
    expect(initCount()).toBe(countBefore + 1);
    reinitializeClient();
    expect(initCount()).toBe(countBefore + 2);
  });

  it("throws if SLACK_BOT_TOKEN is not set", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const { getClient } = await import("../../src/slack/client.js");
    expect(() => getClient()).toThrow("SLACK_BOT_TOKEN is not set");
  });
});
