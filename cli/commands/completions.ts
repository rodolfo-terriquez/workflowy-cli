import type { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getConfigDir } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";

const COMMANDS = [
  "node:read", "node:add", "node:move", "node:complete", "node:update", "node:delete",
  "node:find", "node:context", "node:todos", "node:template", "node:export",
  "node:bulk complete", "node:bulk delete", "node:bulk move",
  "search", "tags", "targets", "history",
  "cache:sync", "cache:diff",
  "ai:propose", "ai:preview", "ai:apply", "ai:reject", "ai:list",
  "batch",
  "config:set", "config:get", "config:alias",
  "account:list", "account:switch", "account:current",
  "watch:start", "watch:stop", "watch:status",
  "webhook:create", "webhook:list", "webhook:delete", "webhook:test",
  "workflow:run", "workflow:list", "workflow:create",
  "mcp", "doctor", "completions", "login", "self:update",
];

function generateZshCompletion(): string {
  const cmds = COMMANDS.map((c) => `'${c}'`).join(" ");
  return `#compdef wf
_wf() {
  local -a commands
  commands=(${cmds})
  _arguments '1: :->command' '*::arg:->args'
  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        node:read|node:find|node:context|node:todos)
          _arguments '--format[Output format]:format:(json outline tsv csv)' '--copy[Copy to clipboard]' '--live[Bypass cache]'
          ;;
        search)
          _arguments '--format[Output format]:format:(json outline tsv csv)' '--smart[AI rerank]' '--copy[Copy to clipboard]' '--live[Bypass cache]'
          ;;
        *)
          _arguments '--format[Output format]:format:(json outline)' '--copy[Copy to clipboard]'
          ;;
      esac
      ;;
  esac
}
compdef _wf wf
`;
}

function generateBashCompletion(): string {
  const cmds = COMMANDS.join(" ");
  return `_wf_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") )
}
complete -F _wf_completions wf
`;
}

function generateFishCompletion(): string {
  const lines = COMMANDS.map((c) => `complete -c wf -n '__fish_use_subcommand' -a '${c}'`);
  return lines.join("\n") + "\n";
}

function detectShell(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

export function registerCompletions(program: Command): void {
  const cmd = program
    .command("completions")
    .description("Manage shell completions");

  cmd
    .command("install")
    .description("Install shell completions")
    .option("--shell <type>", "Shell type (bash|zsh|fish)")
    .action((opts: { shell?: string }) => {
      const shell = opts.shell ?? detectShell();
      const home = homedir();

      let script: string;
      let targetPath: string;

      switch (shell) {
        case "zsh": {
          script = generateZshCompletion();
          targetPath = join(home, ".zsh", "completions", "_wf");
          const dir = join(home, ".zsh", "completions");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(targetPath, script, "utf-8");

          const zshrc = join(home, ".zshrc");
          if (existsSync(zshrc)) {
            const content = readFileSync(zshrc, "utf-8");
            if (!content.includes("fpath=(~/.zsh/completions")) {
              appendFileSync(zshrc, '\nfpath=(~/.zsh/completions $fpath)\nautoload -Uz compinit && compinit\n');
            }
          }
          break;
        }
        case "fish": {
          script = generateFishCompletion();
          targetPath = join(home, ".config", "fish", "completions", "wf.fish");
          const dir = join(home, ".config", "fish", "completions");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(targetPath, script, "utf-8");
          break;
        }
        default: {
          script = generateBashCompletion();
          targetPath = join(home, ".local", "share", "bash-completion", "completions", "wf");
          const dir = join(home, ".local", "share", "bash-completion", "completions");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(targetPath, script, "utf-8");

          const bashrc = join(home, ".bashrc");
          if (existsSync(bashrc)) {
            const content = readFileSync(bashrc, "utf-8");
            if (!content.includes("bash-completion/completions/wf")) {
              appendFileSync(bashrc, `\n[ -f ${targetPath} ] && source ${targetPath}\n`);
            }
          }
          break;
        }
      }

      writeFileSync(join(getConfigDir(), "completions-installed"), shell, "utf-8");

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "completions install", wf_version: "3.0.0" }, shell, path: targetPath }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Installed ${shell} completions at ${chalk.dim(targetPath)}`);
        console.log(`  Restart your shell or run ${chalk.cyan("source " + targetPath)} to activate.\n`);
      }
    });
}
