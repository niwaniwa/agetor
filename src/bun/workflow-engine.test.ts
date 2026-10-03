import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import sql from "./migrations/062_development_workflows.sql" with { type: "text" };
import { WorkflowEngine, workflowDayWindow } from "./workflow-engine.ts";
import type { WorkflowAgentResult, WorkflowGit, WorkflowLaunchManifest, WorkflowPullRequest, WorkflowRunnerObservation, WorkflowStage } from "../shared/development-workflow.ts";

const DBs:Database[]=[];
afterEach(()=>{for(const db of DBs.splice(0))db.close();});
const requirements={purpose:"Add a counter",scope:"Counter API",outOfScope:"No auth change",acceptanceCriteria:["GET returns counter"],approach:"Reuse existing server",assumptions:["Single process"]};
function fixture(){
  const db=new Database(":memory:");DBs.push(db);db.exec(sql);
  let now=Date.UTC(2026,9,2,12);const states=new Map<string,WorkflowRunnerObservation>(),starts:WorkflowLaunchManifest[]=[],stops:string[]=[];
  let pr:WorkflowPullRequest={number:1,url:"https://github.example/test/repo/pull/1",headSha:"b".repeat(40),baseBranch:"main",state:"open",mergeable:true,checks:"passed",reviewDecision:"none"};
  let publishes=0,merges=0,verifications=0;
  const workspace={workdir:"/tmp/mock-worktree",branch:"kaname/test",baseSha:"a".repeat(40),headSha:"a".repeat(40),repository:"test/repo"};
  const git:WorkflowGit={
    async prepare(){return {...workspace};},async checkpoint(){return {...workspace,headSha:"b".repeat(40)};},
    async publish(){publishes++;return {...pr};},async inspect(){return {...pr};},async merge(){merges++;pr={...pr,state:"merged"};return {...pr};},
    async verify(){verifications++;},async diff(){return "diff --git a/counter b/counter";},
  };
  const runner={
    async start(m:WorkflowLaunchManifest){if(states.has(m.attemptId))return;starts.push(m);states.set(m.attemptId,{status:"running",startedAt:now});},
    async inspect(id:string){return states.get(id)??{status:"unknown" as const};},
    async stop(id:string){stops.push(id);const old=states.get(id);states.set(id,{status:"stopped",startedAt:old?.startedAt??now,endedAt:now,error:"stopped"});},
  };
  const deps={runner,git,artifactRoot:"/tmp/mock-artifacts",clock:()=>now,projectExists:(p:string)=>p.startsWith("/projects/")};
  const engine=new WorkflowEngine(db,deps);
  engine.setProjectSettings("/projects/demo",{validationCommands:["bun test"],githubEnabled:true,model:"test-model",effort:"low"});
  const create=(projectPath="/projects/demo")=>{
    if(projectPath.startsWith("/projects/")&&projectPath!=="/projects/demo")engine.setProjectSettings(projectPath,{model:"test-model",effort:"low"});
    return engine.createIssue({projectPath,goal:"Add counter"});
  };
  const finish=(result:WorkflowAgentResult)=>{const m=starts.at(-1)!;const old=states.get(m.attemptId)!;now+=1000;
    if(m.stage==="validation")result={...result,validationReports:m.validationCommands!.map(command=>({command,exitCode:result.validationPassed?0:1,startedAt:old.startedAt!,endedAt:now}))};
    states.set(m.attemptId,{status:"stopped",startedAt:old.startedAt,endedAt:now,result});};
  const until=async(id:string,predicate:()=>boolean)=>{for(let n=0;n<20&&!predicate();n++)await engine.tick();expect(predicate()).toBe(true);return engine.getDetail(id).issue;};
  const stage=async(id:string,stage:WorkflowStage)=>until(id,()=>engine.getDetail(id).issue.stage===stage&&engine.getDetail(id).issue.status==="running");
  async function toApproval(id:string){
    await stage(id,"research");finish({status:"completed",summary:"Requirements ready",requirements});
    await stage(id,"implementation");finish({status:"completed",summary:"Counter implemented"});
    await stage(id,"validation");finish({status:"completed",summary:"Tests passed",validationPassed:true});
    await stage(id,"review");finish({status:"completed",summary:"Review passed",reviewPassed:true});
    return until(id,()=>engine.getDetail(id).issue.stage==="approval"&&engine.getDetail(id).issue.status==="waiting");
  }
  return {db,engine,deps,runner,git,states,starts,stops,create,finish,stage,until,toApproval,setNow:(t:number)=>{now=t;},advance:(ms:number)=>{now+=ms;},now:()=>now,setPr:(patch:Partial<WorkflowPullRequest>)=>{pr={...pr,...patch};},counts:()=>({publishes,merges,verifications})};
}

describe("durable development workflows",()=>{
  test("Backlog is inert; Ready completes research/code/validation/review and requires exact-SHA approval",async()=>{
    const f=fixture(),issue=f.create();await f.engine.tick();expect(f.starts).toHaveLength(0);
    f.engine.ready(issue.id,{revision:issue.revision});const review=await f.toApproval(issue.id);
    expect(f.counts().publishes).toBe(1);expect(f.counts().merges).toBe(0);expect(review.validatedSha).toBe("b".repeat(40));
    expect(f.starts.every(m=>m.kind==="codex"&&m.cwd==="/tmp/mock-worktree")).toBe(true);
    expect(f.starts.find(m=>m.stage==="validation")?.validationCommands).toEqual(["bun test"]);
    expect(()=>f.engine.approve(issue.id,{revision:review.revision,headSha:"a".repeat(40)})).toThrow("target changed");
    f.engine.approve(issue.id,{revision:review.revision,headSha:review.validatedSha!});await f.engine.tick();
    expect(f.engine.getDetail(issue.id).issue.status).toBe("done");expect(f.counts().merges).toBe(1);expect(f.counts().verifications).toBe(4);
  });
  test("questions persist across restart, duplicate/old answers are rejected, time does not accrue while waiting",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.finish({status:"needs_input",summary:"Need a compatibility decision",requirements,questions:[{question:"Preserve old API?",recommended:"Preserve",alternatives:["Break it"],impact:"Affects clients"}]});await f.engine.tick();
    const pending=f.engine.getDetail(issue.id),request=pending.requests[0]!;expect(pending.issue.status).toBe("waiting");
    const afterRestart=new WorkflowEngine(f.db,f.deps);f.advance(60*60_000);await afterRestart.reconcile();
    expect(afterRestart.getDetail(issue.id).issue.consumedMs).toBe(1000);expect(f.starts).toHaveLength(1);
    const input={revision:pending.issue.revision,answer:"Preserve",idempotencyKey:"answer-once"};
    const answered=afterRestart.answer(issue.id,request.id,input);expect(afterRestart.answer(issue.id,request.id,input)).toEqual(answered);
    expect(()=>afterRestart.answer(issue.id,request.id,{revision:answered.revision,answer:"Break"})).toThrow("stale");
    await afterRestart.tick();expect(f.starts).toHaveLength(2);expect(f.starts[1]?.prompt).toContain("Preserve");
  });
  test("manual stop survives answering a pending question",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.finish({status:"question",summary:"Question",questions:[{question:"What protocol?",recommended:"HTTP",alternatives:["RPC"],impact:"API shape"}]});await f.engine.tick();
    let detail=f.engine.getDetail(issue.id);f.engine.stop(issue.id,{revision:detail.issue.revision});detail=f.engine.getDetail(issue.id);
    f.engine.answer(issue.id,detail.requests.find(r=>r.kind==="question")!.id,{revision:detail.issue.revision,answer:"HTTP"});await f.engine.tick();
    expect(f.engine.getDetail(issue.id).issue.status).toBe("stopped");expect(f.starts).toHaveLength(1);
  });
  test("cancel fences delayed successful results and charges elapsed time once",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    let current=f.engine.getDetail(issue.id).issue;f.engine.cancel(issue.id,{revision:current.revision});
    f.finish({status:"completed",summary:"Late success",requirements});await f.engine.tick();await f.engine.reconcile();
    current=f.engine.getDetail(issue.id).issue;expect(current.status).toBe("cancelled");expect(current.consumedMs).toBe(1000);expect(f.starts).toHaveLength(1);
  });
  test("cancel stays terminal when late observations are unknown or past deadline",async()=>{
    for(const status of ["unknown","running"] as const){
      const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
      const current=f.engine.getDetail(issue.id).issue;f.engine.cancel(issue.id,{revision:current.revision});
      f.states.set(f.starts[0]!.attemptId,{status,error:"unit unavailable"});f.runner.stop=async()=>{throw new Error("unit unavailable");};
      f.advance(31*60_000);await f.engine.tick();await f.engine.tick();
      const stopped=f.engine.getDetail(issue.id).issue;expect(stopped.status).toBe("cancelled");expect(()=>f.engine.resume(issue.id,{revision:stopped.revision})).toThrow("only stopped");
    }
  });
  test("stop/resume fences an earlier in-flight Git prepare callback",async()=>{
    const f=fixture(),issue=f.create();let release:()=>void=()=>{};let called=false;
    const original=f.git.prepare;f.git.prepare=async context=>{called=true;await new Promise<void>(resolve=>{release=resolve;});return original(context);};
    f.engine.ready(issue.id,{revision:issue.revision});const tick=f.engine.tick();
    for(let i=0;i<10&&!called;i++)await Promise.resolve();expect(called).toBe(true);
    let current=f.engine.getDetail(issue.id).issue;f.engine.stop(issue.id,{revision:current.revision});current=f.engine.getDetail(issue.id).issue;
    f.engine.resume(issue.id,{revision:current.revision});release();await tick;
    expect(f.engine.getDetail(issue.id).issue.workspace).toBeNull();expect(f.starts).toHaveLength(0);
    f.git.prepare=original;await f.stage(issue.id,"research");expect(f.starts).toHaveLength(1);
  });
  for(const action of ["stop","cancel"] as const)test(`${action} dispatches its durable worker stop while another Issue's Git request is blocked`,async()=>{
    const f=fixture(),a=f.create();f.engine.ready(a.id,{revision:a.revision});await f.stage(a.id,"research");
    let release:()=>void=()=>{},entered:()=>void=()=>{};
    const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const original=f.git.prepare;f.git.prepare=async context=>{entered();await blocked;return original(context);};
    const b=f.create("/projects/second");f.engine.ready(b.id,{revision:b.revision});const busy=f.engine.tick();await started;
    try{
      const command={revision:f.engine.getDetail(a.id).issue.revision,idempotencyKey:`${action}-while-git-waits`};
      const stopped=f.engine[action](a.id,command);expect(f.engine[action](a.id,command)).toEqual(stopped);
      expect(f.stops).toEqual([f.starts[0]!.attemptId]);
      expect(f.engine.store.jobs().filter(j=>j.issueId===a.id&&j.kind==="stop")).toHaveLength(1);
      expect(f.engine.getDetail(a.id).issue.status).toBe(action==="stop"?"stopped":"cancelled");
      expect(f.engine.store.jobs().find(j=>j.issueId===b.id&&j.kind==="prepare")?.status).toBe("working");
    }finally{release();await busy;await f.engine.tick();}
    expect(f.engine.getDetail(a.id).attempts[0]!.status).toBe("settled");
  });
  test("publish in flight rejects stop/cancel until its external write is confirmed",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.finish({status:"completed",summary:"Plan",requirements});await f.stage(issue.id,"implementation");f.finish({status:"completed",summary:"Code"});
    await f.stage(issue.id,"validation");f.finish({status:"completed",summary:"Validated",validationPassed:true});await f.stage(issue.id,"review");
    let release:()=>void=()=>{},entered:()=>void=()=>{};
    const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const original=f.git.publish;f.git.publish=async context=>{entered();await blocked;return original(context);};
    f.finish({status:"completed",summary:"Reviewed",reviewPassed:true});const busy=f.engine.tick();await started;
    try{
      const current=f.engine.getDetail(issue.id).issue;
      expect(()=>f.engine.stop(issue.id,{revision:current.revision})).toThrow("publish request is in flight");
      expect(()=>f.engine.cancel(issue.id,{revision:current.revision})).toThrow("publish request is in flight");
      expect(f.engine.getDetail(issue.id).issue).toEqual(current);
    }finally{release();await busy;}
    const current=f.engine.getDetail(issue.id).issue;expect(current.pullRequest?.number).toBe(1);
    expect(f.engine.stop(issue.id,{revision:current.revision}).status).toBe("stopped");
  });
  test("cancel while runner start rejects cannot resurrect the Issue",async()=>{
    const f=fixture(),issue=f.create();let reject:(error:Error)=>void=()=>{};let called=false;
    f.runner.start=async()=>{called=true;await new Promise<void>((_,r)=>{reject=r;});};
    f.engine.ready(issue.id,{revision:issue.revision});await f.engine.tick();const tick=f.engine.tick();
    for(let i=0;i<10&&!called;i++)await Promise.resolve();expect(called).toBe(true);
    const current=f.engine.getDetail(issue.id).issue;f.engine.cancel(issue.id,{revision:current.revision});reject(new Error("late start timeout"));await tick;
    expect(f.engine.getDetail(issue.id).issue.status).toBe("cancelled");
  });
  test("human question rounds do not exhaust automatic failure retries",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});
    for(let n=0;n<3;n++){
      await f.stage(issue.id,"research");f.finish({status:"needs_input",summary:"Need input",questions:[{question:`Choice ${n}`,recommended:"A",alternatives:["B"],impact:"Scope"}]});await f.engine.tick();
      const d=f.engine.getDetail(issue.id),q=d.requests.find(r=>r.status==="pending")!;
      f.engine.answer(issue.id,q.id,{revision:d.issue.revision,answer:"A"});
    }
    await f.stage(issue.id,"research");f.finish({status:"failed",summary:"Transient read error"});await f.engine.tick();
    expect(f.engine.getDetail(issue.id).issue.status).toBe("running");expect(f.starts).toHaveLength(5);
  });
  for(const {stage,manualStop} of [{stage:"implementation",manualStop:false},{stage:"validation",manualStop:false},{stage:"review",manualStop:false},{stage:"review",manualStop:true}] as const)
  test(`${stage} answers return to research and version requirements${manualStop?" without overriding manual stop":""}`,async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.finish({status:"completed",summary:"Initial plan",requirements});await f.stage(issue.id,"implementation");
    if(stage!=="implementation"){f.finish({status:"completed",summary:"Initial code"});await f.stage(issue.id,"validation");}
    if(stage==="review"){f.finish({status:"completed",summary:"Initial validation",validationPassed:true});await f.stage(issue.id,"review");}
    f.finish({status:"needs_input",summary:"New scope decisions",questions:[
      {question:"Add reset?",recommended:"Include",alternatives:["Defer"],impact:"Changes scope"},
      {question:"Reset endpoint?",recommended:"POST",alternatives:["DELETE"],impact:"Changes acceptance criteria"},
    ]});await f.engine.tick();
    let detail=f.engine.getDetail(issue.id);const questions=detail.requests.filter(r=>r.kind==="question"&&r.status==="pending"),starts=f.starts.length;
    f.engine.answer(issue.id,questions[0]!.id,{revision:detail.issue.revision,answer:"Include reset"});
    detail=f.engine.getDetail(issue.id);expect(detail.issue.stage).toBe(stage);expect(detail.issue.requirementsVersion).toBe(1);
    if(manualStop){f.engine.stop(issue.id,{revision:detail.issue.revision});detail=f.engine.getDetail(issue.id);}
    const answered=f.engine.answer(issue.id,questions[1]!.id,{revision:detail.issue.revision,answer:"POST /reset"});
    expect(answered.stage).toBe("research");expect(answered.validatedSha).toBeNull();expect(answered.approvedSha).toBeNull();
    if(manualStop){
      await f.engine.tick();expect(f.starts).toHaveLength(starts);expect(answered.status).toBe("stopped");
      f.engine.resume(issue.id,{revision:answered.revision});
    }
    await f.stage(issue.id,"research");expect(f.starts.at(-1)!.prompt).toContain("POST /reset");
    f.finish({status:"completed",summary:"Updated requirements",requirements:{...requirements,scope:"Counter and reset API",acceptanceCriteria:["GET returns counter","POST /reset resets counter"]}});
    await f.engine.tick();detail=f.engine.getDetail(issue.id);expect(detail.issue.requirementsVersion).toBe(2);
    expect(detail.artifacts.filter(a=>a.kind==="requirements").map(a=>a.version)).toEqual([1,2]);
  });
  test("research with no configured validation command waits before implementation",async()=>{
    const f=fixture();f.engine.setProjectSettings("/projects/demo",{validationCommands:[]});
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");f.finish({status:"completed",summary:"Requirements ready",requirements});await f.engine.tick();
    let d=f.engine.getDetail(issue.id);expect(d.issue.status).toBe("stopped");expect(d.issue.stage).toBe("implementation");expect(f.starts).toHaveLength(1);
    f.engine.setProjectSettings("/projects/demo",{validationCommands:["bun test"]});f.engine.resume(issue.id,{revision:d.issue.revision});await f.stage(issue.id,"implementation");
    d=f.engine.getDetail(issue.id);expect(d.issue.settings.validationCommands).toEqual(["bun test"]);
  });
  test("unconfirmed exit retains reservation and prevents new work",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.states.set(f.starts[0]!.attemptId,{status:"unknown",error:"systemd unavailable"});
    // Model a genuinely unavailable stop, not proof of termination.
    f.runner.stop=async()=>{throw new Error("systemd unavailable");};await f.engine.tick();
    expect(f.engine.getDetail(issue.id).issue.stopReasons).toContain("recovery");expect(f.engine.budgets().reservedMs).toBeGreaterThan(0);
    const second=f.create("/projects/second");f.engine.ready(second.id,{revision:second.revision});await f.engine.tick();expect(f.starts).toHaveLength(1);
  });
  test("parent budget reservations cap deadline and require explicit resume after exhaustion",async()=>{
    const f=fixture();f.engine.setSettings({parentBudgetMs:10_000,dailyBudgetMs:60_000,attemptTimeoutMs:30_000});
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    expect(f.starts[0]!.deadlineAt-f.now()).toBe(10_000);expect(f.starts[0]!.stopAt-f.now()).toBe(5000);
    f.advance(5000);await f.engine.tick();await f.engine.tick();
    let current=f.engine.getDetail(issue.id).issue;expect(current.status).toBe("stopped");expect(current.stopReasons).toContain("budget");
    f.advance(24*60*60_000);await f.engine.reconcile();current=f.engine.getDetail(issue.id).issue;expect(current.status).toBe("stopped");expect(current.consumedMs).toBe(5000);
    expect(()=>f.engine.resume(issue.id,{revision:current.revision})).toThrow("no available");
  });
  test("a daily-budget stop remains stopped after day rollover until explicit resume",async()=>{
    const f=fixture();f.engine.setSettings({parentBudgetMs:100_000,dailyBudgetMs:10_000,attemptTimeoutMs:30_000});
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.advance(5000);await f.engine.tick();await f.engine.tick();let current=f.engine.getDetail(issue.id).issue;
    expect(current.status).toBe("stopped");expect(current.stopReasons).toContain("budget");expect(current.consumedMs).toBe(5000);
    f.advance(24*60*60_000);await f.engine.reconcile();expect(f.starts).toHaveLength(1);current=f.engine.getDetail(issue.id).issue;expect(current.status).toBe("stopped");
    f.engine.resume(issue.id,{revision:current.revision});await f.stage(issue.id,"research");expect(f.starts).toHaveLength(2);expect(f.engine.getDetail(issue.id).issue.consumedMs).toBe(5000);
  });
  test("simultaneous Ready requests share global reservation and project concurrency",async()=>{
    const f=fixture();f.engine.setSettings({dailyBudgetMs:20_000,attemptTimeoutMs:15_000,maxActivePerProject:1});
    const a=f.create(),b=f.create();f.engine.ready(a.id,{revision:a.revision});f.engine.ready(b.id,{revision:b.revision});
    await Promise.all([f.engine.tick(),f.engine.tick()]);await f.engine.tick();expect(f.starts).toHaveLength(1);expect(f.engine.budgets().reservedMs).toBe(15_000);
    const c=f.create("/projects/other");f.engine.ready(c.id,{revision:c.revision});await f.engine.tick();await f.engine.tick();expect(f.starts).toHaveLength(1);expect(f.engine.getDetail(c.id).issue.stopReasons).toContain("budget");
  });
  test("global concurrency limits cannot be lowered while an attempt is live",async()=>{
    const f=fixture();f.engine.setSettings({maxActivePerProject:2});const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    expect(()=>f.engine.setSettings({maxActiveIssues:1})).toThrow("stop active attempts");
    expect(()=>f.engine.setSettings({maxActivePerProject:1})).toThrow("stop active attempts");
    expect(f.engine.settings().maxActiveIssues).toBe(2);expect(f.engine.settings().maxActivePerProject).toBe(2);
  });
  test("SHA drift after approval prevents merge and removes approval",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});const ready=await f.toApproval(issue.id);
    f.engine.approve(issue.id,{revision:ready.revision,headSha:ready.validatedSha!});f.setPr({headSha:"c".repeat(40)});await f.engine.tick();
    expect(f.counts().merges).toBe(0);const current=f.engine.getDetail(issue.id).issue;expect(current.status).toBe("stopped");expect(current.approvedSha).toBeNull();
  });
  test("changing validation commands while stopped invalidates old validation and approval",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});let current=await f.toApproval(issue.id);
    f.engine.stop(issue.id,{revision:current.revision});current=f.engine.getDetail(issue.id).issue;
    f.engine.setProjectSettings("/projects/demo",{validationCommands:["bun run typecheck","bun test"]});
    f.engine.resume(issue.id,{revision:current.revision});await f.stage(issue.id,"validation");
    current=f.engine.getDetail(issue.id).issue;expect(current.validatedSha).toBeNull();expect(current.approvedSha).toBeNull();
    expect(f.engine.inbox().filter(r=>r.kind==="approval")).toHaveLength(0);expect(f.starts.at(-1)!.validationCommands).toEqual(["bun run typecheck","bun test"]);expect(f.counts().merges).toBe(0);
  });
  test("a model validation-success claim without worker receipts cannot approve a SHA",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");f.finish({status:"completed",summary:"Requirements",requirements});
    await f.stage(issue.id,"implementation");f.finish({status:"completed",summary:"Implemented"});await f.stage(issue.id,"validation");
    const attempt=f.starts.at(-1)!;f.advance(1000);f.states.set(attempt.attemptId,{status:"stopped",startedAt:f.now()-1000,endedAt:f.now(),result:{status:"completed",summary:"I say tests passed",validationPassed:true}});
    await f.engine.tick();expect(f.engine.getDetail(issue.id).issue.validatedSha).toBeNull();expect(f.starts.some(a=>a.stage==="review")).toBe(false);
  });
  test("human fixed remote-head drift is checkpointed and revalidated on resume",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});const ready=await f.toApproval(issue.id);
    f.engine.approve(issue.id,{revision:ready.revision,headSha:ready.validatedSha!});f.setPr({headSha:"c".repeat(40)});await f.engine.tick();
    const oldCheckpoint=f.git.checkpoint;f.git.checkpoint=async context=>({...await oldCheckpoint(context),headSha:"c".repeat(40)});
    const stopped=f.engine.getDetail(issue.id).issue;f.engine.resume(issue.id,{revision:stopped.revision});await f.stage(issue.id,"validation");
    expect(f.engine.getDetail(issue.id).issue.workspace?.headSha).toBe("c".repeat(40));expect(f.counts().merges).toBe(0);
    f.finish({status:"completed",summary:"Revalidated",validationPassed:true});await f.stage(issue.id,"review");f.finish({status:"completed",summary:"Reviewed new SHA",reviewPassed:true});
    await f.until(issue.id,()=>f.engine.getDetail(issue.id).issue.status==="waiting");
    expect(f.engine.inbox().find(r=>r.kind==="approval")?.headSha).toBe("c".repeat(40));
  });
  test("explicit resume retries a failed Git checkpoint with its original operation ID",async()=>{
    const f=fixture(),issue=f.create(),original=f.git.checkpoint;const ids:string[]=[];
    f.git.checkpoint=async context=>{ids.push(context.operationId);throw Object.assign(new Error("Set git user.name"),{retryable:false,reason:"git_identity"});};
    f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");f.finish({status:"completed",summary:"Plan",requirements});await f.stage(issue.id,"implementation");f.finish({status:"completed",summary:"Implemented"});await f.engine.tick();
    const stopped=f.engine.getDetail(issue.id).issue;expect(stopped.status).toBe("stopped");
    f.git.checkpoint=async context=>{ids.push(context.operationId);return original(context);};f.engine.resume(issue.id,{revision:stopped.revision});await f.stage(issue.id,"validation");
    expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1]);expect(f.starts.filter(a=>a.stage==="implementation")).toHaveLength(1);
  });
  test("stopped no-change Issue accepts explicit new instructions and researches a new version",async()=>{
    const f=fixture(),issue=f.create(),original=f.git.checkpoint;
    f.git.checkpoint=async c=>{const w=await original(c);return {...w,headSha:w.baseSha};};
    f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");f.finish({status:"completed",summary:"Plan",requirements});await f.stage(issue.id,"implementation");f.finish({status:"completed",summary:"No diff"});await f.engine.tick();
    const stopped=f.engine.getDetail(issue.id).issue;expect(stopped.status).toBe("stopped");
    f.engine.requestChanges(issue.id,{revision:stopped.revision,answer:"Implement the missing reset endpoint too"});await f.stage(issue.id,"research");expect(f.starts.at(-1)!.prompt).toContain("missing reset endpoint");
    f.finish({status:"completed",summary:"Updated plan",requirements:{...requirements,scope:"Counter and reset"}});await f.engine.tick();expect(f.engine.getDetail(issue.id).issue.requirementsVersion).toBe(2);
  });
  test("CI failures return to implementation with bounded attempts",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");f.finish({status:"completed",summary:"Requirements",requirements});
    for(let n=0;n<3;n++){
      await f.stage(issue.id,"implementation");f.finish({status:"completed",summary:"Implemented"});await f.stage(issue.id,"validation");
      f.finish({status:"failed",summary:"Tests failed",validationPassed:false});await f.engine.tick();
    }
    expect(f.engine.getDetail(issue.id).issue.status).toBe("stopped");expect(f.starts.filter(a=>a.stage==="implementation")).toHaveLength(3);
  });
  test("one GitHub changes-requested review causes one repair, then waits for reviewer update across restart",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.toApproval(issue.id);
    f.setPr({reviewDecision:"changes_requested",changesRequestedReviewIds:[42],feedback:["Cover the reset case"]});f.advance(16_000);await f.engine.tick();
    await f.stage(issue.id,"implementation");f.finish({status:"completed",summary:"Fixed reset"});await f.stage(issue.id,"validation");f.finish({status:"completed",summary:"Tests pass",validationPassed:true});await f.stage(issue.id,"review");f.finish({status:"completed",summary:"Repair looks correct",reviewPassed:true});
    await f.until(issue.id,()=>f.engine.getDetail(issue.id).issue.status==="waiting");
    expect(f.starts.filter(m=>m.stage==="implementation")).toHaveLength(2);expect(f.engine.inbox().some(r=>r.kind==="approval")).toBe(false);
    expect(f.engine.inbox().some(r=>r.question.question==="GitHub reviewer update is required")).toBe(true);
    f.advance(31_000);await new WorkflowEngine(f.db,f.deps).reconcile();expect(f.starts.filter(m=>m.stage==="implementation")).toHaveLength(2);
    f.setPr({reviewDecision:"approved",changesRequestedReviewIds:[]});f.advance(31_000);await f.engine.tick();
    expect(f.engine.inbox().some(r=>r.kind==="approval")).toBe(true);expect(f.engine.inbox().some(r=>r.question.question==="GitHub reviewer update is required")).toBe(false);
    f.setPr({reviewDecision:"changes_requested",changesRequestedReviewIds:[43]});f.advance(16_000);await f.engine.tick();await f.stage(issue.id,"implementation");
    expect(f.starts.filter(m=>m.stage==="implementation")).toHaveLength(3);
  });
  test("reserved launch can resume after a crash without allocating another attempt",async()=>{
    const f=fixture(),issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    const attempt=f.engine.getDetail(issue.id).attempts[0]!;const launch=f.engine.store.jobs().find(j=>j.payload.attemptId===attempt.id)!;
    launch.status="working";f.engine.store.job(launch);
    const restored=new WorkflowEngine(f.db,f.deps);await restored.reconcile();expect(f.starts).toHaveLength(1);expect(restored.getDetail(issue.id).attempts).toHaveLength(1);
  });
  for(const expired of [false,true])test(`reserved launch replays at full capacity${expired?" after its deadline without starting a worker":" and adopts the existing unit"}`,async()=>{
    const f=fixture();f.engine.setSettings({maxAgents:1,maxActiveIssues:1,maxActivePerProject:1,attemptTimeoutMs:10_000});
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    const attempt=f.engine.getDetail(issue.id).attempts[0]!;attempt.status="reserved";f.engine.store.saveAttempt(attempt);
    const launch=f.engine.store.jobs().find(j=>j.payload.attemptId===attempt.id)!;launch.status="working";f.engine.store.job(launch);
    let replayed=0;const original=f.runner.start;
    f.runner.start=async manifest=>{
      replayed++;expect(manifest.attemptId).toBe(attempt.id);
      if(expired){f.states.set(manifest.attemptId,{status:"stopped",startedAt:f.now(),endedAt:f.now(),error:"expired before start"});return;}
      return original(manifest);
    };
    if(expired){f.advance(11_000);f.states.clear();f.starts.length=0;}
    const restored=new WorkflowEngine(f.db,f.deps);await restored.reconcile();await restored.tick();
    expect(replayed).toBe(1);expect(restored.getDetail(issue.id).attempts).toHaveLength(1);expect(restored.store.jobs().find(j=>j.id===launch.id)?.status).toBe("done");
    if(expired){
      expect(f.starts).toHaveLength(0);expect(restored.getDetail(issue.id).issue.stopReasons).toContain("budget");
      expect(restored.getDetail(issue.id).issue.consumedMs).toBe(0);expect(restored.store.reservations()).toHaveLength(0);
    }else{expect(f.starts).toHaveLength(1);expect(restored.getDetail(issue.id).attempts[0]!.status).toBe("running");}
  });
  for(const {timezone,start,nextDayHours} of [
    {timezone:"UTC",start:Date.UTC(2026,9,2,23,59,50),nextDayHours:24},
    {timezone:"Asia/Tokyo",start:Date.UTC(2026,9,2,14,59,50),nextDayHours:24},
    {timezone:"America/New_York",start:Date.UTC(2026,2,8,4,59,50),nextDayHours:23},
    {timezone:"America/New_York",start:Date.UTC(2026,10,1,3,59,50),nextDayHours:25},
  ])test(`concurrent attempts reserve and charge both days across ${timezone} ${nextDayHours}-hour day`,async()=>{
    const f=fixture();f.engine.setSettings({timezone,parentBudgetMs:100_000,dailyBudgetMs:45_000,attemptTimeoutMs:40_000});f.setNow(start);
    const a=f.create(),b=f.create("/projects/second");f.engine.ready(a.id,{revision:a.revision});f.engine.ready(b.id,{revision:b.revision});
    await Promise.all([f.engine.tick(),f.engine.tick()]);await f.stage(a.id,"research");await f.stage(b.id,"research");
    expect(f.starts.map(m=>m.deadlineAt-start)).toEqual([40_000,25_000]);
    const slices=f.engine.store.reservations();expect(slices).toHaveLength(4);
    const today=workflowDayWindow(start,timezone),tomorrow=workflowDayWindow(start+10_000,timezone);
    expect(tomorrow.end-tomorrow.start).toBe(nextDayHours*60*60_000);
    expect(slices.filter(r=>r.day===today.day).reduce((sum,r)=>sum+r.reserved_ms,0)).toBe(20_000);
    expect(slices.filter(r=>r.day===tomorrow.day).reduce((sum,r)=>sum+r.reserved_ms,0)).toBe(45_000);
    f.advance(10_000);await new WorkflowEngine(f.db,f.deps).reconcile();
    expect(f.stops).toHaveLength(0);expect(f.starts).toHaveLength(2);expect(f.engine.budgets().reservedMs).toBe(45_000);
    expect(f.engine.getDetail(a.id).issue.status).toBe("running");expect(f.engine.getDetail(b.id).issue.status).toBe("running");
    f.advance(5000);
    for(const m of f.starts)f.states.set(m.attemptId,{status:"stopped",startedAt:start,endedAt:f.now(),result:{status:"needs_input",summary:"Confirm scope",questions:[{question:"Include reset?",recommended:"Include",alternatives:["Defer"],impact:"Changes API"}]}});
    await f.engine.tick();expect(f.engine.store.reservations()).toHaveLength(0);expect(f.engine.budgets().usedMs).toBe(10_000);
    expect(f.engine.getDetail(a.id).issue.consumedMs).toBe(15_000);expect(f.engine.getDetail(b.id).issue.consumedMs).toBe(15_000);
    f.setNow(start);expect(f.engine.budgets().usedMs).toBe(20_000);
  });
  test("fully reserved next day caps another attempt at midnight including kill grace",async()=>{
    const f=fixture(),start=Date.UTC(2026,9,2,23,59,50);f.setNow(start);
    f.engine.setSettings({parentBudgetMs:100_000,dailyBudgetMs:20_000,attemptTimeoutMs:30_000});
    const a=f.create(),b=f.create("/projects/second");f.engine.ready(a.id,{revision:a.revision});f.engine.ready(b.id,{revision:b.revision});
    await f.stage(a.id,"research");await f.stage(b.id,"research");
    expect(f.starts[0]!.deadlineAt).toBe(start+30_000);expect(f.starts[1]!.deadlineAt).toBe(start+10_000);expect(f.starts[1]!.stopAt).toBe(start+5000);
    expect(f.engine.store.reservations().filter(r=>r.attempt_id===f.starts[1]!.attemptId)).toHaveLength(1);
    f.advance(5000);await f.engine.tick();await f.engine.tick();expect(f.engine.getDetail(b.id).issue.stopReasons).toContain("budget");
    f.advance(5000);await f.engine.reconcile();expect(f.engine.getDetail(a.id).issue.status).toBe("running");expect(f.engine.getDetail(b.id).issue.status).toBe("stopped");expect(f.starts).toHaveLength(2);
    expect(f.engine.budgets().reservedMs).toBe(20_000);
  });
  test("unknown exit retains all day slices across restart until exit is confirmed",async()=>{
    const f=fixture(),start=Date.UTC(2026,9,2,23,59,50);f.setNow(start);f.engine.setSettings({attemptTimeoutMs:30_000});
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    const id=f.starts[0]!.attemptId;f.states.set(id,{status:"unknown",error:"systemd unavailable"});f.runner.stop=async()=>{throw new Error("systemd unavailable");};
    await f.engine.tick();const slices=f.engine.store.reservations();expect(slices.map(r=>r.reserved_ms)).toEqual([10_000,20_000]);
    f.advance(11_000);await new WorkflowEngine(f.db,f.deps).reconcile();expect(f.engine.store.reservations()).toEqual(slices);expect(f.engine.budgets().reservedMs).toBe(20_000);
    const second=f.create("/projects/second");f.engine.ready(second.id,{revision:second.revision});await f.engine.tick();expect(f.starts).toHaveLength(1);
    f.advance(1000);f.states.set(id,{status:"stopped",startedAt:start,endedAt:f.now(),error:"confirmed stopped"});
    await f.engine.tick();expect(f.engine.store.reservations().filter(r=>r.attempt_id===id)).toHaveLength(0);expect(f.engine.budgets().usedMs).toBe(2000);
    expect(f.engine.getDetail(issue.id).issue.status).toBe("stopped");expect(f.engine.getDetail(issue.id).issue.consumedMs).toBe(12_000);
  });
  test("failure reserving the second day rolls back the attempt and all slices before launch",async()=>{
    const f=fixture();f.setNow(Date.UTC(2026,9,2,23,59,50));
    f.db.exec("CREATE TRIGGER deny_tomorrow BEFORE INSERT ON workflow_reservations WHEN NEW.day='2026-10-03' BEGIN SELECT RAISE(ABORT, 'tomorrow reservation failure'); END");
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.engine.tick();await f.engine.tick();
    expect(f.starts).toHaveLength(0);expect(f.engine.store.reservations()).toHaveLength(0);expect(f.engine.getDetail(issue.id).attempts).toHaveLength(0);
    expect(f.engine.store.jobs().find(j=>j.kind==="launch")?.error).toContain("tomorrow reservation failure");
  });
  test("usage is split at day boundaries and warning events are unique per allowance",async()=>{
    const f=fixture();f.engine.setSettings({parentBudgetMs:100_000,dailyBudgetMs:100_000,attemptTimeoutMs:100_000});
    const issue=f.create();f.engine.ready(issue.id,{revision:issue.revision});await f.stage(issue.id,"research");
    f.advance(81_000);await f.engine.tick();await f.engine.tick();
    expect(f.engine.store.notifications(issue.id).filter(n=>n.kind==="budget-warning")).toHaveLength(2);
    const d=fixture();d.setNow(Date.UTC(2026,9,2,23,59,50));const night=d.create();d.engine.ready(night.id,{revision:night.revision});await d.stage(night.id,"research");
    const id=d.starts[0]!.attemptId;d.setNow(Date.UTC(2026,9,3,0,0,2));
    d.states.set(id,{status:"stopped",startedAt:Date.UTC(2026,9,2,23,59,50),endedAt:Date.UTC(2026,9,3,0,0,2),result:{status:"failed",summary:"deadline"}});
    await d.engine.tick();expect(d.engine.budgets().usedMs).toBe(2000);expect(d.engine.getDetail(night.id).issue.consumedMs).toBe(12_000);
  });
  test("invalid project/settings/revision fail before effects",()=>{
    const f=fixture();expect(()=>f.create("relative")).toThrow("absolute");expect(()=>f.engine.setSettings({timezone:"Fake/Zone"})).toThrow("timezone");
    const issue=f.create();expect(()=>f.engine.ready(issue.id,{revision:99})).toThrow("changed");expect(f.starts).toHaveLength(0);
  });
  test("Ready requires explicit model and Codex effort snapshots",()=>{
    const f=fixture();f.engine.setProjectSettings("/projects/demo",{model:null,effort:null});const issue=f.create();
    expect(()=>f.engine.ready(issue.id,{revision:issue.revision})).toThrow("explicit model");
    f.engine.setProjectSettings("/projects/demo",{model:"pinned-model"});expect(()=>f.engine.ready(issue.id,{revision:issue.revision})).toThrow("explicit Codex effort");
    expect(f.engine.getDetail(issue.id).issue.status).toBe("backlog");expect(f.starts).toHaveLength(0);
  });
});
