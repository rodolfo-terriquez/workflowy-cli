import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeDocEditOperations, planDocEditCalls, type DocEditNodeInfo } from "./doc-edit.ts";
import { resetCacheDb, replaceAllNodes } from "../shared/cache.ts";
import { saveConfig } from "../shared/config.ts";
import { cacheTargets, resetDb } from "../shared/db.ts";

async function withTempConfig<T>(fn: () => Promise<T> | T): Promise<T> {
  const previousDir = process.env.WORKFLOWY_CONFIG_DIR;
  const configDir = mkdtempSync(join(tmpdir(), "workflowy-cli-doc-edit-"));
  process.env.WORKFLOWY_CONFIG_DIR = configDir;
  resetCacheDb();
  resetDb();

  try {
    saveConfig({ activeAccount: "default", accounts: { default: { name: "default", token: "test-token" } } });
    replaceAllNodes([
      { id: "root-1", parent_id: null, name: "Inbox", note: null, priority: 0, createdAt: 1, modifiedAt: 1 },
      { id: "child-1", parent_id: "root-1", name: "Existing", note: null, priority: 0, createdAt: 2, modifiedAt: 2 },
    ]);
    cacheTargets("default", [{ key: "inbox", label: "Inbox", nodeId: "root-1", type: "system" }]);
    return await fn();
  } finally {
    resetCacheDb();
    resetDb();
    if (previousDir === undefined) delete process.env.WORKFLOWY_CONFIG_DIR;
    else process.env.WORKFLOWY_CONFIG_DIR = previousDir;
    rmSync(configDir, { recursive: true, force: true });
  }
}

test("normalizeDocEditOperations preserves advanced nested insert shape and resolves targets", async () => {
  await withTempConfig(() => {
    const ops = normalizeDocEditOperations([
      {
        op: "insert",
        under: "root-1",
        after: "child-1",
        position: "bottom",
        items: [
          {
            n: "Parent",
            l: "h2",
            c: [
              { n: "Child todo", l: "todo", x: 0 },
              { n: "Example code", l: "code", d: "note" },
            ],
          },
        ],
      },
    ]);

    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("insert");
    expect(ops[0]?.under).toBe("root-1");
    expect(ops[0]?.after).toBe("child-1");
    expect(ops[0]?.position).toBe("bottom");
    expect(ops[0]?.items?.[0]?.l).toBe("h2");
    expect(ops[0]?.items?.[0]?.c?.[0]?.l).toBe("todo");
    expect(ops[0]?.items?.[0]?.c?.[1]?.l).toBe("code");
  });
});

test("normalizeDocEditOperations supports update layout and completion fields", async () => {
  await withTempConfig(() => {
    const ops = normalizeDocEditOperations([
      { op: "update", ref: "child-1", to: { n: "Existing renamed", l: "todo", x: 1 } },
    ]);

    expect(ops[0]?.op).toBe("update");
    expect(ops[0]?.ref).toBe("child-1");
    expect(ops[0]?.to).toEqual({ n: "Existing renamed", l: "todo", x: 1 });
  });
});

test("normalizeDocEditOperations rejects unsupported line types", async () => {
  await withTempConfig(() => {
    expect(() => normalizeDocEditOperations([
      { op: "insert", under: "root-1", items: [{ n: "Nope", l: "unsupported" }] },
    ])).toThrow("unsupported line type");
  });
});

test("planDocEditCalls roots nested operations at their live parent", async () => {
  const nodes = new Map<string, DocEditNodeInfo>([
    ["root-1", { id: "root-1", parentId: null, ancestorIds: [] }],
    ["section-1", { id: "section-1", parentId: "root-1", ancestorIds: ["root-1"] }],
    ["child-1", { id: "child-1", parentId: "section-1", ancestorIds: ["root-1", "section-1"] }],
  ]);

  const calls = await planDocEditCalls(
    "root-1",
    [
      { op: "update", ref: "child-1", to: { n: "Renamed" } },
      { op: "move", ref: "child-1", under: "root-1", position: "bottom" },
      { op: "delete", ref: "child-1" },
    ],
    { getNodeInfo: async (ref) => nodes.get(ref) ?? null },
  );

  expect(calls).toEqual([
    {
      root: "section-1",
      operations: [
        { op: "update", ref: "child-1", to: { n: "Renamed" } },
        { op: "move", ref: "child-1", under: "root-1", position: "bottom" },
      ],
    },
    {
      root: "root-1",
      operations: [{ op: "delete", ref: "child-1" }],
    },
  ]);
});

test("planDocEditCalls rejects references outside the requested root", async () => {
  await expect(planDocEditCalls(
    "root-1",
    [{ op: "update", ref: "outside-1", to: { n: "Nope" } }],
    {
      getNodeInfo: async () => ({
        id: "outside-1",
        parentId: "other-root",
        ancestorIds: ["other-root"],
      }),
    },
  )).rejects.toMatchObject({ code: "ref_not_under_root" });
});

test("planDocEditCalls uses the insertion target as the API root", async () => {
  const calls = await planDocEditCalls(
    "root-1",
    [{ op: "insert", under: "section-1", items: [{ n: "Nested child" }] }],
    {
      getNodeInfo: async (ref) => ref === "section-1"
        ? { id: "section-1", parentId: "root-1", ancestorIds: ["root-1"] }
        : null,
    },
  );

  expect(calls).toEqual([{
    root: "section-1",
    operations: [{ op: "insert", under: "section-1", items: [{ n: "Nested child" }] }],
  }]);
});

test("planDocEditCalls rejects insert-after nodes from a different parent", async () => {
  await expect(planDocEditCalls(
    "root-1",
    [{ op: "insert", under: "section-1", after: "other-child", items: [{ n: "Nested child" }] }],
    {
      getNodeInfo: async (ref) => ref === "section-1"
        ? { id: "section-1", parentId: "root-1", ancestorIds: ["root-1"] }
        : { id: "other-child", parentId: "other-section", ancestorIds: ["root-1", "other-section"] },
    },
  )).rejects.toMatchObject({ code: "invalid_target" });
});
