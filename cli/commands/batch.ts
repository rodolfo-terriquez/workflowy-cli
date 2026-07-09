import type { Command } from "commander";
import { WorkflowyAPI, type LlmDocOperation } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import { getCacheNodeCount, getNodeById, markTargetDirty } from "../shared/cache.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { findByNameOrPath, isDirectId, resolveTargetReference, type ResolvedTargetReference } from "../shared/path.ts";
import { uniqueNodeIds } from "../shared/write-response.ts";

interface BatchOp {
  op: "capture" | "add" | "complete" | "uncomplete" | "move" | "delete";
  text?: string;
  to?: string;
  ref?: string;
  target?: string;
  type?: string;
  note?: string;
  position?: "top" | "bottom";
}

interface BatchNodeInfo {
  id: string;
  parentId: string | null;
}

interface BatchPlanGroup {
  operations: LlmDocOperation[];
  dirtyIds: Set<string>;
  affectedIds: Set<string>;
  operationTypes: Set<BatchOp["op"]>;
}

interface BatchPlannerDeps {
  resolveTargetReference: (input: string) => ResolvedTargetReference | null;
  getNodeInfo: (ref: string) => Promise<BatchNodeInfo | null>;
}

class BatchPlanningError extends Error {
  code: string;
  hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "BatchPlanningError";
    this.code = code;
    this.hint = hint;
  }
}

function failBatch(code: string, message: string, hint?: string): never {
  throw new BatchPlanningError(code, message, hint);
}

function addToGroup(
  groups: Map<string, BatchPlanGroup>,
  root: string,
  operation: LlmDocOperation,
  operationType: BatchOp["op"],
  dirtyIds: string[] = [],
  affectedIds: string[] = [],
): void {
  let group = groups.get(root);
  if (!group) {
    group = { operations: [], dirtyIds: new Set<string>(), affectedIds: new Set<string>(), operationTypes: new Set<BatchOp["op"]>() };
    groups.set(root, group);
  }

  group.operations.push(operation);
  group.operationTypes.add(operationType);
  for (const dirtyId of dirtyIds) {
    group.dirtyIds.add(dirtyId);
  }
  for (const affectedId of affectedIds) {
    group.affectedIds.add(affectedId);
  }
}

export async function planBatchOperations(
  ops: BatchOp[],
  deps: BatchPlannerDeps,
): Promise<Map<string, BatchPlanGroup>> {
  const groups = new Map<string, BatchPlanGroup>();

  for (const op of ops) {
    switch (op.op) {
      case "capture":
      case "add": {
        const targetStr = op.to ?? op.target ?? "@inbox";
        const resolved = deps.resolveTargetReference(targetStr);
        if (!resolved) {
          failBatch(
            "node_not_found",
            `Target "${targetStr}" not found`,
            "Run `wf cache:sync` to refresh path lookups",
          );
        }

        const item: { n: string; d?: string; l?: string } = { n: op.text ?? "" };
        if (op.note) item.d = op.note;
        if (op.type && op.type !== "bullet") item.l = op.type;

        addToGroup(
          groups,
          resolved.id,
          {
            op: "insert",
            under: resolved.id,
            items: [item],
            position: op.position ?? "top",
          },
          op.op,
          [resolved.id],
          [resolved.id],
        );
        break;
      }

      case "complete":
      case "uncomplete": {
        if (!op.ref) {
          failBatch("invalid_input", `${op.op} requires ref`);
        }

        const node = await deps.getNodeInfo(op.ref);
        if (!node) {
          failBatch("node_not_found", `Node "${op.ref}" not found`, "Use a valid node id or run `wf cache:sync` first");
        }

        addToGroup(
          groups,
          node.id,
          {
            op: "update",
            ref: node.id,
            to: { x: op.op === "complete" ? 1 : 0 },
          },
          op.op,
          [node.id, ...(node.parentId ? [node.parentId] : [])],
          [node.id],
        );
        break;
      }

      case "move": {
        if (!op.ref) {
          failBatch("invalid_input", "move requires ref");
        }

        const targetStr = op.to ?? op.target;
        if (!targetStr) {
          failBatch("invalid_input", "move requires to or target");
        }

        const destination = deps.resolveTargetReference(targetStr);
        if (!destination) {
          failBatch(
            "node_not_found",
            `Target "${targetStr}" not found`,
            "Run `wf cache:sync` to refresh path lookups",
          );
        }

        const node = await deps.getNodeInfo(op.ref);
        if (!node) {
          failBatch("node_not_found", `Node "${op.ref}" not found`, "Use a valid node id or run `wf cache:sync` first");
        }

        if (!node.parentId) {
          failBatch("invalid_target", `Node "${op.ref}" cannot be moved from the tree root`);
        }

        addToGroup(
          groups,
          node.parentId,
          {
            op: "move",
            ref: node.id,
            under: destination.id,
            position: op.position ?? "top",
          },
          op.op,
          [node.id, node.parentId, destination.id],
          [node.id, node.parentId, destination.id],
        );
        break;
      }

      case "delete": {
        if (!op.ref) {
          failBatch("invalid_input", "delete requires ref");
        }

        const node = await deps.getNodeInfo(op.ref);
        if (!node) {
          failBatch("node_not_found", `Node "${op.ref}" not found`, "Use a valid node id or run `wf cache:sync` first");
        }

        if (!node.parentId) {
          failBatch("invalid_target", `Node "${op.ref}" cannot be deleted from the tree root`, "Choose a non-root node.");
        }

        addToGroup(
          groups,
          node.parentId,
          { op: "delete", ref: node.id },
          op.op,
          [node.id, node.parentId],
          [node.id, node.parentId],
        );
        break;
      }
    }
  }

  return groups;
}

async function resolveBatchNodeInfo(api: WorkflowyAPI, ref: string): Promise<BatchNodeInfo | null> {
  if (getCacheNodeCount() > 0) {
    const cached = getNodeById(ref);
    if (cached) {
      return { id: cached.id, parentId: cached.parent_id };
    }

    if (!isDirectId(ref)) {
      const matches = findByNameOrPath(ref);
      if (matches.length === 1) {
        return { id: matches[0]!.id, parentId: matches[0]!.parent_id };
      }

      if (matches.length > 1) {
        failBatch(
          "ambiguous_target",
          `"${ref}" matches ${matches.length} nodes`,
          `Use a node ID. Candidates: ${matches.slice(0, 3).map((match) => match.id).join(", ")}`,
        );
      }
    }
  }

  if (!isDirectId(ref)) {
    return null;
  }

  try {
    const raw = await api.readDoc(ref, 0);
    const { node, ancestors } = parseLlmDocResponse(raw as Record<string, unknown>);
    return {
      id: node.id,
      parentId: ancestors.length > 0 ? ancestors[ancestors.length - 1]!.id : null,
    };
  } catch {
    return null;
  }
}

function printBatchError(error: unknown): never {
  if (error instanceof BatchPlanningError) {
    console.log(JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        hint: error.hint,
      },
    }, null, 2));
    process.exit(1);
  }

  throw error;
}

export function registerBatch(program: Command): void {
  program
    .command("batch")
    .description("Execute flat grouped operations from stdin")
    .action(async () => {
      const token = requireToken();
      const api = new WorkflowyAPI(token);

      let rawInput = "";
      for await (const chunk of Bun.stdin.stream()) {
        rawInput += new TextDecoder().decode(chunk);
      }

      let ops: BatchOp[];
      try {
        ops = JSON.parse(rawInput);
        if (!Array.isArray(ops)) throw new Error("Expected JSON array");
      } catch {
        console.log(JSON.stringify({
          error: { code: "invalid_input", message: "stdin must be a JSON array of operations" },
        }, null, 2));
        process.exit(1);
      }

      let grouped: Map<string, BatchPlanGroup>;
      try {
        grouped = await planBatchOperations(ops, {
          resolveTargetReference,
          getNodeInfo: (ref) => resolveBatchNodeInfo(api, ref),
        });
      } catch (error) {
        printBatchError(error);
      }

      const results: Array<{
        root: string;
        operation_count: number;
        success: boolean;
        operation_types: string[];
        affected_node_ids: string[];
        dirty_node_ids: string[];
        error?: string;
      }> = [];
      let hadFailures = false;

      for (const [root, group] of grouped) {
        try {
          await api.readDoc(root, 1);
          await api.editDoc(root, group.operations);
          for (const dirtyId of group.dirtyIds) {
            markTargetDirty(dirtyId);
          }
          results.push({
            root,
            operation_count: group.operations.length,
            success: true,
            operation_types: [...group.operationTypes],
            affected_node_ids: uniqueNodeIds([...group.affectedIds]),
            dirty_node_ids: uniqueNodeIds([...group.dirtyIds]),
          });
        } catch (err) {
          hadFailures = true;
          results.push({
            root,
            operation_count: group.operations.length,
            success: false,
            operation_types: [...group.operationTypes],
            affected_node_ids: uniqueNodeIds([...group.affectedIds]),
            dirty_node_ids: uniqueNodeIds([...group.dirtyIds]),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      console.log(JSON.stringify({
        meta: { command: "batch", timestamp: new Date().toISOString(), wf_version: "3.2.1" },
        success: !hadFailures,
        results,
        total_operations: ops.length,
        api_calls: grouped.size,
        affected_node_ids: uniqueNodeIds(results.flatMap((result) => result.affected_node_ids)),
        dirty_node_ids: uniqueNodeIds(results.flatMap((result) => result.dirty_node_ids)),
      }, null, 2));

      if (hadFailures) {
        process.exit(1);
      }
    });
}
