import type { Command } from "commander";
import chalk from "chalk";
import { getConfigValue, setConfigValue } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";

export function registerConfig(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage CLI configuration");

  configCmd
    .command("get <key>")
    .description("Read a config value (dotted path, e.g. llm.model)")
    .action((key: string) => {
      const value = getConfigValue(key);

      if (isAgentMode()) {
        console.log(JSON.stringify({ key, value: value ?? null }));
      } else if (value === undefined) {
        console.log(chalk.dim(`\n  ${key} is not set\n`));
      } else {
        console.log(`\n  ${chalk.cyan(key)} = ${typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}\n`);
      }
    });

  configCmd
    .command("set <key> <value>")
    .description("Write a config value (dotted path, e.g. llm.model google/gemini-flash-2.5)")
    .action((key: string, value: string) => {
      setConfigValue(key, value);

      if (isAgentMode()) {
        console.log(JSON.stringify({ key, value, status: "ok" }));
      } else {
        console.log(`\n  ${chalk.green("✓")} ${chalk.cyan(key)} = ${value}\n`);
      }
    });
}
