import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { detectFilePaths } from "../../src/util/file-detect.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);

describe("detectFilePaths", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  it("extracts absolute file paths from text", () => {
    mockExistsSync.mockReturnValue(true);
    const result = detectFilePaths("Look at /tmp/output/report.txt for details");
    expect(result).toEqual(["/tmp/output/report.txt"]);
  });

  it("extracts multiple paths", () => {
    mockExistsSync.mockReturnValue(true);
    const text = "Files: /home/user/a.ts and /home/user/b.js are ready";
    const result = detectFilePaths(text);
    expect(result).toEqual(["/home/user/a.ts", "/home/user/b.js"]);
  });

  it("deduplicates repeated paths", () => {
    mockExistsSync.mockReturnValue(true);
    const text = "See /tmp/file.txt and also /tmp/file.txt again";
    const result = detectFilePaths(text);
    expect(result).toEqual(["/tmp/file.txt"]);
  });

  it("only returns paths that exist on disk", () => {
    mockExistsSync.mockImplementation((p) => p === "/exists/file.txt");
    const text = "/exists/file.txt and /missing/file.txt";
    const result = detectFilePaths(text);
    expect(result).toEqual(["/exists/file.txt"]);
  });

  it("returns empty array when no paths in text", () => {
    const result = detectFilePaths("no paths here");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty text", () => {
    const result = detectFilePaths("");
    expect(result).toEqual([]);
  });

  it("does not match relative paths", () => {
    mockExistsSync.mockReturnValue(true);
    const result = detectFilePaths("see ./relative/path.txt");
    expect(result).toEqual([]);
  });

  it("handles paths with dots in directory names", () => {
    mockExistsSync.mockReturnValue(true);
    const result = detectFilePaths("File at /home/user/.config/settings.json");
    expect(result).toEqual(["/home/user/.config/settings.json"]);
  });

  it("handles paths with hyphens and underscores", () => {
    mockExistsSync.mockReturnValue(true);
    const result = detectFilePaths("See /my-dir/my_file.txt");
    expect(result).toEqual(["/my-dir/my_file.txt"]);
  });

  it("extracts paths at start of lines", () => {
    mockExistsSync.mockReturnValue(true);
    const text = "/tmp/start.txt is the file";
    const result = detectFilePaths(text);
    expect(result).toEqual(["/tmp/start.txt"]);
  });

  it("requires a file extension", () => {
    mockExistsSync.mockReturnValue(true);
    // /tmp/noext has no extension, should not match the pattern
    const result = detectFilePaths("See /tmp/noext for details");
    expect(result).toEqual([]);
  });
});
