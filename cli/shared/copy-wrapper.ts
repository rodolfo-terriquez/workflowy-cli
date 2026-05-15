import chalk from "chalk";
import { copyToClipboard } from "./clipboard.ts";
import { isAgentMode } from "../agent.ts";

let _capturedOutput = "";
let _intercepting = false;

const _origWrite = process.stdout.write.bind(process.stdout);

export function startOutputCapture(): void {
  _capturedOutput = "";
  _intercepting = true;
  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    _capturedOutput += str;
    return _origWrite(chunk, ...args);
  };
}

export function stopOutputCapture(): string {
  _intercepting = false;
  (process.stdout as any).write = _origWrite;
  return _capturedOutput;
}

export async function handleCopyFlag(shouldCopy: boolean): Promise<void> {
  if (!shouldCopy) return;
  const output = stopOutputCapture();
  const plain = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  const ok = await copyToClipboard(plain.trim());
  if (!isAgentMode()) {
    if (ok) {
      _origWrite(`  ${chalk.dim("(copied to clipboard)")}\n`);
    } else {
      _origWrite(`  ${chalk.yellow("⚠")} ${chalk.dim("clipboard tool not available")}\n`);
    }
  }
}
