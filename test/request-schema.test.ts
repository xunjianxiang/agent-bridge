import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { providerRequestSchema } from "../src/core/request.schema.js";
import { resolveProjectCwd } from "../src/core/workspace.js";

describe("providerRequestSchema", () => {
  it("accepts session as the external resume field", () => {
    const result = providerRequestSchema.parse({
      provider: "codex",
      input: "continue",
      session: "thread_123"
    });

    expect(result.session).toBe("thread_123");
  });

  it("accepts options as the provider-specific escape hatch", () => {
    const result = providerRequestSchema.parse({
      provider: "codex",
      input: "ping",
      options: {
        threadOptions: {
          approvalPolicy: "never"
        }
      }
    });

    expect(result.options?.threadOptions).toEqual({ approvalPolicy: "never" });
  });

  it("rejects the old nativeOptions field", () => {
    const result = providerRequestSchema.safeParse({
      provider: "codex",
      input: "ping",
      nativeOptions: {
        threadOptions: {}
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects public absolute cwd requests", () => {
    const result = providerRequestSchema.safeParse({
      provider: "codex",
      input: "ping",
      cwd: "C:\\repo"
    });

    expect(result.success).toBe(false);
  });

  it("resolves project subdirectories under the configured workspace projects directory", () => {
    expect(resolveProjectCwd("packages/api", "/repo")).toBe(
      resolve("/repo", "projects", "packages/api")
    );
  });

  it("defaults workspace to the user agent-bridge directory", () => {
    expect(resolveProjectCwd("api")).toBe(
      resolve(homedir(), ".agent-bridge", "projects", "api")
    );
  });

  it("expands tilde in the configured workspace", () => {
    expect(resolveProjectCwd("api", "~/.agent-bridge")).toBe(
      resolve(homedir(), ".agent-bridge", "projects", "api")
    );
  });

  it("rejects project paths outside the configured workspace root", () => {
    expect(() => resolveProjectCwd("../outside", "/repo")).toThrow(
      "project must stay inside WORKSPACE/projects"
    );
  });

  it("rejects absolute project paths", () => {
    expect(() => resolveProjectCwd("/tmp/project", "/repo")).toThrow(
      "project must be a relative path"
    );
  });
});
