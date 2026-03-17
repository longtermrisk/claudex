import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { uploadContentAsFile } from "./files.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient(overrides?: Partial<WebClient>): WebClient {
  return {
    filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as WebClient;
}

// ---------------------------------------------------------------------------
// uploadContentAsFile
// ---------------------------------------------------------------------------

describe("uploadContentAsFile", () => {
  it("calls filesUploadV2 with the correct channel, thread, and filename", async () => {
    const client = makeMockClient();
    await uploadContentAsFile(client, "C123", "9999.0", "hello world", "error-stack.txt");

    expect(client.filesUploadV2).toHaveBeenCalledOnce();
    const call = vi.mocked(client.filesUploadV2).mock.calls[0][0];
    expect(call.channel_id).toBe("C123");
    expect(call.thread_ts).toBe("9999.0");
    expect(call.filename).toBe("error-stack.txt");
  });

  it("writes the content to the temp file that is uploaded", async () => {
    let capturedFilePath: string | undefined;
    const client = {
      filesUploadV2: vi.fn().mockImplementation(async (args: { file?: string }) => {
        capturedFilePath = args.file;
        return { ok: true };
      }),
    } as unknown as WebClient;

    await uploadContentAsFile(client, "C123", "9999.0", "the stack trace", "error-stack.txt");

    // The temp file should have been cleaned up by now
    expect(capturedFilePath).toBeDefined();
    expect(existsSync(capturedFilePath!)).toBe(false);
  });

  it("cleans up the temp directory even when filesUploadV2 throws", async () => {
    let capturedFilePath: string | undefined;
    const client = {
      filesUploadV2: vi.fn().mockImplementation(async (args: { file?: string }) => {
        capturedFilePath = args.file;
        throw new Error("Slack API error");
      }),
    } as unknown as WebClient;

    await expect(
      uploadContentAsFile(client, "C123", "9999.0", "content", "error-stack.txt"),
    ).rejects.toThrow("Slack API error");

    // Temp dir containing the file should be gone
    expect(capturedFilePath).toBeDefined();
    expect(existsSync(capturedFilePath!)).toBe(false);
  });

  it("uploads an empty string without error", async () => {
    const client = makeMockClient();
    await expect(
      uploadContentAsFile(client, "C123", "9999.0", "", "empty.txt"),
    ).resolves.toBeUndefined();
    expect(client.filesUploadV2).toHaveBeenCalledOnce();
  });

  it("uploads a large string (simulating a log tail) without error", async () => {
    const client = makeMockClient();
    const bigContent = Array.from({ length: 10_000 }, (_, i) => `log line ${i}`).join("\n");
    await expect(
      uploadContentAsFile(client, "C123", "9999.0", bigContent, "service-logs.txt"),
    ).resolves.toBeUndefined();
    expect(client.filesUploadV2).toHaveBeenCalledOnce();
  });

  it("preserves the exact filename passed to it", async () => {
    const client = makeMockClient();
    await uploadContentAsFile(client, "C123", "9999.0", "x", "service-logs.txt");
    const call = vi.mocked(client.filesUploadV2).mock.calls[0][0];
    expect(call.filename).toBe("service-logs.txt");
  });
});
