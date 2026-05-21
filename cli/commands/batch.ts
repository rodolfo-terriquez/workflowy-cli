import type { Command } from "commander";
import { WorkflowyAPI, type LlmDocOperation } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import { markTargetDirty } from "../shared/cache.ts";
import { resolveTargetReference } from "../shared/path.ts";

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

export function registerBatch(program: Command): void {
  program
    .command("batch")
    .description("Execute a JSON array of operations from stdin")
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
      } catch (err) {
        console.log(JSON.stringify({
          error: { code: "invalid_input", message: "stdin must be a JSON array of operations" },
        }, null, 2));
        process.exit(1);
      }

      const grouped = new Map<string, LlmDocOperation[]>();

      for (const op of ops) {
        const targetStr = op.to ?? op.target ?? "@inbox";
        const resolved = resolveTargetReference(targetStr);
        if (!resolved) {
          console.log(JSON.stringify({
            error: { code: "node_not_found", message: `Target "${targetStr}" not found`, hint: "Run `wf cache:sync` to refresh path lookups" },
          }, null, 2));
          process.exit(1);
        }
        const root = resolved.id;

        if (!grouped.has(root)) grouped.set(root, []);
        const list = grouped.get(root)!;

        switch (op.op) {
          case "capture":
          case "add": {
            const item: { n: string; d?: string; l?: string } = { n: op.text ?? "" };
            if (op.note) item.d = op.note;
            if (op.type && op.type !== "bullet") item.l = op.type;
            list.push({
              op: "insert",
              under: root,
              items: [item],
              position: op.position ?? "top",
            });
            break;
          }
          case "complete":
            if (op.ref) list.push({ op: "update", ref: op.ref, to: { x: 1 } });
            break;
          case "uncomplete":
            if (op.ref) list.push({ op: "update", ref: op.ref, to: { x: 0 } });
            break;
          case "move":
            if (op.ref) list.push({ op: "move", ref: op.ref, under: root, position: op.position ?? "top" });
            break;
          case "delete":
            if (op.ref) list.push({ op: "delete", ref: op.ref });
            break;
        }
      }

      const results: Array<{ root: string; operation_count: number; success: boolean; error?: string }> = [];

      for (const [root, operations] of grouped) {
        try {
          await api.readDoc(root, 1);
          await api.editDoc(root, operations);
          markTargetDirty(root);
          results.push({ root, operation_count: operations.length, success: true });
        } catch (err) {
          results.push({
            root,
            operation_count: operations.length,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      console.log(JSON.stringify({
        meta: { command: "batch", timestamp: new Date().toISOString(), wf_version: "3.0.3" },
        results,
        total_operations: ops.length,
        api_calls: grouped.size,
      }, null, 2));
    });
}
