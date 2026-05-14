import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AccountConfig {
  name: string;
  token: string;
}

export interface WFConfig {
  activeAccount: string;
  accounts: Record<string, AccountConfig>;
}

const CONFIG_DIR = join(homedir(), ".workflowy");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DB_DIR = join(CONFIG_DIR, "db");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getDbDir(): string {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
  return DB_DIR;
}

export function getDbPath(): string {
  return join(getDbDir(), "wf.sqlite");
}

export function loadConfig(): WFConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { activeAccount: "default", accounts: {} };
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as WFConfig;
}

export function saveConfig(config: WFConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function getActiveAccount(config: WFConfig): AccountConfig | null {
  return config.accounts[config.activeAccount] ?? null;
}

export function getToken(accountName?: string): string | null {
  const config = loadConfig();
  const name = accountName ?? config.activeAccount;
  return config.accounts[name]?.token ?? null;
}

export function requireToken(accountName?: string): string {
  const token = getToken(accountName);
  if (!token) {
    console.error(
      "Not authenticated. Run `wf login` first."
    );
    process.exit(1);
  }
  return token;
}
