import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI, type LlmDocItem, type LlmDocOperation } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import { getCacheNodeCount, getNodeById, markTargetDirty } from "../shared/cache.ts";
import { findByNameOrPath, isDirectId, resolveTargetReference } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

const ALLOWED_OPS = new Set(["insert", "update", "delete", "move"]);
const ALLOWED_LINE_TYPES = new Set(["todo", "h1", "h2", "h3", "p", "bullets", "code", "quote", "table"]);

export interface DocEditInputOperation {
  op: "insert" | "update" | "delete" | "move";
  under?: string;
  after?: string;
  items?: LlmDocItem[];
  position?: "top" | "bottom";
  ref?: string;
  to?: Partial<LlmDocItem>;
}

interface ResolvedDocEditOperation extends LlmDocOperation {
  original?: DocEditInputOperation;
}

class DocEditError extends Error {
  code: string;
  hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "DocEditError";
    this.code = code;
    this.hint = hint;
  }
}

function failDocEdit(code: string, message: string, hint?: string): never {
  throw new DocEditError(code, message, hint);
}

function parseOperationsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    failDocEdit(
      "invalid_json",
      `Could not parse operations JSON: ${err instanceof Error ? err.message : String(err)}`,
      "Pass a JSON array on stdin or as the optional operations argument.",
    );
  }
}

function unwrapOperationsPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === "object") {
    const maybeOps = (payload as { operations?: unknown; ops?: unknown }).operations ?? (payload as { ops?: unknown }).ops;
    if (Array.isArray(maybeOps)) return maybeOps;
  }

  failDocEdit("invalid_input", "Expected a JSON array of operations, or an object with operations/ops array.");
}

function assertPlainObject(value: unknown, code: string, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failDocEdit(code, message);
  }
}

function validateLineType(lineType: unknown, path: string): void {
  if (lineType === undefined) return;
  if (typeof lineType !== "string" || !ALLOWED_LINE_TYPES.has(lineType)) {
    failDocEdit(
      "invalid_line_type",
      `${path} has unsupported line type ${JSON.stringify(lineType)}`,
      `Supported line types: ${Array.from(ALLOWED_LINE_TYPES).join(", ")}`,
    );
  }
}

function validateDocItem(item: unknown, path: string): LlmDocItem {
  assertPlainObject(item, "invalid_item", `${path} must be an object`);
  if (typeof item.n !== "string") {
    failDocEdit("invalid_item", `${path}.n is required and must be a string`);
  }
  if (item.d !== undefined && typeof item.d !== "string") {
    failDocEdit("invalid_item", `${path}.d must be a string when provided`);
  }
  validateLineType(item.l, `${path}.l`);
  if (item.x !== undefined && item.x !== 0 && item.x !== 1) {
    failDocEdit("invalid_item", `${path}.x must be 0 or 1 when provided`);
  }

  const result: LlmDocItem = { n: item.n };
  if (item.d !== undefined) result.d = item.d;
  if (item.l !== undefined) result.l = item.l as string;
  if (item.x !== undefined) result.x = item.x as number;
  if (item.c !== undefined) {
    if (!Array.isArray(item.c)) {
      failDocEdit("invalid_item", `${path}.c must be an array when provided`);
    }
    result.c = item.c.map((child, index) => validateDocItem(child, `${path}.c[${index}]`));
  }
  return result;
}

function validateUpdatePayload(to: unknown): Partial<LlmDocItem> {
  assertPlainObject(to, "invalid_update", "update.to must be an object");
  const result: Partial<LlmDocItem> = {};
  if (to.n !== undefined) {
    if (typeof to.n !== "string") failDocEdit("invalid_update", "update.to.n must be a string");
    result.n = to.n;
  }
  if (to.d !== undefined) {
    if (typeof to.d !== "string") failDocEdit("invalid_update", "update.to.d must be a string");
    result.d = to.d;
  }
  validateLineType(to.l, "update.to.l");
  if (to.l !== undefined) result.l = to.l as string;
  if (to.x !== undefined) {
    if (to.x !== 0 && to.x !== 1) failDocEdit("invalid_update", "update.to.x must be 0 or 1");
    result.x = to.x as number;
  }
  if (to.c !== undefined) {
    if (!Array.isArray(to.c)) failDocEdit("invalid_update", "update.to.c must be an array when provided");
    result.c = to.c.map((child, index) => validateDocItem(child, `update.to.c[${index}]`));
  }
  if (Object.keys(result).length === 0) {
    failDocEdit("invalid_update", "update.to must include at least one field");
  }
  return result;
}

function resolveDocEditReference(input: string, role: string): string {
  if (isDirectId(input)) return input;

  if (getCacheNodeCount() > 0) {
    const target = resolveTargetReference(input);
    if (target) return target.id;

    const matches = findByNameOrPath(input);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      failDocEdit(
        "ambiguous_target",
        `${role} "${input}" matches ${matches.length} nodes`,
        `Use a node ID. Candidates: ${matches.slice(0, 3).map((m) => m.id).join(", ")}`,
      );
    }
  }

  // Preserve unknown direct-looking tags for live API resolution, but reject names/paths that need cache lookup.
  if (/^[0-9a-f]{8,}$/i.test(input)) return input;

  failDocEdit("node_not_found", `${role} "${input}" not found`, "Use a node ID, @target, cached path, or run `wf cache:sync` first.");
}

export function normalizeDocEditOperations(rawOps: unknown[]): ResolvedDocEditOperation[] {
  return rawOps.map((rawOp, index) => {
    assertPlainObject(rawOp, "invalid_operation", `operations[${index}] must be an object`);
    const op = rawOp.op;
    if (typeof op !== "string" || !ALLOWED_OPS.has(op)) {
      failDocEdit("invalid_operation", `operations[${index}].op must be one of insert, update, delete, move`);
    }

    const base: ResolvedDocEditOperation = { op: op as LlmDocOperation["op"], original: rawOp as unknown as DocEditInputOperation };

    if (rawOp.position !== undefined) {
      if (rawOp.position !== "top" && rawOp.position !== "bottom") {
        failDocEdit("invalid_operation", `operations[${index}].position must be top or bottom`);
      }
      base.position = rawOp.position;
    }

    if (op === "insert") {
      if (typeof rawOp.under !== "string" && typeof rawOp.after !== "string") {
        failDocEdit("invalid_operation", `operations[${index}] insert requires under or after`);
      }
      if (typeof rawOp.under === "string") base.under = resolveDocEditReference(rawOp.under, "under");
      if (typeof rawOp.after === "string") base.after = resolveDocEditReference(rawOp.after, "after");
      if (!Array.isArray(rawOp.items) || rawOp.items.length === 0) {
        failDocEdit("invalid_operation", `operations[${index}] insert requires a non-empty items array`);
      }
      base.items = rawOp.items.map((item, itemIndex) => validateDocItem(item, `operations[${index}].items[${itemIndex}]`));
      base.position = base.position ?? "top";
      return base;
    }

    if (op === "update") {
      if (typeof rawOp.ref !== "string") failDocEdit("invalid_operation", `operations[${index}] update requires ref`);
      base.ref = resolveDocEditReference(rawOp.ref, "ref");
      base.to = validateUpdatePayload(rawOp.to);
      return base;
    }

    if (op === "delete") {
      if (typeof rawOp.ref !== "string") failDocEdit("invalid_operation", `operations[${index}] delete requires ref`);
      base.ref = resolveDocEditReference(rawOp.ref, "ref");
      return base;
    }

    if (op === "move") {
      if (typeof rawOp.ref !== "string") failDocEdit("invalid_operation", `operations[${index}] move requires ref`);
      if (typeof rawOp.under !== "string") failDocEdit("invalid_operation", `operations[${index}] move requires under`);
      base.ref = resolveDocEditReference(rawOp.ref, "ref");
      base.under = resolveDocEditReference(rawOp.under, "under");
      base.position = base.position ?? "top";
      return base;
    }

    return base;
  });
}

async function readOperationsInput(operationsJson?: string): Promise<unknown[]> {
  if (operationsJson !== undefined) {
    return unwrapOperationsPayload(parseOperationsJson(operationsJson));
  }

  const stdinText = await new Response(Bun.stdin.stream()).text();
  if (!stdinText.trim()) {
    failDocEdit("missing_input", "No operations JSON provided", "Pipe a JSON array into stdin, or pass operations JSON as the optional argument.");
  }
  return unwrapOperationsPayload(parseOperationsJson(stdinText));
}

function collectDirtyIds(root: string, operations: LlmDocOperation[]): string[] {
  const ids = new Set<string>([root]);
  for (const op of operations) {
    if (op.under) ids.add(op.under);
    if (op.after) ids.add(op.after);
    if (op.ref) ids.add(op.ref);
    const cachedRef = op.ref ? getNodeById(op.ref) : null;
    if (cachedRef?.parent_id) ids.add(cachedRef.parent_id);
  }
  return Array.from(ids);
}

function printDocEditError(error: unknown): never {
  if (error instanceof DocEditError) {
    console.log(JSON.stringify({ error: { code: error.code, message: error.message, hint: error.hint } }, null, 2));
    process.exit(1);
  }
  throw error;
}

export function registerDocEdit(program: Command): void {
  program
    .command("doc:edit <root> [operationsJson]")
    .alias("edit-doc")
    .description("Advanced structured document edit (raw LLM doc operations)")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (root: string, operationsJson: string | undefined, opts: { format?: string }) => {
      try {
        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const resolvedRoot = resolveDocEditReference(root, "root");
        const rawOps = await readOperationsInput(operationsJson);
        const operations = normalizeDocEditOperations(rawOps);

        await api.readDoc(resolvedRoot, 1);
        const response = await api.editDoc(resolvedRoot, operations);
        const dirtyIds = collectDirtyIds(resolvedRoot, operations);
        for (const id of dirtyIds) markTargetDirty(id);

        const useJson = opts.format === "json" || isAgentMode();
        const output = {
          meta: {
            command: "doc:edit",
            root,
            resolved_id: resolvedRoot,
            operation_count: operations.length,
            operation_types: Array.from(new Set(operations.map((op) => op.op))),
            timestamp: new Date().toISOString(),
            wf_version: "3.1.2",
          },
          success: true,
          message: `Applied ${operations.length} operation${operations.length === 1 ? "" : "s"} to ${resolvedRoot}`,
          affected_node_ids: dirtyIds,
          dirty_node_ids: dirtyIds,
          response,
        };

        if (useJson) {
          console.log(formatJson(output));
        } else {
          console.log(`\n  ${chalk.green("✓")} Applied ${operations.length} structured edit operation${operations.length === 1 ? "" : "s"} to ${chalk.dim(resolvedRoot)}\n`);
        }
      } catch (err) {
        printDocEditError(err);
      }
    });
}
