import type { Command } from "commander";
import chalk from "chalk";
import { getConfigValue, setConfigValue, loadConfig, saveConfig } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { getAliases, type AliasMap } from "../shared/alias.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerConfigCommands(program: Command): void {
  program
    .command("config:get <key>")
    .description("Read a config value (dotted path, e.g. llm.model)")
    .action((key: string) => {
      const value = getConfigValue(key);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:get", wf_version: "3.0.6" },
          key,
          value: value ?? null,
        }));
      } else if (value === undefined) {
        console.log(chalk.dim(`\n  ${key} is not set\n`));
      } else {
        console.log(`\n  ${chalk.cyan(key)} = ${typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}\n`);
      }
    });

  program
    .command("config:set <key> <value>")
    .description("Write a config value (dotted path, e.g. llm.model google/gemini-flash-2.5)")
    .action((key: string, value: string) => {
      setConfigValue(key, value);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:set", wf_version: "3.0.6" },
          key,
          value,
          status: "ok",
        }));
      } else {
        console.log(`\n  ${chalk.green("✓")} ${chalk.cyan(key)} = ${value}\n`);
      }
    });

  // Alias management
  const aliasCmd = program
    .command("config:alias")
    .description("Manage command aliases");

  aliasCmd
    .command("set <name> <expansion>")
    .description("Create or update an alias")
    .action((name: string, expansion: string) => {
      const config = loadConfig();
      const aliases = (config.aliases ?? {}) as AliasMap;
      aliases[name] = expansion;
      config.aliases = aliases;
      saveConfig(config);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:alias set", wf_version: "3.0.6" },
          alias: name,
          expansion,
          status: "ok",
        }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Alias ${chalk.cyan(name)} → ${chalk.dim(expansion)}\n`);
      }
    });

  aliasCmd
    .command("list")
    .description("List all aliases")
    .action(() => {
      const aliases = getAliases();
      const entries = Object.entries(aliases);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:alias list", wf_version: "3.0.6" },
          aliases,
        }));
        return;
      }

      if (entries.length === 0) {
        console.log(chalk.dim("\n  No aliases defined.\n"));
        return;
      }

      console.log("");
      for (const [name, expansion] of entries) {
        console.log(`  ${chalk.cyan(name.padEnd(20))} → ${chalk.dim(expansion)}`);
      }
      console.log("");
    });

  aliasCmd
    .command("remove <name>")
    .description("Remove an alias")
    .action((name: string) => {
      const config = loadConfig();
      const aliases = (config.aliases ?? {}) as AliasMap;
      if (!(name in aliases)) {
        exitWithError("alias_not_found", `Alias "${name}" not found.`);
      }
      delete aliases[name];
      config.aliases = aliases;
      saveConfig(config);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:alias remove", wf_version: "3.0.6" },
          alias: name,
          status: "removed",
        }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Removed alias ${chalk.cyan(name)}\n`);
      }
    });
}
