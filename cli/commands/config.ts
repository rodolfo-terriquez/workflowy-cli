import { APP_VERSION } from "../shared/version.ts";
import type { Command } from "commander";
import chalk from "chalk";
import { getConfigValue, isSensitiveConfigKey, parseApiEnvironment, redactConfigValue, setConfigValue, loadConfig, saveConfig } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { getAliases, type AliasMap } from "../shared/alias.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerConfigCommands(program: Command): void {
  program
    .command("config:get <key>")
    .description("Read a config value (dotted path, e.g. llm.model)")
    .option("--show-secret", "Show sensitive values without redaction")
    .action((key: string, opts: { showSecret?: boolean }) => {
      const value = getConfigValue(key);
      const displayValue = !opts.showSecret && value !== undefined
        ? isSensitiveConfigKey(key) ? "[redacted]" : redactConfigValue(value)
        : value;

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:get", wf_version: APP_VERSION },
          key,
          value: displayValue ?? null,
        }));
      } else if (value === undefined) {
        console.log(chalk.dim(`\n  ${key} is not set\n`));
      } else {
        console.log(`\n  ${chalk.cyan(key)} = ${typeof displayValue === "object" ? JSON.stringify(displayValue, null, 2) : String(displayValue)}\n`);
      }
    });

  program
    .command("config:set <key> [value]")
    .description("Write a config value (dotted path, e.g. llm.model google/gemini-flash-2.5)")
    .option("--stdin", "Read the value from stdin (recommended for secrets)")
    .action(async (key: string, value: string | undefined, opts: { stdin?: boolean }) => {
      if (value !== undefined && opts.stdin) {
        exitWithError("invalid_input", "Pass the value either as an argument or with --stdin, not both.");
      }
      const resolvedValue = (opts.stdin ? await Bun.stdin.text() : value)?.trim();
      if (resolvedValue === undefined || resolvedValue === "") {
        exitWithError("missing_arg", "A config value is required.", "Pass a value or use --stdin.");
      }
      const normalizedValue = key === "api.environment"
        ? parseApiEnvironment(resolvedValue)
        : resolvedValue;
      if (key === "api.environment" && !normalizedValue) {
        exitWithError("invalid_api_environment", `Unknown API environment "${resolvedValue}".`, "Use production or beta.");
      }
      setConfigValue(key, normalizedValue!);
      const displayValue = isSensitiveConfigKey(key) ? "[redacted]" : normalizedValue!;

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "config:set", wf_version: APP_VERSION },
          key,
          value: displayValue,
          status: "ok",
        }));
      } else {
        console.log(`\n  ${chalk.green("✓")} ${chalk.cyan(key)} = ${displayValue}\n`);
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
          meta: { command: "config:alias set", wf_version: APP_VERSION },
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
          meta: { command: "config:alias list", wf_version: APP_VERSION },
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
          meta: { command: "config:alias remove", wf_version: APP_VERSION },
          alias: name,
          status: "removed",
        }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Removed alias ${chalk.cyan(name)}\n`);
      }
    });
}
