import type { Command } from "commander";
import chalk from "chalk";
import { isAgentMode } from "../agent.ts";
import { getRuntimeVersionInfo } from "../shared/version.ts";

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("Show the current CLI version and git revision when available")
    .action(() => {
      const info = getRuntimeVersionInfo(process.argv[0] ?? process.execPath, process.cwd(), process.argv, import.meta.dir);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "version", wf_version: info.appVersion },
          version: info.version,
          app_version: info.appVersion,
          git_head: info.gitHead,
        }, null, 2));
        return;
      }

      if (info.gitHead) {
        console.log(`\n  ${chalk.bold("wf")} ${chalk.cyan(info.version)} ${chalk.dim(`(git ${info.gitHead})`)}\n`);
      } else {
        console.log(`\n  ${chalk.bold("wf")} ${chalk.cyan(info.version)}\n`);
      }
    });
}
