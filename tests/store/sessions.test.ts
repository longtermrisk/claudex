import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "../../src/store/types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);

// Dynamic import so each describe block can get fresh module state
async function freshModule() {
  vi.resetModules();
  return import("../../src/store/sessions.js");
}

describe("sessions store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ---------------------------------------------------------------- */
  /*  loadSessions                                                    */
  /* ---------------------------------------------------------------- */
  describe("loadSessions", () => {
    it("populates sessions from a valid file", async () => {
      const records: SessionRecord[] = [
        {
          channelId: "C1",
          threadTs: "100.0",
          sessionId: "s1",
          cwd: "/tmp",
          lastResponseTs: "101.0",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        },
      ];
      mockReadFileSync.mockReturnValue(JSON.stringify(records));
      const mod = await freshModule();
      mod.loadSessions();
      expect(mod.getSession("C1", "100.0")).toEqual(
        expect.objectContaining({ sessionId: "s1" }),
      );
    });

    it("handles missing file gracefully (start fresh)", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await freshModule();
      // Should not throw
      expect(() => mod.loadSessions()).not.toThrow();
    });

    it("handles corrupt JSON gracefully", async () => {
      mockReadFileSync.mockReturnValue("not valid json {{{");
      const mod = await freshModule();
      expect(() => mod.loadSessions()).not.toThrow();
    });

    it("loads multiple records", async () => {
      const records: SessionRecord[] = [
        {
          channelId: "C1",
          threadTs: "1.0",
          sessionId: "s1",
          cwd: "/a",
          lastResponseTs: "2.0",
          createdAt: "",
          updatedAt: "",
        },
        {
          channelId: "C2",
          threadTs: "3.0",
          sessionId: "s2",
          cwd: "/b",
          lastResponseTs: "4.0",
          createdAt: "",
          updatedAt: "",
        },
      ];
      mockReadFileSync.mockReturnValue(JSON.stringify(records));
      const mod = await freshModule();
      mod.loadSessions();
      expect(mod.getSession("C1", "1.0")).toBeDefined();
      expect(mod.getSession("C2", "3.0")).toBeDefined();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  getSession                                                      */
  /* ---------------------------------------------------------------- */
  describe("getSession", () => {
    it("returns undefined for non-existent session", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await freshModule();
      expect(mod.getSession("C999", "999.0")).toBeUndefined();
    });

    it("uses channelId:threadTs as compound key", async () => {
      const records: SessionRecord[] = [
        {
          channelId: "C1",
          threadTs: "10.0",
          sessionId: "s-target",
          cwd: "/",
          lastResponseTs: "11.0",
          createdAt: "",
          updatedAt: "",
        },
      ];
      mockReadFileSync.mockReturnValue(JSON.stringify(records));
      const mod = await freshModule();
      mod.loadSessions();

      // Same channel, different thread → not found
      expect(mod.getSession("C1", "99.0")).toBeUndefined();
      // Different channel, same thread → not found
      expect(mod.getSession("C99", "10.0")).toBeUndefined();
      // Exact match → found
      expect(mod.getSession("C1", "10.0")).toBeDefined();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  saveSession                                                     */
  /* ---------------------------------------------------------------- */
  describe("saveSession", () => {
    it("persists the session and makes it retrievable", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await freshModule();

      const record: SessionRecord = {
        channelId: "C_SAVE",
        threadTs: "500.0",
        sessionId: "s-new",
        cwd: "/workspace",
        lastResponseTs: "501.0",
        createdAt: "2025-06-01T00:00:00Z",
        updatedAt: "",
      };

      mod.saveSession(record);

      // Should be retrievable
      const saved = mod.getSession("C_SAVE", "500.0");
      expect(saved).toEqual(expect.objectContaining({ sessionId: "s-new" }));
    });

    it("updates the updatedAt timestamp", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await freshModule();

      const before = new Date().toISOString();
      mod.saveSession({
        channelId: "C_TS",
        threadTs: "600.0",
        sessionId: "s-ts",
        cwd: "/",
        lastResponseTs: "601.0",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "old-value",
      });

      const saved = mod.getSession("C_TS", "600.0");
      expect(saved!.updatedAt).not.toBe("old-value");
      expect(new Date(saved!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime(),
      );
    });

    it("writes atomically (tmp file + rename)", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await freshModule();

      mod.saveSession({
        channelId: "C_ATOMIC",
        threadTs: "700.0",
        sessionId: "s-at",
        cwd: "/",
        lastResponseTs: "701.0",
        createdAt: "",
        updatedAt: "",
      });

      // writeFileSync should write to a .tmp file
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writePath = mockWriteFileSync.mock.calls[0][0] as string;
      expect(writePath).toMatch(/\.sessions\.json\.tmp$/);

      // renameSync should move .tmp to final path
      expect(mockRenameSync).toHaveBeenCalledTimes(1);
      const [from, to] = mockRenameSync.mock.calls[0] as [string, string];
      expect(from).toMatch(/\.tmp$/);
      expect(to).toMatch(/\.sessions\.json$/);
      expect(to).not.toMatch(/\.tmp$/);
    });

    it("persists all sessions as JSON array", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await freshModule();

      mod.saveSession({
        channelId: "C_A",
        threadTs: "1.0",
        sessionId: "sa",
        cwd: "/a",
        lastResponseTs: "2.0",
        createdAt: "",
        updatedAt: "",
      });
      mod.saveSession({
        channelId: "C_B",
        threadTs: "3.0",
        sessionId: "sb",
        cwd: "/b",
        lastResponseTs: "4.0",
        createdAt: "",
        updatedAt: "",
      });

      // The last writeFileSync call should contain both records
      const lastWriteCall =
        mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      const written = JSON.parse(lastWriteCall![1] as string) as any[];
      expect(written.length).toBe(2);
      expect(written.map((r: any) => r.sessionId).sort()).toEqual([
        "sa",
        "sb",
      ]);
    });
  });
});
