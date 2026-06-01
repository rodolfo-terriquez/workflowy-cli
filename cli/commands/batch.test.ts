import { expect, test } from "bun:test";
import { planBatchOperations } from "./batch.ts";

test("planBatchOperations uses the source parent as the batch root for move ops", async () => {
  const plan = await planBatchOperations(
    [
      { op: "move", ref: "03784d781e82", to: "@projects" },
    ],
    {
      resolveTargetReference: (input) => {
        if (input === "@projects") {
          return {
            id: "projects-root-uuid",
            label: "@projects",
            source: "shortcut",
          };
        }
        return null;
      },
      getNodeInfo: async (ref) => {
        if (ref === "03784d781e82") {
          return {
            id: "58dc0169-558c-4907-8bf4-03784d781e82",
            parentId: "source-parent-uuid",
          };
        }
        return null;
      },
    },
  );

  expect([...plan.keys()]).toEqual(["source-parent-uuid"]);

  const group = plan.get("source-parent-uuid");
  expect(group).toBeDefined();
  expect(group?.operations).toEqual([
    {
      op: "move",
      ref: "58dc0169-558c-4907-8bf4-03784d781e82",
      under: "projects-root-uuid",
      position: "top",
    },
  ]);
  expect([...group!.dirtyIds]).toEqual([
    "58dc0169-558c-4907-8bf4-03784d781e82",
    "source-parent-uuid",
    "projects-root-uuid",
  ]);
  expect([...group!.affectedIds]).toEqual([
    "58dc0169-558c-4907-8bf4-03784d781e82",
    "source-parent-uuid",
    "projects-root-uuid",
  ]);
  expect([...group!.operationTypes]).toEqual(["move"]);
});

test("planBatchOperations rejects unresolvable move refs instead of silently succeeding", async () => {
  await expect(
    planBatchOperations(
      [
        { op: "move", ref: "missing-node", to: "@projects" },
      ],
      {
        resolveTargetReference: (input) => {
          if (input === "@projects") {
            return {
              id: "projects-root-uuid",
              label: "@projects",
              source: "shortcut",
            };
          }
          return null;
        },
        getNodeInfo: async () => null,
      },
    ),
  ).rejects.toMatchObject({
    code: "node_not_found",
    message: 'Node "missing-node" not found',
  });
});

test("planBatchOperations does not default complete ops to @inbox", async () => {
  const plan = await planBatchOperations(
    [
      { op: "complete", ref: "todo-1" },
    ],
    {
      resolveTargetReference: () => null,
      getNodeInfo: async (ref) => {
        if (ref === "todo-1") {
          return {
            id: "todo-1",
            parentId: "inbox-root",
          };
        }
        return null;
      },
    },
  );

  expect([...plan.keys()]).toEqual(["todo-1"]);
  expect(plan.get("todo-1")?.operations).toEqual([
    {
      op: "update",
      ref: "todo-1",
      to: { x: 1 },
    },
  ]);
  expect([...plan.get("todo-1")!.affectedIds]).toEqual(["todo-1"]);
  expect([...plan.get("todo-1")!.dirtyIds]).toEqual(["todo-1", "inbox-root"]);
  expect([...plan.get("todo-1")!.operationTypes]).toEqual(["complete"]);
});
