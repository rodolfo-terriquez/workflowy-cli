let _agentMode = false;

export function setAgentMode(enabled: boolean): void {
  _agentMode = enabled;
}

export function isAgentMode(): boolean {
  if (_agentMode) return true;

  if (process.env.CI === "true") return true;
  if (process.env.TERM === "dumb") return true;
  if (process.env.WF_AGENT === "1") return true;

  return false;
}
