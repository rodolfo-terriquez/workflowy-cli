import { isAgentMode } from "../agent.ts";

export interface AgentError {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

export function exitWithError(code: string, message: string, hint?: string): never {
  if (isAgentMode()) {
    const err: AgentError = { error: { code, message } };
    if (hint) err.error.hint = hint;
    console.log(JSON.stringify(err, null, 2));
  } else {
    console.error(`\n  Error: ${message}`);
    if (hint) console.error(`  Hint: ${hint}`);
    console.error("");
  }
  process.exit(1);
}
