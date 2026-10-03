import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import sql from "./migrations/062_development_workflows.sql" with { type: "text" };
import { WorkflowEngine } from "./workflow-engine.ts";
import { migrate } from "./migrate.ts";
import type { WorkflowGit } from "../shared/development-workflow.ts";

const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function setup(){
  const db=new Database(":memory:");databases.push(db);db.exec("PRAGMA foreign_keys=ON");migrate(db,[{id:"062_development_workflows",sql}]);
  const engine=new WorkflowEngine(db,{artifactRoot:"/tmp/unused-workflow",runner:{async start(){throw new Error("unused");},async stop(){throw new Error("unused");},async inspect(){return {status:"unknown"};}},git:{} as WorkflowGit});
  engine.setProjectSettings("/tmp/demo",{model:"test-model",effort:"low"});
  return {db,engine};
}
test("migration is repeatable and does not introduce legacy task data",()=>{
  const {db}=setup();expect(migrate(db,[{id:"062_development_workflows",sql}])).toEqual([]);
  expect(db.query("SELECT count(*) AS count FROM workflow_issues").get()).toEqual({count:0});
  expect(db.query("SELECT name FROM sqlite_master WHERE name='tasks'").get()).toBeNull();
});
test("Ready and its durable job roll back together",()=>{
  const {db,engine}=setup(),issue=engine.createIssue({projectPath:"/tmp/demo",goal:"Test atomic start"});
  db.exec("CREATE TRIGGER deny_job BEFORE INSERT ON workflow_jobs BEGIN SELECT RAISE(ABORT, 'injected job failure'); END");
  expect(()=>engine.ready(issue.id,{revision:issue.revision})).toThrow("injected job failure");
  expect(engine.getDetail(issue.id).issue).toEqual(issue);expect(engine.store.jobs()).toHaveLength(0);
});
test("stop state and inbox/outbox commit atomically",()=>{
  const {db,engine}=setup(),issue=engine.createIssue({projectPath:"/tmp/demo",goal:"Test atomic stop"});
  db.exec("CREATE TRIGGER deny_notification BEFORE INSERT ON workflow_notifications BEGIN SELECT RAISE(ABORT, 'injected notification failure'); END");
  expect(()=>engine.stop(issue.id,{revision:issue.revision})).toThrow("injected notification failure");
  expect(engine.getDetail(issue.id).issue).toEqual(issue);expect(engine.inbox()).toHaveLength(0);
});
test("command idempotency binds payload, operation and Issue",()=>{
  const {engine}=setup(),a=engine.createIssue({projectPath:"/tmp/demo",goal:"A"}),b=engine.createIssue({projectPath:"/tmp/demo",goal:"B"});
  const command={revision:a.revision,idempotencyKey:"one-command"},ready=engine.ready(a.id,command);
  expect(engine.ready(a.id,command)).toEqual(ready);expect(engine.store.jobs()).toHaveLength(1);
  expect(()=>engine.ready(b.id,command)).toThrow("different request");
  expect(()=>engine.stop(a.id,{revision:ready.revision,idempotencyKey:"one-command"})).toThrow("different request");
});
test("database rejects a second live attempt while allowing settled attempt history",()=>{
  const {db,engine}=setup(),issue=engine.createIssue({projectPath:"/tmp/demo",goal:"One worker at a time"});
  db.run("INSERT INTO workflow_attempts VALUES(?,?,'reserved','{}')",["first",issue.id]);
  expect(()=>db.run("INSERT INTO workflow_attempts VALUES(?,?,'unknown','{}')",["second",issue.id])).toThrow("UNIQUE");
  db.run("UPDATE workflow_attempts SET status='settled' WHERE id='first'");
  db.run("INSERT INTO workflow_attempts VALUES(?,?,'running','{}')",["second",issue.id]);
  db.run("INSERT INTO workflow_attempts VALUES(?,?,'settled','{}')",["historical",issue.id]);
  expect(db.query("SELECT count(*) AS count FROM workflow_attempts WHERE issue_id=?").get(issue.id)).toEqual({count:3});
});
test("an attempt reserves separate days once and releases every slice together",()=>{
  const {db,engine}=setup(),issue=engine.createIssue({projectPath:"/tmp/demo",goal:"Reserve across midnight"});
  db.run("INSERT INTO workflow_attempts VALUES(?,?,'reserved','{}')",["night",issue.id]);
  engine.store.reserve("night",issue.id,"2026-10-02","UTC",10_000);
  engine.store.reserve("night",issue.id,"2026-10-03","UTC",20_000);
  expect(()=>engine.store.reserve("night",issue.id,"2026-10-03","UTC",1000)).toThrow("UNIQUE");
  expect(engine.store.reservations().map(r=>r.reserved_ms)).toEqual([10_000,20_000]);
  engine.store.release("night");expect(engine.store.reservations()).toHaveLength(0);
  expect(db.query("SELECT count(*) AS count FROM workflow_reservations WHERE status='settled'").get()).toEqual({count:2});
});
