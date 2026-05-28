import type { Command } from "commander";
import { runDoctor } from "./doctor.ts";

export function registerAuth(program: Command): void {
  const authCmd = program
    .command("auth")
    .description("Authentication and connection helpers")
    .showSuggestionAfterError()
    .showHelpAfterError("\nRun `wf auth --help` to see auth commands.");

  authCmd
    .command("status")
    .description("Show authentication and setup status")
    .action(runDoctor);
}
