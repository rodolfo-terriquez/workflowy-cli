import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { getDefaultAddPosition, parseAddPosition, requireToken } from "../shared/config.ts";
import { getCacheNodeCount, markTargetDirty, setTargetUuid } from "../shared/cache.ts";
import { normalizeNode, parseLlmDocResponse } from "../shared/nodes.ts";
import { verifyInsertedChild } from "../shared/insert-verification.ts";
import { markdownToRichText } from "../shared/markdown.ts";
import { resolveTargetReference, resolveWriteTargetReference } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { buildWriteSuccessOutput } from "../shared/write-response.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { isSystemTargetKey } from "../targets.ts";

export function registerNodeAdd(program: Command): void {
  program
    .command("node:add <target> <text>")
    .alias("add")
    .description("Add one child node to a target")
    .option("--type <type>", "Node layout (bullet|todo|h1|h2|h3)", "bullet")
    .option("--note <note>", "Note content for the node; prefer child bullets for outline body text")
    .option("--position <pos>", "Position: top or bottom (overrides defaults.addPosition)")
    .option("--after <nodeId>", "Insert after this sibling node")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        target: string,
        text: string,
        opts: {
          type: string;
          note?: string;
          position?: string;
          after?: string;
          format?: string;
        }
      ) => {
        const position = opts.position === undefined
          ? getDefaultAddPosition()
          : parseAddPosition(opts.position);
        if (!position) {
          exitWithError("invalid_position", `Unknown position "${opts.position}".`, "Use top or bottom.");
        }

        const token = requireToken();
        const api = new WorkflowyAPI(token);

        let resolvedId: string;
        let resolvedLabel: string;

        if (target.startsWith("@") && target.includes("/") && getCacheNodeCount() === 0) {
          exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first for path-based targets.");
        }

        const resolved = opts.after
          ? resolveTargetReference(target)
          : resolveWriteTargetReference(target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${target}" could not be resolved`, "Run `wf cache:sync` to refresh path lookups");
        }

        resolvedId = resolved.id;
        resolvedLabel = resolved.label;

        const item: { n: string; d?: string; l?: string } = { n: text };
        if (opts.note) item.d = opts.note;
        if (opts.type !== "bullet") item.l = opts.type;

        const useJson = opts.format === "json" || isAgentMode();
        const shouldVerifyInsert = useJson || !!opts.after;
        const fatalOnVerificationFailure = isAgentMode() || !!opts.after;
        const beforeChildren = shouldVerifyInsert && opts.after
          ? await readLiveChildren(api, resolvedId)
          : [];

        let createdNodeId: string | undefined;
        let createdNodeText: string | undefined;
        let materializedParentId: string | undefined;
        let verificationStatus: "verified" | "mismatch" | "not_found" | "ambiguous" | "skipped" = "skipped";

        if (opts.after) {
          await api.editDoc(resolvedId, [
            { op: "insert", after: opts.after, items: [item] },
          ]);
        } else {
          const created = await api.createNode(resolvedId, text, {
            ...(opts.note ? { note: markdownToRichText(opts.note) } : {}),
            ...(opts.type !== "bullet" ? { layoutMode: toPublicLayoutMode(opts.type) } : {}),
            position,
          });
          createdNodeId = created.item_id;
        }

        if (opts.after && shouldVerifyInsert) {
          try {
            const afterChildren = await readLiveChildren(api, resolvedId);
            const verification = verifyInsertedChild({
              beforeChildren,
              afterChildren,
              requestedText: text,
              afterId: opts.after,
              position,
            });

            verificationStatus = verification.status;
            createdNodeId = verification.createdNodeId ?? undefined;
            createdNodeText = verification.createdNodeText ?? undefined;

            if (verification.status !== "verified" && fatalOnVerificationFailure) {
              exitWithError(
                "write_verification_failed",
                `node:add completed but could not verify the created node. ${verification.message}`,
                createdNodeId
                  ? `Try \`wf node:update ${createdNodeId} --text ${JSON.stringify(text)}\` if you want to repair the inserted node.`
                  : "Read the parent live to inspect what was inserted before retrying.",
              );
            }
          } catch {
            verificationStatus = "skipped";
          }
        } else if (createdNodeId && (shouldVerifyInsert || isSystemTargetKey(resolvedId))) {
          try {
            const createdNode = await api.getNode(createdNodeId);
            if (createdNode.parent_id && isSystemTargetKey(resolvedId)) {
              materializedParentId = createdNode.parent_id;
              setTargetUuid(resolvedId, createdNode.parent_id);
            }

            if (shouldVerifyInsert) {
              const verification = verifyInsertedChild({
                beforeChildren: [],
                afterChildren: [normalizeNode(createdNode)],
                requestedText: text,
                position,
              });

              verificationStatus = verification.status;
              createdNodeId = verification.createdNodeId ?? createdNodeId;
              createdNodeText = verification.createdNodeText ?? undefined;

              if (verification.status !== "verified" && fatalOnVerificationFailure) {
                exitWithError(
                  "write_verification_failed",
                  `node:add completed but could not verify the created node. ${verification.message}`,
                  `Read node ${createdNodeId} live to inspect what was inserted before retrying.`,
                );
              }
            }
          } catch {
            verificationStatus = "skipped";
          }
        }

        markTargetDirty(resolvedId);
        if (materializedParentId) markTargetDirty(materializedParentId);
        if (createdNodeId) markTargetDirty(createdNodeId);

        if (useJson) {
          console.log(formatJson(buildWriteSuccessOutput({
            command: "node:add",
            target,
            resolvedId,
            message: `Added to ${resolvedLabel}`,
            affectedNodeIds: [resolvedId, materializedParentId, createdNodeId],
            dirtyNodeIds: [resolvedId, materializedParentId, createdNodeId],
            details: {
              parent_id: materializedParentId ?? resolvedId,
              destination_target: materializedParentId ? resolvedId : undefined,
              insert_after_id: opts.after,
              created_node_id: createdNodeId,
              created_node_text: createdNodeText,
              write_verified: verificationStatus === "verified",
              verification_status: verificationStatus,
              requested_node: {
                text,
                note: opts.note,
                type: opts.type,
                position: opts.after ? undefined : position,
              },
            },
          })));
        } else {
          console.log(
            `\n  ${chalk.green("✓")} Added to ${chalk.cyan(resolvedLabel)}: ${text}\n`
          );
        }
      }
    );
}

async function readLiveChildren(api: WorkflowyAPI, nodeId: string) {
  const data = await api.readDoc(nodeId, 1);
  return parseLlmDocResponse(data).node.children;
}

function toPublicLayoutMode(type: string): string {
  switch (type) {
    case "bullet": return "bullets";
    case "code": return "code-block";
    case "quote": return "quote-block";
    default: return type;
  }
}
