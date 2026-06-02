import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildProviderSmokeSuites,
  parseArgs,
  providerSkipReason,
  smokeProviderSuites
} from "../scripts/smoke-test.js";

type SmokeCase = {
  name: string;
  expectedFinalTextIncludes?: string;
};

describe("smoke provider selection", () => {
  it("parses smoke timeout options for clearer failure boundaries", () => {
    const config = parseArgs(["--timeout-ms", "1500"]);

    expect(config.timeoutMs).toBe(1500);
  });

  it("keeps provider auth status in each suite", () => {
    const suites = buildProviderSmokeSuites(
      [{ id: "codex", status: "misconfigured", authStatus: "missing", nativeSession: true }],
      { cwd: "C:\\repo", file: "README.md" }
    );

    expect(suites[0]).toMatchObject({
      provider: "codex",
      status: "misconfigured",
      authStatus: "missing",
      nativeSession: true
    });
  });

  it("adds session memory cases for providers with native session support", () => {
    const suites = buildProviderSmokeSuites(
      [
        { id: "codex", status: "available", authStatus: "configured", nativeSession: true },
        { id: "plain", status: "available", authStatus: "configured", nativeSession: false }
      ],
      { cwd: "C:\\repo", file: "README.md" }
    );

    expect(suites[0]?.cases.map((testCase: SmokeCase) => testCase.name)).toEqual([
      "text invoke",
      "local file reference",
      "session memory seed",
      "session memory recall"
    ]);
    expect(
      suites[0]?.cases.find((testCase: SmokeCase) => testCase.name === "session memory recall")
    ).toMatchObject({
      nativeSessionFrom: "session memory seed"
    });
    const recallCase = suites[0]?.cases.find(
      (testCase: SmokeCase) => testCase.name === "session memory recall"
    );
    expect(recallCase?.expectedFinalTextIncludes).toMatch(
      /^agent_bridge_smoke_codex_[a-f0-9]{32}$/
    );
    expect(suites[1]?.cases.map((testCase: SmokeCase) => testCase.name)).not.toContain(
      "session memory recall"
    );
  });

  it("skips providers that are unavailable or unauthenticated", () => {
    expect(
      providerSkipReason({
        provider: "codex",
        status: "misconfigured",
        authStatus: "missing"
      })
    ).toBe("codex skipped: status=misconfigured, authStatus=missing");
    expect(
      providerSkipReason({
        provider: "gemini",
        status: "available",
        authStatus: "configured"
      })
    ).toBeUndefined();
  });

  it("validates that the resumed session can recall the seeded token", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/invoke") {
        response.writeHead(404).end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += chunk;
      }
      const payload = JSON.parse(body);
      requests.push(payload);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          requestId: `req_${requests.length}`,
          provider: payload.provider,
          session: payload.session ?? "session_1",
          finalText: payload.session ? "token_alpha" : "stored"
        })
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an IPv4 server address");
    }

    try {
      const results = await smokeProviderSuites(`http://127.0.0.1:${address.port}`, [
        {
          provider: "codex",
          status: "available",
          authStatus: "configured",
          nativeSession: true,
          cases: [
            {
              name: "session memory seed",
              request: { provider: "codex", input: "Remember token_alpha." }
            },
            {
              name: "session memory recall",
              nativeSessionFrom: "session memory seed",
              expectedFinalTextIncludes: "token_alpha",
              request: { provider: "codex", input: "What was the token?" }
            }
          ]
        }
      ]);

      expect(requests).toEqual([
        { provider: "codex", input: "Remember token_alpha." },
        { provider: "codex", input: "What was the token?", session: "session_1" }
      ]);
      expect(results.map((result) => [result.caseName, result.status])).toEqual([
        ["session memory seed", "passed"],
        ["session memory recall", "passed"]
      ]);
    } finally {
      server.close();
    }
  });

  it("fails the session recall case when the resumed response does not include the seeded token", async () => {
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/invoke") {
        response.writeHead(404).end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += chunk;
      }
      const payload = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          requestId: "req",
          provider: payload.provider,
          session: payload.session ?? "session_1",
          finalText: "I do not know"
        })
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an IPv4 server address");
    }

    try {
      const results = await smokeProviderSuites(`http://127.0.0.1:${address.port}`, [
        {
          provider: "codex",
          status: "available",
          authStatus: "configured",
          nativeSession: true,
          cases: [
            {
              name: "session memory seed",
              request: { provider: "codex", input: "Remember token_alpha." }
            },
            {
              name: "session memory recall",
              nativeSessionFrom: "session memory seed",
              expectedFinalTextIncludes: "token_alpha",
              request: { provider: "codex", input: "What was the token?" }
            }
          ]
        }
      ]);

      expect(results[1]).toMatchObject({
        caseName: "session memory recall",
        status: "failed",
        error: {
          message: "Expected response finalText to include token_alpha"
        }
      });
    } finally {
      server.close();
    }
  });
});
