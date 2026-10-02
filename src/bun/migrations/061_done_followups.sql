-- Durable, per-run follow-up candidates collected from a normal Codex or
-- Claude Code task.  The task-level switch is intentionally separate from
-- the run snapshot: changing the switch later must not rewrite what an
-- already-started run was instructed to produce.
ALTER TABLE tasks ADD COLUMN done_followups_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN done_followups_enabled INTEGER NOT NULL DEFAULT 0;

-- Do not use foreign keys for these history records.  A user may delete a
-- source or generated task after a follow-up was recorded; the durable record
-- must still explain what happened, while the processor rechecks live task
-- state before it creates anything.
CREATE TABLE done_followup_collections (
  run_id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('collected', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_done_followup_collections_source_task
  ON done_followup_collections(source_task_id, created_at DESC);

CREATE TABLE done_followup_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, ordinal)
);

CREATE INDEX idx_done_followup_candidates_run
  ON done_followup_candidates(run_id, ordinal);

-- One request per source run prevents Done replays, double clicks, and
-- concurrent browser tabs from scheduling the same candidate set twice.
CREATE TABLE done_followup_requests (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'suppressed')),
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_done_followup_requests_recovery
  ON done_followup_requests(status, created_at);

-- candidate_id is primary-keyed: even if a request is replayed after a
-- restart, a candidate can map to at most one generated task.  The generated
-- id deliberately has no FK so deletion of that task leaves the audit link.
CREATE TABLE done_followup_generated_tasks (
  candidate_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  generated_task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_done_followup_generated_source
  ON done_followup_generated_tasks(source_task_id, created_at);
CREATE INDEX idx_done_followup_generated_task
  ON done_followup_generated_tasks(generated_task_id);
