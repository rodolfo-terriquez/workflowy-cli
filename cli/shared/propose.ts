import { loadConfig, type LlmConfig } from "./config.ts";
import { getCacheDb, getNodeById, getChildren, buildBreadcrumbDisplay, getCacheNodeCount } from "./cache.ts";
import { cleanHtml, type FlatNode } from "./nodes.ts";

export interface ProposalOperation {
  op: "move" | "complete" | "uncomplete" | "insert" | "update" | "delete";
  ref?: string;
  ref_name?: string;
  from?: string;
  from_name?: string;
  under?: string;
  under_name?: string;
  text?: string;
  note?: string;
  type?: string;
  position?: "top" | "bottom";
}

export interface Proposal {
  id: string;
  summary: string;
  instruction: string;
  operations: ProposalOperation[];
  created_at: string;
}

const SYSTEM_PROMPT = `You are a WorkFlowy operations planner. Given an instruction and the current state of relevant WorkFlowy nodes, generate a structured JSON diff of operations to fulfill the instruction.

You MUST respond with ONLY valid JSON matching this schema:
{
  "summary": "Brief human-readable summary of what the operations do",
  "operations": [
    {
      "op": "move" | "complete" | "uncomplete" | "insert" | "update" | "delete",
      "ref": "node-id (for move/complete/uncomplete/update/delete)",
      "ref_name": "human-readable name of the node (for preview)",
      "from": "current-parent-id (for move)",
      "from_name": "name of current parent (for preview)",
      "under": "destination-parent-id (for move/insert)",
      "under_name": "name of destination (for preview)",
      "text": "text content (for insert/update)",
      "note": "note content (for insert/update)",
      "type": "bullet|todo|h1|h2|h3 (for insert)",
      "position": "top|bottom (for move/insert)"
    }
  ]
}

Rules:
- Use real node IDs from the context provided
- Include ref_name, from_name, under_name for human readability
- Only include operations that are needed
- Keep operations minimal and precise
- For "complete", set op to "complete" with the ref ID
- For "move", include from (current parent) and under (destination)
- For "insert", include under (parent) and text
- Do NOT include any explanation text outside the JSON`;

export async function generateProposal(
  instruction: string,
  modelOverride?: string
): Promise<{ summary: string; operations: ProposalOperation[] }> {
  const config = loadConfig();
  const llmConfig: LlmConfig = config.llm ?? {};
  const model = modelOverride ?? llmConfig.model ?? "google/gemini-flash-2.5";
  const apiKey = llmConfig.apiKey;

  if (!apiKey) {
    throw new Error(
      "No LLM API key configured. Run: wf config set llm.apiKey <your-openrouter-key>"
    );
  }

  const context = gatherContext(instruction);
  const maxTokens = llmConfig.maxContextTokens ?? 2000;
  const truncatedContext = context.length > maxTokens * 4
    ? context.slice(0, maxTokens * 4) + "\n...(truncated)"
    : context;

  const userPrompt = `Instruction: ${instruction}

Current WorkFlowy context:
${truncatedContext}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/rodolfo-terriquez/workflowy-cli",
      "X-Title": "WorkFlowy CLI",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM API call failed (${response.status}): ${body}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty response");

  const parsed = JSON.parse(content) as {
    summary: string;
    operations: ProposalOperation[];
  };

  if (!parsed.summary || !Array.isArray(parsed.operations)) {
    throw new Error("LLM response missing required fields (summary, operations)");
  }

  return parsed;
}

const TARGET_KEYWORDS: Record<string, string[]> = {
  inbox: ["inbox"],
  today: ["today"],
  tomorrow: ["tomorrow"],
  calendar: ["calendar", "daily"],
};

function gatherContext(instruction: string): string {
  if (getCacheNodeCount() === 0) {
    return "(Cache is empty — no context available. Run `wf sync` first.)";
  }

  const instructionLower = instruction.toLowerCase();
  const relevantRoots: string[] = [];

  for (const [target, keywords] of Object.entries(TARGET_KEYWORDS)) {
    if (keywords.some((kw) => instructionLower.includes(kw))) {
      relevantRoots.push(target);
    }
  }

  const atMentions = instruction.match(/@[\w-]+/g) ?? [];
  for (const mention of atMentions) {
    const name = mention.slice(1).toLowerCase().replace(/-/g, "_");
    if (!relevantRoots.includes(name)) relevantRoots.push(name);
  }

  if (relevantRoots.length === 0) {
    relevantRoots.push("inbox", "today");
  }

  const lines: string[] = [];
  const db = getCacheDb();

  for (const rootName of relevantRoots) {
    const rows = db.query("SELECT * FROM nodes WHERE LOWER(name) LIKE ? LIMIT 1")
      .all(`%${rootName}%`) as Array<{ id: string; name: string }>;

    if (rows.length === 0) continue;

    const rootNode = rows[0]!;
    lines.push(`\n## ${cleanHtml(rootNode.name)} (${rootNode.id})`);
    appendChildren(rootNode.id, lines, 1, 3);
  }

  return lines.join("\n");
}

function appendChildren(parentId: string, lines: string[], depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;

  const children = getChildren(parentId);
  const indent = "  ".repeat(depth);

  for (const child of children.slice(0, 20)) {
    const name = cleanHtml(child.name);
    const status = child.completed ? "[x]" : child.line_type === "todo" ? "[ ]" : "-";
    lines.push(`${indent}${status} ${name} (${child.id})`);
    if (child.note) lines.push(`${indent}  note: ${cleanHtml(child.note)}`);
    appendChildren(child.id, lines, depth + 1, maxDepth);
  }

  if (children.length > 20) {
    lines.push(`${indent}...and ${children.length - 20} more`);
  }
}
