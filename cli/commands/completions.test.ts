import { expect, test } from "bun:test";
import { generateCompletion } from "./completions.ts";

test("generateCompletion prints sourceable scripts for every supported shell", () => {
  expect(generateCompletion("zsh")).toContain("#compdef wf");
  expect(generateCompletion("bash")).toContain("complete -F _wf_completions wf");
  expect(generateCompletion("fish")).toContain("complete -c wf");
});

test("generateCompletion rejects unsupported shells instead of silently using bash", () => {
  expect(() => generateCompletion("powershell")).toThrow('Unsupported shell "powershell"');
});
