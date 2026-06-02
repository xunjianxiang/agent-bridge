#!/usr/bin/env node
// @ts-nocheck
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "8787";
const DEFAULT_REPORT_PATH = "reports/smoke-report.json";
const DEFAULT_HTML_REPORT_PATH = "reports/smoke-report.html";
const DEFAULT_TIMEOUT_MS = 10000;

export function providerIdsFrom(providers) {
  return providers.map((provider) => provider.id);
}

export function buildProviderTextRequest(provider, cwd) {
  return {
    provider,
    cwd,
    input: "Reply with exactly: pong"
  };
}

export function buildProviderSessionMemorySeedRequest(provider, cwd, token) {
  return {
    provider,
    cwd,
    input: `Remember this exact token for the next turn: ${token}. Reply with exactly: stored`
  };
}

export function buildProviderSessionMemoryRecallRequest(provider, cwd, session) {
  const request = {
    provider,
    cwd,
    input: "What exact token did I ask you to remember in the previous turn? Reply with only the token."
  };
  if (session) {
    request.session = session;
  }
  return request;
}

export function buildCodexTextRequest(cwd) {
  return buildProviderTextRequest("codex", cwd);
}

export function buildCodexFileReferenceRequest(cwd, filePath = "README.md") {
  return {
    provider: "codex",
    cwd,
    input: `Read ${filePath} and summarize this project in one sentence.`
  };
}

export function buildCodexImageRequest(imagePath) {
  return {
    provider: "codex",
    input: [
      { type: "text", text: "Describe this image." },
      { type: "local_image", path: imagePath }
    ]
  };
}

export function buildProviderSmokeSuites(providers, config) {
  return providers.map((provider) => {
    const providerId = provider.id;
    const cases = [
      {
        name: "text invoke",
        request: buildProviderTextRequest(providerId, config.cwd)
      },
      ...providerSpecificCases(providerId, config)
    ];
    if (provider.nativeSession) {
      const token = createSessionProbeToken(providerId);
      cases.push({
        name: "session memory seed",
        request: buildProviderSessionMemorySeedRequest(providerId, config.cwd, token)
      });
      cases.push({
        name: "session memory recall",
        nativeSessionFrom: "session memory seed",
        expectedFinalTextIncludes: token,
        request: buildProviderSessionMemoryRecallRequest(providerId, config.cwd)
      });
    }

    return {
      provider: providerId,
      status: provider.status,
      authStatus: provider.authStatus,
      nativeSession: provider.nativeSession,
      cases
    };
  });
}

function createSessionProbeToken(providerId) {
  return `agent_bridge_smoke_${providerId}_${randomUUID().replaceAll("-", "")}`;
}

export function providerSkipReason(suite) {
  if (suite.status !== "available" || suite.authStatus !== "configured") {
    return `${suite.provider} skipped: status=${suite.status ?? "unknown"}, authStatus=${suite.authStatus ?? "unknown"}`;
  }

  return undefined;
}

export function createSmokeReport({
  baseUrl,
  liveAgent,
  providers,
  suites,
  startedAt,
  finishedAt,
  results
}) {
  const resultByCase = new Map(
    results.map((result) => [`${result.provider}:${result.caseName}`, result])
  );

  const tests = suites.flatMap((suite) => {
    const providerInfo = providers.find((provider) => provider.id === suite.provider);
    return suite.cases.map((testCase) => {
      const result = resultByCase.get(`${suite.provider}:${testCase.name}`);
      if (!result) {
        return {
          name: `${suite.provider} ${testCase.name}`,
          status: "skipped",
          duration: 0,
          suite: ["agent-bridge smoke", suite.provider],
          parameters: {
            request: testCase.request
          },
          extra: {
            provider: suite.provider,
            providerInfo,
            caseName: testCase.name
          }
        };
      }

      return {
        name: `${suite.provider} ${testCase.name}`,
        status: result.status,
        duration: result.durationMs,
        suite: ["agent-bridge smoke", suite.provider],
        message: result.error?.message,
        trace: result.error?.message,
        parameters: {
          request: result.request
        },
        extra: {
          provider: suite.provider,
          providerInfo,
          caseName: testCase.name,
          response: result.response,
          assertion: result.assertion,
          error: result.error
        }
      };
    });
  });

  const start = Date.parse(startedAt);
  const stop = Date.parse(finishedAt);
  const failed = tests.filter((testCase) => testCase.status === "failed").length;
  const passed = tests.filter((testCase) => testCase.status === "passed").length;
  const skipped = tests.filter((testCase) => testCase.status === "skipped").length;

  return {
    reportFormat: "CTRF",
    specVersion: "1.0.0",
    schemaVersion: 1,
    status: failed > 0 ? "failed" : "passed",
    mode: liveAgent ? "live" : "http",
    baseUrl,
    startedAt,
    finishedAt,
    results: {
      tool: {
        name: "agent-bridge-smoke",
        extra: {
          baseUrl,
          mode: liveAgent ? "live" : "http"
        }
      },
      summary: {
        tests: tests.length,
        passed,
        failed,
        skipped,
        pending: 0,
        other: 0,
        suites: suites.length,
        start,
        stop,
        duration: Number.isFinite(start) && Number.isFinite(stop) ? stop - start : 0
      },
      environment: {
        appName: "agent-bridge",
        testEnvironment: liveAgent ? "live" : "http",
        osPlatform: process.platform
      },
      tests
    },
    extra: {
      providers
    }
  };
}

export function renderSmokeHtml(report) {
  const summary = report.results.summary;
  const providers = groupTestsByProvider(report.results.tests);
  const providerSections = providers
    .map(([provider, tests]) => renderProviderSection(provider, tests))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentBridge Smoke Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
    h1, h2, h3 { margin: 0 0 12px; }
    .summary, .provider { background: white; border: 1px solid #dbe3ee; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .metrics { display: flex; flex-wrap: wrap; gap: 12px; }
    .metric { min-width: 110px; padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fbfdff; }
    .case { border-top: 1px solid #e5e7eb; padding-top: 12px; margin-top: 12px; }
    .passed { color: #067647; }
    .failed { color: #b42318; }
    .skipped { color: #667085; }
    pre { overflow-x: auto; white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 12px; border-radius: 6px; }
    details { margin-top: 8px; }
  </style>
</head>
<body>
  <h1>AgentBridge Smoke Report</h1>
  <section class="summary">
    <h2>Summary</h2>
    <div class="metrics">
      ${renderMetric("Status", report.status)}
      ${renderMetric("Mode", report.mode)}
      ${renderMetric("Tests", summary.tests)}
      ${renderMetric("Passed", summary.passed)}
      ${renderMetric("Failed", summary.failed)}
      ${renderMetric("Skipped", summary.skipped)}
      ${renderMetric("Duration", `${summary.duration}ms`)}
    </div>
    <p><strong>Base URL:</strong> ${escapeHtml(report.baseUrl)}</p>
    <p><strong>Started:</strong> ${escapeHtml(report.startedAt)}<br><strong>Finished:</strong> ${escapeHtml(report.finishedAt)}</p>
  </section>
  ${providerSections}
</body>
</html>
`;
}

function providerSpecificCases(providerId, config) {
  if (providerId !== "codex") {
    return [];
  }

  const cases = [
    {
      name: "local file reference",
      request: buildCodexFileReferenceRequest(config.cwd, config.file)
    }
  ];

  if (config.image) {
    cases.push({
      name: "local image input",
      request: buildCodexImageRequest(config.image)
    });
  }

  return cases;
}

export function parseArgs(argv) {
  const config = {
    baseUrl: `http://${process.env.HOST ?? DEFAULT_HOST}:${process.env.PORT ?? DEFAULT_PORT}`,
    cwd: process.cwd(),
    file: "README.md",
    image: undefined,
    liveAgent: true,
    reportPath: DEFAULT_REPORT_PATH,
    htmlReportPath: DEFAULT_HTML_REPORT_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    writeReport: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live-agent") {
      config.liveAgent = true;
    } else if (arg === "--http-only") {
      config.liveAgent = false;
    } else if (arg === "--base-url") {
      config.baseUrl = requireValue(argv, ++i, "--base-url");
    } else if (arg === "--cwd") {
      config.cwd = requireValue(argv, ++i, "--cwd");
    } else if (arg === "--file") {
      config.file = requireValue(argv, ++i, "--file");
    } else if (arg === "--image") {
      config.image = requireValue(argv, ++i, "--image");
    } else if (arg === "--report") {
      config.reportPath = requireValue(argv, ++i, "--report");
      config.writeReport = true;
    } else if (arg === "--html-report") {
      config.htmlReportPath = requireValue(argv, ++i, "--html-report");
      config.writeReport = true;
    } else if (arg === "--timeout-ms") {
      config.timeoutMs = Number(requireValue(argv, ++i, "--timeout-ms"));
      if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number");
      }
    } else if (arg === "--no-report") {
      config.writeReport = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const server = await ensureServer(config.baseUrl, config.timeoutMs);
  const startedAt = new Date().toISOString();

  try {
    await checkHealth(config.baseUrl, config.timeoutMs);
    const providers = await checkProviders(config.baseUrl, config.timeoutMs);
    checkEveryProviderDetected(providers);
    const suites = buildProviderSmokeSuites(providers, config);
    let results = [];

    if (config.liveAgent) {
      results = await smokeProviderSuites(config.baseUrl, suites, config.timeoutMs);
    }

    const report = createSmokeReport({
      baseUrl: config.baseUrl,
      liveAgent: config.liveAgent,
      providers,
      suites,
      results,
      startedAt,
      finishedAt: new Date().toISOString()
    });
    if (config.writeReport) {
      await writeSmokeReport(config.reportPath, report);
      await writeSmokeHtmlReport(config.htmlReportPath, report);
    }

    const failures = report.results.summary.failed;
    if (failures > 0) {
      throw new Error(`${failures} smoke case(s) failed. See ${config.reportPath}.`);
    }
    logOk(config.liveAgent ? "Live provider smoke checks passed" : "Provider smoke checks passed");
  } finally {
    await server.stop();
  }
}

async function ensureServer(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (await canReachHealth(baseUrl)) {
    logInfo(`Using running server at ${baseUrl}`);
    return { stop: async () => {} };
  }

  const entrypoint = resolve("dist/src/main.js");
  if (!existsSync(entrypoint)) {
    throw new Error("Built server not found. Run `npm run build` before `npm run smoke`.");
  }

  logInfo(`Starting built server at ${baseUrl}`);
  const url = new URL(baseUrl);
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      HOST: url.hostname,
      PORT: url.port || DEFAULT_PORT
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  await waitForHealth(baseUrl, child, stderr, timeoutMs);

  return {
    stop: async () => {
      if (!child.killed) {
        child.kill();
        await Promise.race([
          once(child, "exit"),
          new Promise((resolveExit) => setTimeout(resolveExit, 2000))
        ]);
      }
    }
  };
}

async function waitForHealth(baseUrl, child, stderr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before health check passed. ${stderr}`.trim());
    }
    if (await canReachHealth(baseUrl)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function canReachHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function checkHealth(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const body = await getJson(`${baseUrl}/health`, "health", timeoutMs);
  if (!body || typeof body !== "object") {
    throw new Error("Health response was not a JSON object");
  }
  logOk("GET /health");
}

async function checkProviders(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  logInfo("GET /providers");
  const body = await getJson(`${baseUrl}/providers`, "providers", timeoutMs);
  const providers = Array.isArray(body) ? body : body.providers;
  if (!Array.isArray(providers)) {
    throw new Error("Providers response did not contain a provider list");
  }
  logOk("GET /providers");
  return providers;
}

function checkEveryProviderDetected(providers) {
  const providerIds = providerIdsFrom(providers);
  if (providerIds.length === 0) {
    throw new Error("Providers response did not include any providers");
  }

  for (const provider of providers) {
    logOk(`${provider.id} detected with status ${provider.status}`);
  }
}

export async function smokeProviderSuites(baseUrl, suites, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const results = [];

  for (const suite of suites) {
    const skipReason = providerSkipReason(suite);
    if (skipReason) {
      logInfo(skipReason);
      for (const testCase of suite.cases) {
        results.push({
          provider: suite.provider,
          caseName: testCase.name,
          status: "skipped",
          durationMs: 0,
          request: testCase.request,
          error: {
            message: skipReason
          }
        });
      }
      continue;
    }

    logInfo(`Provider ${suite.provider}`);
    for (const testCase of suite.cases) {
      const started = Date.now();
      let request = testCase.request;
      let response;
      try {
        request = buildCaseRequest(testCase, results, suite.provider);
        response = await postInvoke(
          baseUrl,
          request,
          `${suite.provider} ${testCase.name}`,
          timeoutMs
        );
        const assertion = validateCaseResponse(testCase, response);
        logOk(`${suite.provider} ${testCase.name}`);
        results.push({
          provider: suite.provider,
          caseName: testCase.name,
          status: "passed",
          durationMs: Date.now() - started,
          request,
          response,
          assertion
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          provider: suite.provider,
          caseName: testCase.name,
          status: "failed",
          durationMs: Date.now() - started,
          request,
          response,
          error: { message }
        });
        console.error(`[smoke] failed case: ${suite.provider} ${testCase.name}: ${message}`);
      }
    }
  }

  return results;
}

function buildCaseRequest(testCase, results, provider) {
  if (!testCase.nativeSessionFrom) {
    return testCase.request;
  }

  const previous = results.find(
    (result) =>
      result.provider === provider &&
      result.caseName === testCase.nativeSessionFrom &&
      result.status === "passed"
  );
  const session = previous?.response?.session;
  if (!session) {
    throw new Error(
      `${provider} ${testCase.name} requires session from ${testCase.nativeSessionFrom}`
    );
  }

  return {
    ...testCase.request,
    session
  };
}

function validateCaseResponse(testCase, response) {
  if (!testCase.expectedFinalTextIncludes) {
    return undefined;
  }

  const finalText = response?.finalText ?? "";
  if (!finalText.includes(testCase.expectedFinalTextIncludes)) {
    throw new Error(`Expected response finalText to include ${testCase.expectedFinalTextIncludes}`);
  }

  return {
    expectedFinalTextIncludes: testCase.expectedFinalTextIncludes,
    actualFinalText: finalText
  };
}

async function postInvoke(baseUrl, body, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(`${baseUrl}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (!payload?.requestId || payload.provider !== body.provider) {
    throw new Error(`${label} returned an invalid response: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function getJson(url, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, undefined, timeoutMs);
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}`);
  }
  return await response.json();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function logInfo(message) {
  console.log(`[smoke] ${message}`);
}

function logOk(message) {
  console.log(`[smoke] ok: ${message}`);
}

async function writeSmokeReport(reportPath, report) {
  const resolved = resolve(reportPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  logInfo(`Report written to ${resolved}`);
}

async function writeSmokeHtmlReport(reportPath, report) {
  const resolved = resolve(reportPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, renderSmokeHtml(report), "utf8");
  logInfo(`HTML report written to ${resolved}`);
}

function groupTestsByProvider(tests) {
  const grouped = new Map();
  for (const testCase of tests) {
    const provider = testCase.extra?.provider ?? "unknown";
    const existing = grouped.get(provider) ?? [];
    existing.push(testCase);
    grouped.set(provider, existing);
  }
  return [...grouped.entries()];
}

function renderProviderSection(provider, tests) {
  const cases = tests.map(renderCase).join("\n");
  return `<section class="provider">
    <h2>${escapeHtml(provider)}</h2>
    ${cases}
  </section>`;
}

function renderCase(testCase) {
  return `<article class="case">
    <h3>${escapeHtml(testCase.name)} <span class="${escapeHtml(testCase.status)}">${escapeHtml(testCase.status)}</span></h3>
    <p><strong>Duration:</strong> ${escapeHtml(String(testCase.duration ?? 0))}ms</p>
    ${testCase.message ? `<p><strong>Message:</strong> ${escapeHtml(testCase.message)}</p>` : ""}
    <details open>
      <summary>Input</summary>
      <pre>${escapeHtml(JSON.stringify(testCase.parameters?.request, null, 2))}</pre>
    </details>
    <details>
      <summary>Output</summary>
      <pre>${escapeHtml(JSON.stringify(testCase.extra?.response ?? testCase.extra?.error ?? null, null, 2))}</pre>
    </details>
  </article>`;
}

function renderMetric(label, value) {
  return `<div class="metric"><strong>${escapeHtml(label)}</strong><br>${escapeHtml(String(value))}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
