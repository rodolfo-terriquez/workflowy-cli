import { APP_VERSION } from "../shared/version.ts";
import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { loadConfig, saveConfig } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerLogin(program: Command): void {
  program
    .command("login [apiKey]")
    .description("Authenticate with WorkFlowy using an API key (prompt, --stdin, or WORKFLOWY_API_KEY recommended)")
    .option("--account <name>", "Account name", "default")
    .option("--stdin", "Read the API key from stdin")
    .action(async (apiKey: string | undefined, opts: { account: string; stdin?: boolean }) => {
      if (apiKey && opts.stdin) {
        exitWithError("invalid_input", "Pass the API key either as an argument or with --stdin, not both.");
      }

      let key = opts.stdin ? await Bun.stdin.text() : apiKey;

      if (apiKey) {
        console.error("Warning: passing API keys as command arguments can expose them in shell history. Prefer the prompt, --stdin, or WORKFLOWY_API_KEY.");
      }

      if (!key) {
        key = process.env.WORKFLOWY_API_KEY;
      }

      if (!key) {
        if (process.stdin.isTTY) {
          key = await promptSecret("API key: ");
        } else {
          exitWithError("missing_api_key", "API key required. Use --stdin or set WORKFLOWY_API_KEY.");
        }
      }

      if (!key?.trim()) {
        exitWithError("missing_api_key", "API key is required.");
      }

      key = key.trim();

      try {
        const api = new WorkflowyAPI(key);
        await api.validate();

        const config = loadConfig();
        config.accounts[opts.account] = {
          name: opts.account,
          token: key,
        };
        config.activeAccount = opts.account;
        saveConfig(config);

        if (!isAgentMode()) {
          console.log(`\n  ${chalk.green("✓")} Authenticated successfully`);
          console.log(`  Account saved as "${opts.account}"\n`);
        } else {
          console.log(JSON.stringify({
            meta: { command: "login", wf_version: APP_VERSION },
            message: "Authenticated successfully",
            account: opts.account,
          }));
        }
      } catch (err) {
        exitWithError(
          "login_failed",
          `Login failed: ${err instanceof Error ? err.message : String(err)}`,
          "Check that your API key is valid."
        );
      }
    });
}

function promptSecret(message: string): Promise<string> {
  process.stdout.write(message);

  return new Promise<string>((resolve) => {
    let input = "";
    const wasRaw = process.stdin.isRaw;
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode?.(true);

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode?.(wasRaw ?? false);
      process.stdin.pause();
    };

    const onData = (data: string) => {
      for (const char of data) {
        if (char === "\n" || char === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007F" || char === "\b") {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };

    process.stdin.on("data", onData);
  });
}
