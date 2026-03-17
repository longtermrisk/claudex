import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getLatestLogFile, readLastNLines } from "./log-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claudex-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath: string, content = "", mtimeMs?: number): void {
  writeFileSync(filePath, content, "utf-8");
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    utimesSync(filePath, t, t);
  }
}

// ---------------------------------------------------------------------------
// getLatestLogFile
// ---------------------------------------------------------------------------

describe("getLatestLogFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // getLatestLogFile reads from join(process.cwd(), "logs"),
    // so we make process.cwd() return our temp dir and create a logs/ sub-dir.
    mkdirSync(join(tmpDir, "logs"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the logs directory is empty", () => {
    expect(getLatestLogFile()).toBeNull();
  });

  it("returns null when the logs directory does not exist", () => {
    rmSync(join(tmpDir, "logs"), { recursive: true });
    expect(getLatestLogFile()).toBeNull();
  });

  it("ignores files that do not match service_*.log pattern", () => {
    touch(join(tmpDir, "logs", "other.log"));
    touch(join(tmpDir, "logs", "service_notes.txt"));
    expect(getLatestLogFile()).toBeNull();
  });

  it("returns the single log file when only one exists", () => {
    const logPath = join(tmpDir, "logs", "service_20260101_120000.log");
    touch(logPath, "hello");
    expect(getLatestLogFile()).toBe(logPath);
  });

  it("returns the most recently modified log file", () => {
    const logsDir = join(tmpDir, "logs");
    const older = join(logsDir, "service_20260101_120000.log");
    const newer = join(logsDir, "service_20260102_120000.log");

    // Write older file first with an explicitly older mtime
    touch(older, "old content", Date.now() - 10_000);
    touch(newer, "new content", Date.now());

    expect(getLatestLogFile()).toBe(newer);
  });

  it("handles three log files and picks the newest", () => {
    const logsDir = join(tmpDir, "logs");
    const now = Date.now();
    touch(join(logsDir, "service_A.log"), "A", now - 20_000);
    touch(join(logsDir, "service_B.log"), "B", now - 10_000);
    const newest = join(logsDir, "service_C.log");
    touch(newest, "C", now);

    expect(getLatestLogFile()).toBe(newest);
  });
});

// ---------------------------------------------------------------------------
// readLastNLines
// ---------------------------------------------------------------------------

describe("readLastNLines", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an error string when the file does not exist", () => {
    const result = readLastNLines(join(tmpDir, "nonexistent.log"), 10);
    expect(result).toMatch(/Failed to read log file/);
  });

  it("returns the full file content when it has fewer lines than requested", () => {
    const file = join(tmpDir, "test.log");
    writeFileSync(file, "line1\nline2\nline3", "utf-8");
    expect(readLastNLines(file, 10)).toBe("line1\nline2\nline3");
  });

  it("returns exactly the last N lines", () => {
    const file = join(tmpDir, "test.log");
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    writeFileSync(file, lines.join("\n"), "utf-8");

    const result = readLastNLines(file, 5);
    expect(result).toBe("line16\nline17\nline18\nline19\nline20");
  });

  it("returns empty string for an empty file", () => {
    const file = join(tmpDir, "empty.log");
    writeFileSync(file, "", "utf-8");
    expect(readLastNLines(file, 10)).toBe("");
  });

  it("handles n=1 correctly", () => {
    const file = join(tmpDir, "test.log");
    writeFileSync(file, "first\nsecond\nthird", "utf-8");
    expect(readLastNLines(file, 1)).toBe("third");
  });

  it("handles n=0 correctly (returns empty string)", () => {
    const file = join(tmpDir, "test.log");
    writeFileSync(file, "first\nsecond", "utf-8");
    // slice(lines.length - 0) = slice(lines.length) = empty array
    expect(readLastNLines(file, 0)).toBe("");
  });

  it("preserves trailing newline behaviour", () => {
    // A file ending with \n will have an empty string as the last split element.
    const file = join(tmpDir, "test.log");
    writeFileSync(file, "line1\nline2\n", "utf-8");
    const result = readLastNLines(file, 2);
    // last 2 of ["line1", "line2", ""] → "line2\n" joined
    expect(result).toBe("line2\n");
  });
});
