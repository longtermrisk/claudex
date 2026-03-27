import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
} from "node:fs";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ _mock: "write-stream" })),
  writeFileSync: vi.fn(),
}));

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn(async () => {}),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  downloadSlackFile,
  uploadFileToSlack,
  uploadContentAsFile,
} from "../../src/slack/files.js";

describe("downloadSlackFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads a file to /tmp/{uuid}/{filename}", async () => {
    // Provide a real ReadableStream so Readable.fromWeb() doesn't throw
    mockFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({ start(c) { c.close(); } }),
    });

    const path = await downloadSlackFile(
      "https://files.slack.com/a.txt",
      "report.txt",
      "xoxb-token",
    );

    expect(path).toBe("/tmp/test-uuid-1234/report.txt");
    expect(mkdirSync).toHaveBeenCalledWith("/tmp/test-uuid-1234", {
      recursive: true,
    });
  });

  it("sends Authorization header with the token", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({ start(c) { c.close(); } }),
    });

    await downloadSlackFile("https://files.slack.com/x", "x.txt", "my-token");
    expect(mockFetch).toHaveBeenCalledWith("https://files.slack.com/x", {
      headers: { Authorization: "Bearer my-token" },
    });
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      body: null,
    });

    await expect(
      downloadSlackFile("https://files.slack.com/x", "x.txt", "token"),
    ).rejects.toThrow("Failed to download file: 403 Forbidden");
  });

  it("throws when response body is null", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: null,
    });

    await expect(
      downloadSlackFile("https://files.slack.com/x", "x.txt", "token"),
    ).rejects.toThrow("Failed to download file");
  });
});

describe("uploadFileToSlack", () => {
  it("calls filesUploadV2 with correct params", async () => {
    const mockClient: any = {
      filesUploadV2: vi.fn(async () => ({})),
    };

    await uploadFileToSlack(
      mockClient,
      "C123",
      "1234.5678",
      "/tmp/report.pdf",
      "report.pdf",
    );

    expect(mockClient.filesUploadV2).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1234.5678",
      file: "/tmp/report.pdf",
      filename: "report.pdf",
    });
  });
});

describe("uploadContentAsFile", () => {
  it("writes content to temp file and uploads it", async () => {
    const mockClient: any = {
      filesUploadV2: vi.fn(async () => ({})),
    };

    await uploadContentAsFile(
      mockClient,
      "C123",
      "1234.5678",
      "file content here",
      "summary.txt",
    );

    // Should create temp directory
    expect(mkdirSync).toHaveBeenCalled();

    // Should write content to file
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test-uuid-1234/summary.txt",
      "file content here",
    );

    // Should upload
    expect(mockClient.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "summary.txt",
      }),
    );
  });
});
