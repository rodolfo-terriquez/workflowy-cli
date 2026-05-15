import type { FlatNode } from "../shared/nodes.ts";

export interface JsonOutput {
  meta?: Record<string, unknown>;
  node?: FlatNode;
  nodes?: unknown[];
  children?: FlatNode[];
  message?: string;
  proposal?: Record<string, unknown>;
  path?: string;
  error?: Record<string, unknown>;
  [key: string]: unknown;
}

export function formatJson(data: JsonOutput): string {
  return JSON.stringify(data, null, 2);
}
