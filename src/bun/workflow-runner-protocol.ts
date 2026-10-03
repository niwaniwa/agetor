/** Pure workflow runner protocol. Never import the management database here. */
import type { WorkflowAgentResult, WorkflowLaunchManifest } from "../shared/development-workflow.ts";
import { toClaudeModelArg } from "../shared/claude-model-arg.ts";

export const WORKFLOW_STOP_GRACE_MS = 5_000;
export const VERIFIED_WORKFLOW_CLI_VERSIONS = {
  codex: ["0.159.0"],
  "claude-code": ["2.1.285"],
} as const;

const text = { type: "string" };
const texts = { type: "array", items: text };
export const WORKFLOW_RESULT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "question", "needs_input", "changes_requested", "failed", "quota"] },
    summary: text,
    requirements: { anyOf: [{ type: "null" }, {
      type: "object", additionalProperties: false,
      properties: { purpose: text, scope: text, outOfScope: text, acceptanceCriteria: texts, approach: text, assumptions: texts },
      required: ["purpose", "scope", "outOfScope", "acceptanceCriteria", "approach", "assumptions"],
    }] },
    questions: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { question: text, recommended: text, alternatives: texts, impact: text },
      required: ["question", "recommended", "alternatives", "impact"],
    } },
    validationPassed: { type: ["boolean", "null"] },
    reviewPassed: { type: ["boolean", "null"] },
  },
  required: ["status", "summary", "requirements", "questions", "validationPassed", "reviewPassed"],
} as const;

export function assertWorkflowAttemptId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid workflow attempt ID");
}

export function workflowUnitNames(attemptId: string) {
  assertWorkflowAttemptId(attemptId);
  return {
    service: `kaname-workflow-${attemptId}.service`,
    timer: `kaname-workflow-deadline-${attemptId}.timer`,
    stopper: `kaname-workflow-deadline-${attemptId}.service`,
  };
}

/** OnCalendar accepts calendar syntax, not systemd's separate @epoch timestamp syntax. */
export function workflowCalendarDeadline(at: number): string {
  if (!Number.isFinite(at)) throw new Error("Invalid workflow deadline");
  return new Date(at).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function parseWorkflowAgentResult(raw: unknown): WorkflowAgentResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Missing structured workflow result");
  const value = raw as Record<string, unknown>;
  if (!["completed", "question", "needs_input", "changes_requested", "failed", "quota"].includes(String(value.status))
    || typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Invalid workflow result status/summary");
  const status = value.status;
  const result: WorkflowAgentResult = { status: status as WorkflowAgentResult["status"], summary: value.summary };
  if (value.requirements != null) {
    const r = value.requirements as Record<string, unknown>;
    if (["purpose", "scope", "outOfScope", "approach"].some(k => typeof r[k] !== "string")
      || !stringArray(r.acceptanceCriteria) || !stringArray(r.assumptions)) throw new Error("Invalid workflow requirements");
    result.requirements = r as unknown as NonNullable<WorkflowAgentResult["requirements"]>;
  }
  if (value.questions != null) {
    if (!Array.isArray(value.questions) || value.questions.length > 20) throw new Error("Invalid workflow questions");
    result.questions = value.questions.map(q => {
      if (!q || typeof q !== "object" || ["question", "recommended", "impact"].some(k => typeof q[k] !== "string")
        || !stringArray(q.alternatives)) throw new Error("Invalid workflow question");
      return { question: q.question, recommended: q.recommended, alternatives: q.alternatives, impact: q.impact };
    });
  }
  if (typeof value.validationPassed === "boolean") result.validationPassed = value.validationPassed;
  if (typeof value.reviewPassed === "boolean") result.reviewPassed = value.reviewPassed;
  if (value.status === "changes_requested") result.reviewPassed = false;
  if ((status === "question" || status === "needs_input") && !result.questions?.length) throw new Error("needs_input requires a question");
  return result;
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string");
}

export function parseWorkflowValidationReports(raw: unknown): NonNullable<WorkflowAgentResult["validationReports"]> {
  if (!Array.isArray(raw) || raw.length > 20) throw new Error("Invalid worker validation report");
  return raw.map(report => {
    if (!report || typeof report !== "object" || typeof report.command !== "string"
      || !Number.isInteger(report.exitCode) || !Number.isFinite(report.startedAt) || !Number.isFinite(report.endedAt)
      || report.endedAt < report.startedAt) throw new Error("Invalid worker validation report");
    return { command: report.command, exitCode: report.exitCode, startedAt: report.startedAt, endedAt: report.endedAt };
  });
}

/** Explicit argv only. No legacy driver, DB, user's extra-CLI-args or shell import. */
export function workflowCliCommand(manifest: WorkflowLaunchManifest, binary: string, schemaPath: string, lastMessagePath: string): string[] {
  const writable = manifest.stage === "implementation" || manifest.stage === "validation";
  if (manifest.kind === "codex") {
    const args = [binary, "exec", "--json", "--color", "never", "--skip-git-repo-check",
      "--ignore-user-config", "--ignore-rules", "--disable", "multi_agent", "--disable", "multi_agent_v2",
      "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "-c", "agents.enabled=false",
      "--sandbox", writable ? "workspace-write" : "read-only", "-c", "approval_policy=never",
      "--output-schema", schemaPath, "--output-last-message", lastMessagePath];
    if (manifest.model) args.push("--model", manifest.model);
    if (manifest.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(manifest.effort)}`);
    args.push("-");
    return args;
  }
  const tools = writable ? "Read,Glob,Grep,Bash,Edit,Write" : "Read,Glob,Grep,Bash";
  const args = [binary, "--print", "--verbose", "--output-format", "stream-json",
    "--json-schema", JSON.stringify(WORKFLOW_RESULT_SCHEMA), "--safe-mode", "--strict-mcp-config",
    "--mcp-config", "{\"mcpServers\":{}}", "--tools", tools,
    "--disallowedTools", "Agent,Task,TaskCreate,TaskUpdate,TeamCreate,SendMessage,AskUserQuestion",
    "--permission-mode", writable ? "acceptEdits" : "plan", "--permission-prompts", "none"];
  if (manifest.model) args.push("--model", toClaudeModelArg(manifest.model));
  if (manifest.effort) args.push("--effort", manifest.effort);
  return args;
}

export function workflowPrompt(manifest: WorkflowLaunchManifest): string {
  return manifest.prompt + "\n\nKANAME workflow execution contract:\n"
    + "Work alone. Do not spawn, delegate to, or invoke other coding agents. Do not push, publish a PR, merge, notify externally, or change Git remotes/history. "
    + "Return a final JSON object matching the supplied schema. Use needs_input with concrete questions when a required decision, permission, or tool is unavailable, then stop. "
    + "Do not wait for a person, poll indefinitely, invent approvals, or work around denied permissions. An unmet acceptance condition is a failure, not a separate follow-up. "
    + "Use changes_requested for review findings requiring implementation changes. Use quota for a provider quota error. "
    + "Use null for inapplicable requirements/validationPassed/reviewPassed and [] for questions.\n";
}
