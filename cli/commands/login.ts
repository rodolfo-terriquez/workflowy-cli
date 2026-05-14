import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { loadConfig, saveConfig } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";

export function registerLogin(program: Command): void {
  program
    .command("login [apiKey]")
    .description("Authenticate with WorkFlowy using an API key")
    .option("--account <name>", "Account name", "default")
    .action(async (apiKey: string | undefined, opts: { account: string }) => {
      let key = apiKey ?? process.env.WORKFLOWY_API_KEY;

      if (!key) {
        if (!process.stdin.isTTY) {
          console.error("API key required. Pass it as an argument, or set WORKFLOWY_API_KEY.");
          process.exit(1);
        }
        key = await prompt("API key: ");
      }

      if (!key?.trim()) {
        console.error("API key is required.");
        process.exit(1);
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
          console.log(JSON.stringify({ message: "Authenticated successfully", account: opts.account }));
        }
      } catch (err) {
        console.error(
          `\nLogin failed: ${err instanceof Error ? err.message : String(err)}`
        );
        console.error("Check that your API key is valid.\n");
        process.exit(1);
      }
    });
}

function prompt(message: string): Promise<string> {
  process.stdout.write(message);

  return new Promise<string>((resolve) => {
    let input = "";
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (data: string) => {
      if (data === "\n" || data === "\r" || data === "\r\n") {
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        resolve(input);
      } else if (data === "\u0003") {
        process.exit(0);
      } else if (data === "\u007F" || data === "\b") {
        input = input.slice(0, -1);
      } else {
        input += data;
      }
    };

    process.stdin.on("data", onData);
  });
}
