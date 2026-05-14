import type { FlatNode } from "../shared/nodes.ts";

export interface JsonOutput {
  meta?: {
    command: string;
    target?: string;
    resolved_id?: string;
    timestamp: string;
    account?: string;
  };
  node?: FlatNode;
  nodes?: FlatNode[];
  children?: FlatNode[];
  message?: string;
  proposal?: {
    id: string;
    instructions: string;
    preview: string;
  };
}

export function formatJson(data: JsonOutput): string {
  return JSON.stringify(data, null, 2);
}
