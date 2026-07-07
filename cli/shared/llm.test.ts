import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const originalFetch = globalThis.fetch;
const testHome = mkdtempSync(join(tmpdir(), "workflowy-cli-llm-"));
const testConfigDir = join(testHome, ".workflowy");

let configModule: typeof import("./config.ts");
let llmModule: typeof import("./llm.ts");

beforeAll(async () => {
  process.env.HOME = testHome;
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  configModule = await import("./config.ts");
  llmModule = await import("./llm.ts");
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (existsSync(testConfigDir)) {
    rmSync(testConfigDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalConfigDir === undefined) {
    delete process.env.WORKFLOWY_CONFIG_DIR;
  } else {
    process.env.WORKFLOWY_CONFIG_DIR = originalConfigDir;
  }

  rmSync(testHome, { recursive: true, force: true });
});

test("uses OpenRouter defaults for legacy llm config", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {},
    llm: { apiKey: "openrouter-key" },
  });

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({
      choices: [{ message: { content: "{\"ok\":true}" } }],
    });
  }) as typeof fetch;

  const result = await llmModule.completeJson<{ ok: boolean }>({ prompt: "Return JSON" });
  const headers = capturedInit?.headers as Record<string, string>;
  const body = JSON.parse(String(capturedInit?.body)) as {
    model: string;
    response_format: { type: string };
  };

  expect(result).toEqual({ ok: true });
  expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(headers.Authorization).toBe("Bearer openrouter-key");
  expect(headers["HTTP-Referer"]).toBe("https://github.com/rodolfo-terriquez/workflowy-cli");
  expect(body.model).toBe("google/gemini-flash-2.5");
  expect(body.response_format.type).toBe("json_object");
});

test("routes openai-compatible config to the configured chat completions base URL", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {},
    llm: {
      provider: "openai-compatible",
      apiKey: "provider-key",
      model: "custom-model",
      baseUrl: "https://llm.example.test/v1/",
    },
  });

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({
      choices: [{ message: { content: "{\"ids\":[\"a\"]}" } }],
    });
  }) as typeof fetch;

  const result = await llmModule.completeJson<{ ids: string[] }>({ prompt: "Return JSON" });
  const headers = capturedInit?.headers as Record<string, string>;
  const body = JSON.parse(String(capturedInit?.body)) as { model: string };

  expect(result).toEqual({ ids: ["a"] });
  expect(capturedUrl).toBe("https://llm.example.test/v1/chat/completions");
  expect(headers.Authorization).toBe("Bearer provider-key");
  expect(headers["HTTP-Referer"]).toBeUndefined();
  expect(body.model).toBe("custom-model");
});

test("routes anthropic config to the Messages API", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {},
    llm: {
      provider: "anthropic",
      apiKey: "anthropic-key",
      model: "claude-test-model",
    },
  });

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({
      content: [{ type: "text", text: "```json\n{\"ok\":true}\n```" }],
    });
  }) as typeof fetch;

  const result = await llmModule.completeJson<{ ok: boolean }>({
    system: "Use JSON.",
    prompt: "Return JSON",
    maxOutputTokens: 512,
  });
  const headers = capturedInit?.headers as Record<string, string>;
  const body = JSON.parse(String(capturedInit?.body)) as {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: string; content: string }>;
  };

  expect(result).toEqual({ ok: true });
  expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
  expect(headers["x-api-key"]).toBe("anthropic-key");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  expect(body.model).toBe("claude-test-model");
  expect(body.max_tokens).toBe(512);
  expect(body.system).toBe("Use JSON.");
  expect(body.messages).toEqual([{ role: "user", content: "Return JSON" }]);
});

test("requires an explicit model for anthropic", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {},
    llm: {
      provider: "anthropic",
      apiKey: "anthropic-key",
    },
  });

  await expect(llmModule.completeJson({ prompt: "Return JSON" })).rejects.toThrow(
    "No LLM model configured for anthropic"
  );
});

test("describes unsupported providers without throwing", () => {
  const status = llmModule.describeLlmConfig({
    provider: "made-up-provider",
    apiKey: "key",
    model: "model",
  });

  expect(status.provider).toBe("made-up-provider");
  expect(status.model).toBe("model");
  expect(status.error).toContain("Unsupported LLM provider");
});
