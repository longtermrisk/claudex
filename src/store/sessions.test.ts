/**
 * Session store tests.
 *
 * Covers the "won't crash on restart" requirement: loadSessions() must
 * handle missing files and corrupt JSON without throwing.  The save/get
 * round-trip verifies that session data survives a write + read cycle.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SessionRecord } from "./types.js";

// We reset modules between tests so that the module-level `sessions` Map
// and `STORE_PATH` constant start fresh each time.
// vi.doMock (non-hoisted) is used inside beforeEach after resetModules.

type SessionsModule = {
  loadSessions: () => void;
  getSession: (channelId: string, threadTs: string) => SessionRecord | undefined;
  saveSession: (record: SessionRecord) => void;
};

let mod: SessionsModule;
let mockReadFileSync: ReturnType<typeof vi.fn>;
let mockWriteFileSync: ReturnType<typeof vi.fn>;
let mockRenameSync: ReturnType<typeof vi.fn>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    threadTs: "1000.0",
    channelId: "C001",
    sessionId: "session-abc",
    cwd: "/workspace",
    lastResponseTs: "1001.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();

  mockReadFileSync = vi.fn();
  mockWriteFileSync = vi.fn();
  mockRenameSync = vi.fn();

  vi.doMock("node:fs", () => ({
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
  }));

  mod = await import("./sessions.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadSessions — crash-safety on restart
// ---------------------------------------------------------------------------

describe("loadSessions", () => {
  it("does not throw when the sessions file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    });
    expect(() => mod.loadSessions()).not.toThrow();
  });

  it("does not throw when the sessions file contains invalid JSON", () => {
    mockReadFileSync.mockReturnValue("{corrupt: json[");
    expect(() => mod.loadSessions()).not.toThrow();
  });

  it("does not throw when the sessions file is empty", () => {
    mockReadFileSync.mockReturnValue("");
    expect(() => mod.loadSessions()).not.toThrow();
  });

  it("does not throw when the sessions file contains null", () => {
    mockReadFileSync.mockReturnValue("null");
    expect(() => mod.loadSessions()).not.toThrow();
  });

  it("loads sessions into memory from a valid file", () => {
    const records: SessionRecord[] = [
      makeRecord({ channelId: "C100", threadTs: "2000.0", sessionId: "s1" }),
      makeRecord({ channelId: "C200", threadTs: "3000.0", sessionId: "s2" }),
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify(records));

    mod.loadSessions();

    expect(mod.getSession("C100", "2000.0")?.sessionId).toBe("s1");
    expect(mod.getSession("C200", "3000.0")?.sessionId).toBe("s2");
  });

  it("returns undefined for unknown sessions after load", () => {
    mockReadFileSync.mockReturnValue("[]");
    mod.loadSessions();
    expect(mod.getSession("UNKNOWN", "0.0")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveSession + getSession — round-trip
// ---------------------------------------------------------------------------

describe("saveSession / getSession", () => {
  it("stores a session and retrieves it by channelId + threadTs", () => {
    const rec = makeRecord({ channelId: "C300", threadTs: "9000.0" });
    mod.saveSession(rec);
    const loaded = mod.getSession("C300", "9000.0");
    expect(loaded).toBeDefined();
    expect(loaded?.sessionId).toBe(rec.sessionId);
    expect(loaded?.cwd).toBe(rec.cwd);
  });

  it("updates updatedAt when saving", () => {
    const before = new Date().toISOString();
    const rec = makeRecord({ channelId: "C400", threadTs: "9001.0", updatedAt: "1970-01-01T00:00:00.000Z" });
    mod.saveSession(rec);
    const saved = mod.getSession("C400", "9001.0")!;
    expect(saved.updatedAt >= before).toBe(true);
  });

  it("overwrites an existing session with the same key", () => {
    const key = { channelId: "C500", threadTs: "9002.0" };
    mod.saveSession(makeRecord({ ...key, sessionId: "original" }));
    mod.saveSession(makeRecord({ ...key, sessionId: "updated" }));
    expect(mod.getSession(key.channelId, key.threadTs)?.sessionId).toBe("updated");
  });

  it("persists to disk via writeFileSync + renameSync (atomic write)", () => {
    mod.saveSession(makeRecord());
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(mockRenameSync).toHaveBeenCalledOnce();
  });

  it("writes valid JSON that contains the saved record", () => {
    const rec = makeRecord({ channelId: "C600", threadTs: "9003.0", sessionId: "s-json" });
    mod.saveSession(rec);

    const [, written] = mockWriteFileSync.mock.calls[0] as [string, string];
    const parsed: SessionRecord[] = JSON.parse(written);
    const found = parsed.find((r) => r.channelId === "C600" && r.threadTs === "9003.0");
    expect(found?.sessionId).toBe("s-json");
  });

  it("returns undefined for a session that was never saved", () => {
    expect(mod.getSession("NEVER", "0.0")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Restart simulation
// ---------------------------------------------------------------------------

describe("restart simulation", () => {
  it("survives a save → reload cycle with the same data", async () => {
    // 1. Save a session
    const rec = makeRecord({ channelId: "C700", threadTs: "9004.0", sessionId: "persist-me" });
    mod.saveSession(rec);

    // 2. Capture what was written to disk
    const [, written] = mockWriteFileSync.mock.calls[0] as [string, string];

    // 3. Simulate a restart: reset modules and replay the file content
    vi.resetModules();
    const freshRead = vi.fn().mockReturnValue(written);
    vi.doMock("node:fs", () => ({
      readFileSync: freshRead,
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    }));

    const freshMod: SessionsModule = await import("./sessions.js");
    freshMod.loadSessions();

    const recovered = freshMod.getSession("C700", "9004.0");
    expect(recovered?.sessionId).toBe("persist-me");
  });
});
