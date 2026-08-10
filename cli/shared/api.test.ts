import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPublicApiBase, toLlmDocId, WorkflowyAPI } from "./api.ts";
import { getApiEnvironment, saveConfig, setApiEnvironmentOverride } from "./config.ts";

const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const originalApiEnvironment = process.env.WORKFLOWY_API_ENVIRONMENT;
const testConfigDir = mkdtempSync(join(tmpdir(), "workflowy-cli-api-"));

beforeAll(() => {
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  delete process.env.WORKFLOWY_API_ENVIRONMENT;
});

afterEach(() => {
  setApiEnvironmentOverride(null);
  if (existsSync(testConfigDir)) {
    rmSync(testConfigDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  setApiEnvironmentOverride(null);
  if (originalConfigDir === undefined) delete process.env.WORKFLOWY_CONFIG_DIR;
  else process.env.WORKFLOWY_CONFIG_DIR = originalConfigDir;
  if (originalApiEnvironment === undefined) delete process.env.WORKFLOWY_API_ENVIRONMENT;
  else process.env.WORKFLOWY_API_ENVIRONMENT = originalApiEnvironment;
  if (existsSync(testConfigDir)) rmSync(testConfigDir, { recursive: true, force: true });
});

test("toLlmDocId converts full UUIDs to LLM doc tags", () => {
  expect(toLlmDocId("4b84d72a-a337-5897-a6e3-e3f490273d81")).toBe("e3f490273d81");
});

test("toLlmDocId leaves short tags and non-UUID targets unchanged", () => {
  expect(toLlmDocId("e3f490273d81")).toBe("e3f490273d81");
  expect(toLlmDocId("today")).toBe("today");
});

test("public API environment defaults to production and supports config and one-shot overrides", () => {
  expect(getApiEnvironment()).toBe("production");
  expect(getPublicApiBase()).toBe("https://workflowy.com/api/v1");

  saveConfig({
    activeAccount: "default",
    accounts: {},
    api: { environment: "beta" },
  });
  expect(getApiEnvironment()).toBe("beta");
  expect(getPublicApiBase()).toBe("https://beta.workflowy.com/api/v1");

  setApiEnvironmentOverride("production");
  expect(getApiEnvironment()).toBe("production");
  expect(getPublicApiBase()).toBe("https://workflowy.com/api/v1");
});

test("beta public API routes mirror reads, creation, and removal to beta.workflowy.com", async () => {
  saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
    api: {
      environment: "beta",
      rateLimit: { requestsPerMinute: 60_000, exportMinIntervalSeconds: 0, maxRetries: 1 },
    },
  });

  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: typeof init?.body === "string" ? init.body : null });

    if (method === "POST") {
      return Response.json({ item_id: "mirror-1", origin_id: "origin-1" });
    }
    if (method === "DELETE") {
      return Response.json({ status: "ok" });
    }
    return Response.json({
      node: {
        id: "mirror-1",
        name: "Shared content",
        note: null,
        priority: 0,
        data: { layoutMode: "bullets", mirror: { origin_id: "origin-1" } },
        parent_id: "parent-1",
        createdAt: 1,
        modifiedAt: 2,
        completedAt: null,
      },
    });
  }) as typeof fetch;

  try {
    const api = new WorkflowyAPI("test-token");
    const node = await api.getNode("mirror-1");
    const created = await api.createMirror("origin-1", "parent-1", "bottom");
    await api.deleteMirror("mirror-1");

    expect(node.data?.mirror?.origin_id).toBe("origin-1");
    expect(created).toEqual({ item_id: "mirror-1", origin_id: "origin-1" });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://beta.workflowy.com/api/v1/nodes/mirror-1"],
      ["POST", "https://beta.workflowy.com/api/v1/nodes/origin-1/mirror"],
      ["DELETE", "https://beta.workflowy.com/api/v1/nodes/mirror-1/mirror"],
    ]);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ parent_id: "parent-1", position: "bottom" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public API routes ordinary CRUD through the configured v1 environment", async () => {
  saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
    api: {
      environment: "production",
      rateLimit: { requestsPerMinute: 60_000, exportMinIntervalSeconds: 0, maxRetries: 1 },
    },
  });

  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: typeof init?.body === "string" ? init.body : null });

    if (method === "POST" && url.endsWith("/api/v1/nodes")) {
      return Response.json({ item_id: "created-1" });
    }
    return Response.json({ status: "ok" });
  }) as typeof fetch;

  try {
    const api = new WorkflowyAPI("test-token");
    const created = await api.createNode("today", "Daily log", {
      note: "Supporting detail",
      position: "bottom",
    });
    await api.updateNode("created-1", { name: "Updated log", layoutMode: "h2" });
    await api.moveNode("created-1", "tomorrow", "top");
    await api.completeNode("created-1");
    await api.uncompleteNode("created-1");
    await api.deleteNode("created-1");

    expect(created).toEqual({ item_id: "created-1" });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://workflowy.com/api/v1/nodes"],
      ["POST", "https://workflowy.com/api/v1/nodes/created-1"],
      ["POST", "https://workflowy.com/api/v1/nodes/created-1/move"],
      ["POST", "https://workflowy.com/api/v1/nodes/created-1/complete"],
      ["POST", "https://workflowy.com/api/v1/nodes/created-1/uncomplete"],
      ["DELETE", "https://workflowy.com/api/v1/nodes/created-1"],
    ]);
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      parent_id: "today",
      name: "Daily log",
      note: "Supporting detail",
      position: "bottom",
    });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ name: "Updated log", layoutMode: "h2" });
    expect(JSON.parse(requests[2]!.body!)).toEqual({ parent_id: "tomorrow", position: "top" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("advanced document edits remain on the LLM endpoint while public writes honor beta selection", async () => {
  saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
    api: {
      environment: "beta",
      rateLimit: { requestsPerMinute: 60_000, exportMinIntervalSeconds: 0, maxRetries: 1 },
    },
  });

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/v1/nodes")) return Response.json({ item_id: "created-1" });
    return Response.json({ status: "ok" });
  }) as typeof fetch;

  try {
    const api = new WorkflowyAPI("test-token");
    await api.createNode("today", "Public write");
    await api.editDoc("root-1", [{
      op: "insert",
      under: "root-1",
      items: [{ n: "Nested", c: [{ n: "Child" }] }],
    }]);

    expect(requests).toEqual([
      "https://beta.workflowy.com/api/v1/nodes",
      "https://beta.workflowy.com/api/llm/doc/edit",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
