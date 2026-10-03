-- Development Issues are deliberately separate from legacy ad-hoc Tasks.
CREATE TABLE workflow_issues (
  id TEXT PRIMARY KEY, project_path TEXT NOT NULL, status TEXT NOT NULL,
  generation INTEGER NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX workflow_issues_project_status ON workflow_issues(project_path, status);
CREATE TABLE workflow_attempts (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES workflow_issues(id),
  status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX workflow_attempts_issue_status ON workflow_attempts(issue_id, status);
CREATE UNIQUE INDEX workflow_attempts_one_active ON workflow_attempts(issue_id) WHERE status <> 'settled';
CREATE TABLE workflow_requests (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES workflow_issues(id),
  status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX workflow_requests_pending ON workflow_requests(status, issue_id);
CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES workflow_issues(id), data TEXT NOT NULL
);
CREATE TABLE workflow_jobs (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES workflow_issues(id),
  generation INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  available_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL, error TEXT
);
CREATE INDEX workflow_jobs_pending ON workflow_jobs(status, available_at);
CREATE TABLE workflow_reservations (
  attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),
  issue_id TEXT NOT NULL REFERENCES workflow_issues(id), day TEXT NOT NULL,
  timezone TEXT NOT NULL, reserved_ms INTEGER NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (attempt_id, day, timezone)
);
CREATE TABLE workflow_usage (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),
  issue_id TEXT NOT NULL REFERENCES workflow_issues(id),
  started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, charged_ms INTEGER NOT NULL
);
CREATE TABLE workflow_notifications (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES workflow_issues(id),
  request_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE workflow_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE workflow_commands (
  key TEXT PRIMARY KEY, operation TEXT NOT NULL, issue_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, result TEXT NOT NULL
);
