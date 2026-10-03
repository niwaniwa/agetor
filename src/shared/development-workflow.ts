/** KANAME's durable development workflow; independent of legacy Task/Run. */
export type WorkflowAgentKind = "codex" | "claude-code";
export type WorkflowStage = "research" | "implementation" | "validation" | "review" | "publish" | "approval" | "merge";
export type WorkflowAgentStage = Extract<WorkflowStage, "research" | "implementation" | "validation" | "review">;
export type WorkflowStatus = "backlog" | "ready" | "running" | "waiting" | "stopped" | "cancelled" | "done";
export type WorkflowStopReason = "human" | "manual" | "budget" | "failure" | "recovery" | "configuration" | "quota";

export interface WorkflowSettings {
  parentBudgetMs: number;
  dailyBudgetMs: number;
  timezone: string;
  maxActiveIssues: number;
  maxActivePerProject: number;
  maxAgents: number;
  attemptTimeoutMs: number;
  maxRetries: number;
}
export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  parentBudgetMs: 2 * 60 * 60_000, dailyBudgetMs: 6 * 60 * 60_000, timezone: "UTC",
  maxActiveIssues: 2, maxActivePerProject: 1, maxAgents: 3,
  attemptTimeoutMs: 30 * 60_000, maxRetries: 2,
};
export interface WorkflowProjectSettings {
  projectPath: string;
  remote: string;
  baseBranch: string;
  validationCommands: string[];
  agent: WorkflowAgentKind;
  model: string | null;
  effort: string | null;
  /** Explicitly configured GitHub writes; tests supply a mock adapter. */
  githubEnabled: boolean;
  attemptTimeoutMs: number | null;
}
export interface WorkflowRequirements {
  purpose: string;
  scope: string;
  outOfScope: string;
  acceptanceCriteria: string[];
  approach: string;
  assumptions: string[];
}
export interface WorkflowQuestionInput {
  question: string;
  recommended: string;
  alternatives: string[];
  impact: string;
}
export interface WorkflowAgentResult {
  status: "completed" | "question" | "needs_input" | "changes_requested" | "failed" | "quota";
  summary: string;
  requirements?: WorkflowRequirements;
  questions?: WorkflowQuestionInput[];
  validationPassed?: boolean;
  /** Actual worker-executed commands; never accepted from the agent's JSON. */
  validationReports?: { command: string; exitCode: number; startedAt: number; endedAt: number }[];
  reviewPassed?: boolean;
}
export interface WorkflowLaunchManifest {
  attemptId: string;
  issueId: string;
  stage: WorkflowAgentStage;
  artifactDir: string;
  cwd: string;
  kind: WorkflowAgentKind;
  model: string | null;
  effort: string | null;
  prompt: string;
  validationCommands?: string[];
  /** Interrupt at stopAt, ensure process is dead by deadlineAt. */
  stopAt: number;
  deadlineAt: number;
}
export interface WorkflowRunnerObservation {
  status: "running" | "stopped" | "unknown";
  startedAt?: number;
  endedAt?: number;
  result?: WorkflowAgentResult;
  logs?: string;
  error?: string;
}
export interface WorkflowRunner {
  start(manifest: WorkflowLaunchManifest): Promise<void>;
  inspect(attemptId: string): Promise<WorkflowRunnerObservation>;
  stop(attemptId: string): Promise<void>;
}

export interface WorkflowWorkspace {
  workdir: string;
  branch: string;
  baseSha: string;
  headSha: string;
  repository: string;
}
export interface WorkflowGitContext {
  operationId: string;
  issueId: string;
  projectPath: string;
  remote: string;
  baseBranch: string;
  workspace?: WorkflowWorkspace;
}
export interface WorkflowPullRequest {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
  mergeable: boolean | null;
  checks: "pending" | "passed" | "failed";
  reviewDecision: "approved" | "changes_requested" | "required" | "none";
  /** False distinguishes an absent CI setup from reported successful checks. */
  checksReported?: boolean;
  /** Active latest decisive changes-requested reviews, for repair deduplication. */
  changesRequestedReviewIds?: number[];
  feedback?: string[];
  mergeableState?: string;
}
export interface WorkflowGit {
  prepare(context: WorkflowGitContext): Promise<WorkflowWorkspace>;
  checkpoint(context: WorkflowGitContext & { summary: string }): Promise<WorkflowWorkspace>;
  publish(context: WorkflowGitContext & { title: string; body: string }): Promise<WorkflowPullRequest>;
  inspect(context: WorkflowGitContext & { pullRequest: WorkflowPullRequest }): Promise<WorkflowPullRequest>;
  merge(context: WorkflowGitContext & { pullRequest: WorkflowPullRequest; approvedSha: string; validatedSha: string }): Promise<WorkflowPullRequest>;
  verify(context: WorkflowGitContext & { expectedSha: string }): Promise<void>;
  diff(context: WorkflowGitContext): Promise<string>;
}

export interface DevelopmentIssue {
  id: string;
  projectPath: string;
  title: string;
  goal: string;
  status: WorkflowStatus;
  stage: WorkflowStage;
  revision: number;
  generation: number;
  requirementsVersion: number;
  settings: WorkflowProjectSettings;
  workspace: WorkflowWorkspace | null;
  pullRequest: WorkflowPullRequest | null;
  validatedSha: string | null;
  approvedSha: string | null;
  stopReasons: WorkflowStopReason[];
  message: string | null;
  consumedMs: number;
  createdAt: number;
  updatedAt: number;
}
export interface WorkflowAttempt {
  id: string;
  issueId: string;
  generation: number;
  stage: WorkflowAgentStage;
  requirementsVersion: number;
  status: "reserved" | "running" | "settled" | "unknown";
  manifest: WorkflowLaunchManifest;
  reservedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  result: WorkflowAgentResult | null;
  error: string | null;
  chargedMs: number;
}
export interface WorkflowHumanRequest {
  id: string;
  issueId: string;
  kind: "question" | "approval" | "attention";
  generation: number;
  requirementsVersion: number;
  stage: WorkflowStage;
  question: WorkflowQuestionInput;
  headSha: string | null;
  status: "pending" | "answered" | "approved" | "rejected" | "superseded";
  answer: string | null;
  createdAt: number;
  resolvedAt: number | null;
}
export interface WorkflowArtifact {
  id: string;
  issueId: string;
  kind: "requirements" | "validation" | "review" | "event";
  version: number;
  attemptId: string | null;
  headSha: string | null;
  content: string;
  createdAt: number;
}
export interface WorkflowNotification {
  id: string;
  issueId: string;
  requestId: string | null;
  kind: "question" | "approval" | "stopped" | "budget-warning" | "done";
  summary: string;
  status: "unconfigured" | "pending" | "sent" | "failed" | "suppressed";
  tries: number;
  createdAt: number;
}
export interface WorkflowDetail {
  issue: DevelopmentIssue;
  attempts: WorkflowAttempt[];
  requests: WorkflowHumanRequest[];
  artifacts: WorkflowArtifact[];
  notifications: WorkflowNotification[];
}
export interface WorkflowCreateInput { projectPath: string; title?: string; goal: string }
export interface WorkflowMutation { revision: number; idempotencyKey?: string }
export interface WorkflowAnswerInput extends WorkflowMutation { answer: string }
export interface WorkflowApprovalInput extends WorkflowMutation { headSha: string }
export interface WorkflowBudgetSummary { day: string; timezone: string; usedMs: number; reservedMs: number; limitMs: number }

export class WorkflowError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "WorkflowError"; }
}
