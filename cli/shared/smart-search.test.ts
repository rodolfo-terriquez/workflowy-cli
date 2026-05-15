import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const testHome = mkdtempSync(join(tmpdir(), "workflowy-cli-smart-search-"));
const testConfigDir = join(testHome, ".workflowy");

let cacheModule: typeof import("./cache.ts");
let smartSearchModule: typeof import("./smart-search.ts");

beforeAll(async () => {
  process.env.HOME = testHome;
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  cacheModule = await import("./cache.ts");
  smartSearchModule = await import("./smart-search.ts");
});

afterAll(() => {
  cacheModule.resetCacheDb();

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

test("falls back to fuzzy tier when FTS returns no matches", () => {
  cacheModule.replaceAllNodes([
    {
      id: "node-1",
      name: "campaign 94",
      note: "Launch checklist",
      parent_id: null,
      modifiedAt: 100,
    },
  ]);

  const results = smartSearchModule.tieredSearch("campain", 20);

  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.name).toBe("campaign 94");
  expect(results[0]?.match_type).toBe("fuzzy");
});

test("matches typo plus exact numeric term through fuzzy fallback", () => {
  cacheModule.replaceAllNodes([
    {
      id: "node-1",
      name: "campaign 94",
      note: "Quarterly plan",
      parent_id: null,
      modifiedAt: 200,
    },
    {
      id: "node-2",
      name: "campaign 17",
      note: "Old draft",
      parent_id: null,
      modifiedAt: 50,
    },
  ]);

  const results = smartSearchModule.tieredSearch("campain 94", 20);

  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.name).toBe("campaign 94");
  expect(results[0]?.match_type).toBe("fuzzy");
});
