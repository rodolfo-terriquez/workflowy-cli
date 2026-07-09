import { APP_VERSION } from "../shared/version.ts";
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

const WEBHOOKS_PATH = join(getConfigDir(), "webhooks.json");

interface Webhook {
  id: string;
  filter: string;
  url: string;
  created_at: string;
}

function loadWebhooks(): Webhook[] {
  if (!existsSync(WEBHOOKS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(WEBHOOKS_PATH, "utf-8")) as Webhook[];
  } catch {
    return [];
  }
}

function saveWebhooks(hooks: Webhook[]): void {
  writeFileSync(WEBHOOKS_PATH, JSON.stringify(hooks, null, 2), "utf-8");
}

export function registerWebhook(program: Command): void {
  program
    .command("webhook:create")
    .description("Create a webhook for change notifications")
    .option("--filter <expr>", "Filter expression (e.g. tag:#urgent, target:@inbox)")
    .requiredOption("--url <url>", "Webhook URL to POST to")
    .action((opts: { filter?: string; url: string }) => {
      const hooks = loadWebhooks();
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const hook: Webhook = {
        id,
        filter: opts.filter ?? "*",
        url: opts.url,
        created_at: new Date().toISOString(),
      };
      hooks.push(hook);
      saveWebhooks(hooks);

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "webhook:create", wf_version: APP_VERSION }, webhook: hook }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Webhook ${chalk.cyan(id)} created → ${chalk.dim(opts.url)}\n`);
      }
    });

  program
    .command("webhook:list")
    .description("List configured webhooks")
    .action(() => {
      const hooks = loadWebhooks();

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "webhook:list", wf_version: APP_VERSION }, webhooks: hooks, count: hooks.length }));
        return;
      }

      if (hooks.length === 0) {
        console.log(chalk.dim("\n  No webhooks configured.\n"));
        return;
      }

      console.log("\n  Webhooks:\n");
      for (const h of hooks) {
        console.log(`  ${chalk.cyan(h.id)}  ${chalk.dim(h.filter.padEnd(20))}  ${h.url}`);
      }
      console.log("");
    });

  program
    .command("webhook:delete <id>")
    .description("Remove a webhook")
    .action((id: string) => {
      const hooks = loadWebhooks();
      const idx = hooks.findIndex((h) => h.id === id);
      if (idx === -1) exitWithError("not_found", `Webhook "${id}" not found`, "");
      hooks.splice(idx, 1);
      saveWebhooks(hooks);

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "webhook:delete", wf_version: APP_VERSION }, deleted: id }));
      } else {
        console.log(`\n  ${chalk.red("✗")} Webhook ${chalk.cyan(id)} deleted.\n`);
      }
    });

  program
    .command("webhook:test <id>")
    .description("Fire a test payload to a webhook")
    .action(async (id: string) => {
      const hooks = loadWebhooks();
      const hook = hooks.find((h) => h.id === id);
      if (!hook) exitWithError("not_found", `Webhook "${id}" not found`, "");

      const payload = {
        event: "test",
        webhook_id: hook.id,
        filter: hook.filter,
        ts: new Date().toISOString(),
        message: "Test payload from wf webhook:test",
      };

      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (isAgentMode()) {
          console.log(JSON.stringify({ meta: { command: "webhook:test", wf_version: APP_VERSION }, status: res.status, ok: res.ok }));
        } else {
          if (res.ok) {
            console.log(`\n  ${chalk.green("✓")} Test sent to ${chalk.dim(hook.url)} — ${res.status}\n`);
          } else {
            console.log(`\n  ${chalk.red("✗")} Test failed — ${res.status}\n`);
          }
        }
      } catch (err) {
        exitWithError("webhook_error", `Failed to reach ${hook.url}: ${err instanceof Error ? err.message : String(err)}`, "");
      }
    });
}
