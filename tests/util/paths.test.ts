import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock/home"),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockCopyFileSync = vi.mocked(copyFileSync);

// Must import AFTER mocks are set up
import { resolveCwd } from "../../src/util/paths.js";

describe("resolveCwd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ~/{workspace}/{channel} for normal channels", () => {
    mockExistsSync.mockReturnValue(true); // dir exists, CLAUDE.md exists
    const result = resolveCwd("myteam", "general");
    expect(result).toBe(join("/mock/home", "myteam", "general"));
  });

  it("creates directory if it does not exist", () => {
    mockExistsSync.mockReturnValueOnce(false); // dir does not exist
    mockExistsSync.mockReturnValueOnce(false); // CLAUDE.md dest doesn't exist
    mockExistsSync.mockReturnValueOnce(false); // CLAUDE.md source doesn't exist
    resolveCwd("team", "channel");
    expect(mockMkdirSync).toHaveBeenCalledWith(
      join("/mock/home", "team", "channel"),
      { recursive: true },
    );
  });

  it("copies CLAUDE.md if source exists but dest does not", () => {
    mockExistsSync
      .mockReturnValueOnce(true)   // dir exists
      .mockReturnValueOnce(false)  // CLAUDE.md dest doesn't exist
      .mockReturnValueOnce(true);  // CLAUDE.md source exists
    resolveCwd("team", "channel");
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      join("/mock/home", ".claude", "skills", "CLAUDE.md"),
      join("/mock/home", "team", "channel", "CLAUDE.md"),
    );
  });

  it("does not copy CLAUDE.md if it already exists at dest", () => {
    mockExistsSync.mockReturnValue(true); // everything exists
    resolveCwd("team", "channel");
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("returns home dir for claudex-dev channel", () => {
    const result = resolveCwd("anyteam", "claudex-dev");
    expect(result).toBe("/mock/home");
    // Should not create directories or copy files
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /*  sanitize behaviour (tested indirectly through resolveCwd)       */
  /* ---------------------------------------------------------------- */

  it("lowercases workspace and channel names", () => {
    mockExistsSync.mockReturnValue(true);
    const result = resolveCwd("MyTeam", "General");
    expect(result).toBe(join("/mock/home", "myteam", "general"));
  });

  it("replaces special characters with hyphens", () => {
    mockExistsSync.mockReturnValue(true);
    const result = resolveCwd("My Team!", "cool #channel");
    expect(result).toBe(join("/mock/home", "my-team", "cool-channel"));
  });

  it("collapses multiple hyphens", () => {
    mockExistsSync.mockReturnValue(true);
    const result = resolveCwd("a---b", "c---d");
    expect(result).toBe(join("/mock/home", "a-b", "c-d"));
  });

  it("strips leading and trailing hyphens", () => {
    mockExistsSync.mockReturnValue(true);
    const result = resolveCwd("-team-", "-chan-");
    expect(result).toBe(join("/mock/home", "team", "chan"));
  });

  it("truncates names to 64 characters", () => {
    mockExistsSync.mockReturnValue(true);
    const longName = "a".repeat(100);
    const result = resolveCwd(longName, "ch");
    const parts = result.split("/");
    const workspacePart = parts[parts.length - 2];
    expect(workspacePart!.length).toBeLessThanOrEqual(64);
  });

  it("preserves underscores and hyphens", () => {
    mockExistsSync.mockReturnValue(true);
    const result = resolveCwd("my_team", "my-channel");
    expect(result).toBe(join("/mock/home", "my_team", "my-channel"));
  });
});
