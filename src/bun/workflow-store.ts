import type { Database } from "bun:sqlite";
import type { DevelopmentIssue, WorkflowArtifact, WorkflowAttempt, WorkflowHumanRequest, WorkflowNotification } from "../shared/development-workflow.ts";

export interface WorkflowJob {
  id: string; issueId: string; generation: number;
  kind: "prepare" | "launch" | "checkpoint" | "publish" | "inspect" | "merge" | "stop";
  status: "pending" | "working" | "done" | "failed";
  availableAt: number; tries: number; payload: Record<string, unknown>; error: string | null;
}
type DataRow = { data: string };
export interface Reservation { attempt_id: string; issue_id: string; day: string; timezone: string; reserved_ms: number; status: string }
export interface Usage { attempt_id: string; issue_id: string; started_at: number; ended_at: number; charged_ms: number }
const parse = <T>(row: DataRow | null): T | null => row ? JSON.parse(row.data) as T : null;

/** Synchronous primitives: callers own the transaction that combines state,
 * jobs, reservations and inbox notifications. No callbacks or external IO. */
export class WorkflowStore {
  constructor(readonly db: Database) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  issue(id: string): DevelopmentIssue | null { return parse(this.db.query<DataRow, [string]>("SELECT data FROM workflow_issues WHERE id=?").get(id)); }
  issues(): DevelopmentIssue[] { return this.db.query<DataRow, []>("SELECT data FROM workflow_issues ORDER BY rowid DESC").all().map(r => JSON.parse(r.data)); }
  saveIssue(i: DevelopmentIssue): void {
    this.db.run("INSERT INTO workflow_issues(id,project_path,status,generation,revision,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path,status=excluded.status,generation=excluded.generation,revision=excluded.revision,data=excluded.data", [i.id,i.projectPath,i.status,i.generation,i.revision,JSON.stringify(i)]);
  }
  attempts(issueId?: string): WorkflowAttempt[] { return this.rows<WorkflowAttempt>("workflow_attempts", issueId); }
  attempt(id: string): WorkflowAttempt | null { return parse(this.db.query<DataRow,[string]>("SELECT data FROM workflow_attempts WHERE id=?").get(id)); }
  saveAttempt(a: WorkflowAttempt): void { this.db.run("INSERT INTO workflow_attempts(id,issue_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", [a.id,a.issueId,a.status,JSON.stringify(a)]); }
  requests(issueId?: string): WorkflowHumanRequest[] { return this.rows<WorkflowHumanRequest>("workflow_requests",issueId); }
  request(id:string): WorkflowHumanRequest | null { return parse(this.db.query<DataRow,[string]>("SELECT data FROM workflow_requests WHERE id=?").get(id)); }
  saveRequest(r:WorkflowHumanRequest): void { this.db.run("INSERT INTO workflow_requests(id,issue_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", [r.id,r.issueId,r.status,JSON.stringify(r)]); }
  artifacts(issueId: string): WorkflowArtifact[] { return this.rows<WorkflowArtifact>("workflow_artifacts",issueId); }
  artifact(a:WorkflowArtifact): void { this.db.run("INSERT OR IGNORE INTO workflow_artifacts(id,issue_id,data) VALUES(?,?,?)",[a.id,a.issueId,JSON.stringify(a)]); }
  notifications(issueId?:string):WorkflowNotification[] { return this.rows<WorkflowNotification>("workflow_notifications",issueId); }
  notification(n:WorkflowNotification):void { this.db.run("INSERT INTO workflow_notifications(id,issue_id,request_id,kind,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [n.id,n.issueId,n.requestId,n.kind,JSON.stringify(n)]); }
  private rows<T>(table:"workflow_attempts"|"workflow_requests"|"workflow_artifacts"|"workflow_notifications",issueId?:string):T[] {
    const rows=issueId === undefined ? this.db.query<DataRow,[]>(`SELECT data FROM ${table} ORDER BY rowid`).all() : this.db.query<DataRow,[string]>(`SELECT data FROM ${table} WHERE issue_id=? ORDER BY rowid`).all(issueId);
    return rows.map(r=>JSON.parse(r.data) as T);
  }
  getSetting<T>(key:string):T|null { return parse(this.db.query<DataRow,[string]>("SELECT data FROM workflow_settings WHERE key=?").get(key)); }
  setSetting(key:string,data:unknown):void { this.db.run("INSERT INTO workflow_settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[key,JSON.stringify(data)]); }
  job(j:WorkflowJob):void { this.db.run("INSERT INTO workflow_jobs(id,issue_id,generation,kind,status,available_at,tries,payload,error) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,status=excluded.status,available_at=excluded.available_at,tries=excluded.tries,payload=excluded.payload,error=excluded.error",[j.id,j.issueId,j.generation,j.kind,j.status,j.availableAt,j.tries,JSON.stringify(j.payload),j.error]); }
  jobs():WorkflowJob[] {
    return this.db.query<{id:string;issue_id:string;generation:number;kind:WorkflowJob["kind"];status:WorkflowJob["status"];available_at:number;tries:number;payload:string;error:string|null},[]>("SELECT * FROM workflow_jobs ORDER BY rowid").all().map(r=>({id:r.id,issueId:r.issue_id,generation:r.generation,kind:r.kind,status:r.status,availableAt:r.available_at,tries:r.tries,payload:JSON.parse(r.payload),error:r.error}));
  }
  reservations():Reservation[] { return this.db.query<Reservation,[]>("SELECT * FROM workflow_reservations WHERE status='active'").all(); }
  reserve(attemptId:string,issueId:string,day:string,timezone:string,reservedMs:number):void { this.db.run("INSERT INTO workflow_reservations VALUES(?,?,?,?,?,'active')",[attemptId,issueId,day,timezone,reservedMs]); }
  release(attemptId:string):void { this.db.run("UPDATE workflow_reservations SET status='settled' WHERE attempt_id=?",[attemptId]); }
  usage():Usage[] { return this.db.query<Usage,[]>("SELECT * FROM workflow_usage").all(); }
  charge(a:WorkflowAttempt,startedAt:number,endedAt:number):void { this.db.run("INSERT OR IGNORE INTO workflow_usage VALUES(?,?,?,?,?)",[a.id,a.issueId,startedAt,endedAt,Math.max(0,endedAt-startedAt)]); }
  command(key:string):{operation:string;issue_id:string;fingerprint:string;result:string}|null { return this.db.query<{operation:string;issue_id:string;fingerprint:string;result:string},[string]>("SELECT operation,issue_id,fingerprint,result FROM workflow_commands WHERE key=?").get(key); }
  saveCommand(key:string,operation:string,issueId:string,fingerprint:string,result:unknown):void { this.db.run("INSERT INTO workflow_commands VALUES(?,?,?,?,?)",[key,operation,issueId,fingerprint,JSON.stringify(result)]); }
}
