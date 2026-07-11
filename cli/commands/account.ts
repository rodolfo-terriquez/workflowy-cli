import { APP_VERSION } from "../shared/version.ts";
import type { Command } from "commander";
import chalk from "chalk";
import { getActiveAccountName, loadConfig, saveConfig } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerAccountCommands(program: Command): void {
  program
    .command("account:list")
    .description("List configured accounts")
    .action(() => {
      const config = loadConfig();
      const accounts = Object.keys(config.accounts);
      const selectedAccount = getActiveAccountName(config);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "account:list", wf_version: APP_VERSION },
          accounts: accounts.map((name) => ({
            name,
            active: name === config.activeAccount,
            selected: name === selectedAccount,
          })),
          active_account: config.activeAccount,
          selected_account: selectedAccount,
        }, null, 2));
        return;
      }

      if (accounts.length === 0) {
        console.log(chalk.dim("\n  No accounts configured. Run `wf login` first.\n"));
        return;
      }

      console.log("\n  Accounts:\n");
      for (const name of accounts) {
        const active = name === config.activeAccount;
        const selected = name === selectedAccount;
        const icon = active ? chalk.green("●") : chalk.dim("○");
        const label = active ? chalk.bold(name) : name;
        const status = [active ? "active" : null, selected && !active ? "selected" : null].filter(Boolean).join(", ");
        console.log(`  ${icon} ${label}${status ? chalk.dim(` (${status})`) : ""}`);
      }
      console.log("");
    });

  program
    .command("account:switch <name>")
    .description("Switch active account")
    .action((name: string) => {
      const config = loadConfig();

      if (!(name in config.accounts)) {
        exitWithError(
          "account_not_found",
          `Account "${name}" not found`,
          `Available: ${Object.keys(config.accounts).join(", ") || "none — run wf login --account <name> first"}`
        );
      }

      config.activeAccount = name;
      saveConfig(config);

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "account:switch", wf_version: APP_VERSION }, active_account: name }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Switched to account ${chalk.bold(name)}\n`);
      }
    });

  program
    .command("account:current")
    .description("Show active account")
    .action(() => {
      const config = loadConfig();
      const selectedAccount = getActiveAccountName(config);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "account:current", wf_version: APP_VERSION },
          active_account: selectedAccount,
          default_account: config.activeAccount,
          has_token: !!config.accounts[selectedAccount]?.token,
        }));
      } else {
        console.log(`\n  Active account: ${chalk.bold(selectedAccount)}${selectedAccount !== config.activeAccount ? chalk.dim(` (default: ${config.activeAccount})`) : ""}\n`);
      }
    });
}
