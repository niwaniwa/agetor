import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, CircleHelp, GitPullRequest, Loader2, Plus, RefreshCw, Settings2 } from "lucide-react";
import { workflowApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DEFAULT_MODEL, DEFAULT_EFFORT, type Project, type AgentProfile } from "../../../shared/types.ts";
import type { DevelopmentIssue, WorkflowDetail, WorkflowProjectSettings, WorkflowSettings, WorkflowNotification, WorkflowBudgetSummary, WorkflowHumanRequest, WorkflowRequirements } from "../../../shared/development-workflow.ts";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../../shared/development-workflow.ts";

const field = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const statusLabels: Record<string, string> = { backlog: "Backlog", ready: "Ready", running: "実行中", waiting: "対応・結果待ち", stopped: "停止中", cancelled: "取消済み", done: "Done" };
const stageLabels: Record<string, string> = { research: "調査・要件整理", implementation: "実装", validation: "検証", review: "自己レビュー", publish: "PR 作成", approval: "CI・承認待ち", merge: "マージ確認" };
const minutes = (ms: number) => Math.round(ms / 60_000 * 10) / 10;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

function RequestCard({ request, busy, onAnswer }: { request: WorkflowHumanRequest; busy: boolean; onAnswer: (answer: string) => void }) {
  const [answer, setAnswer] = useState("");
  return <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
    <p className="flex items-center gap-2 font-medium"><CircleHelp className="size-4" />{request.question.question}</p>
    {request.question.recommended && <p className="text-sm">推奨：{request.question.recommended}</p>}
    {request.question.alternatives.length > 0 && <p className="text-sm text-muted-foreground">選択肢：{request.question.alternatives.join(" / ")}</p>}
    {request.question.impact && <p className="text-sm text-muted-foreground">{request.question.impact}</p>}
    {request.kind === "question" && <form onSubmit={e => { e.preventDefault(); if (answer.trim()) onAnswer(answer.trim()); }} className="flex gap-2">
      <input aria-label="回答" value={answer} onChange={e => setAnswer(e.target.value)} className={field} placeholder="回答・追加の指示" required />
      <Button disabled={busy || !answer.trim()} type="submit">回答</Button>
    </form>}
  </div>;
}

function RequirementsView({ content }: { content: string }) {
  let requirements: WorkflowRequirements;
  try { requirements = JSON.parse(content) as WorkflowRequirements; }
  catch { return <p className="whitespace-pre-wrap text-sm">{content}</p>; }
  return <div className="space-y-3 rounded bg-muted p-4 text-sm">
    <p>{requirements.purpose}</p>
    <dl className="space-y-2">{([["対象範囲", requirements.scope], ["対象外", requirements.outOfScope], ["方針", requirements.approach]] as const).map(([label, value]) => value ? <div key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{value}</dd></div> : null)}</dl>
    <div><h4 className="font-medium">合格条件</h4><ul className="list-disc space-y-1 pl-5">{requirements.acceptanceCriteria.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
    {requirements.assumptions.length > 0 && <div><h4 className="font-medium">採用した前提</h4><ul className="list-disc space-y-1 pl-5">{requirements.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
  </div>;
}

export function DevelopmentWorkflowsPage({ projects, profiles, onBack }: { projects: Project[]; profiles: AgentProfile[]; onBack: () => void }) {
  const [issues, setIssues] = useState<DevelopmentIssue[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [inbox, setInbox] = useState<WorkflowNotification[]>([]);
  const [budget, setBudget] = useState<WorkflowBudgetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? "");
  const projectPathRef = useRef(projectPath); projectPathRef.current = projectPath;
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<WorkflowSettings>(DEFAULT_WORKFLOW_SETTINGS);
  const [project, setProject] = useState<WorkflowProjectSettings | null>(null);
  const [logText, setLogText] = useState("");
  const [logAttemptId, setLogAttemptId] = useState("");
  const [diff, setDiff] = useState("");
  const [tab, setTab] = useState<"overview" | "diff" | "logs" | "history">("overview");
  const [feedback, setFeedback] = useState("");
  const [approveChecked, setApproveChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const [rows, notifications, usage] = await Promise.all([workflowApi.list(), workflowApi.notifications(), workflowApi.budget()]);
      if (version !== refreshVersion.current) return;
      setIssues(rows); setInbox(notifications); setBudget(usage);
      const id = selectedRef.current;
      if (id) {
        const next = await workflowApi.detail(id);
        if (version === refreshVersion.current && selectedRef.current === id) setDetail(next);
      }
    } catch (e) { if (version === refreshVersion.current) setError(message(e)); }
  }, []);
  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {};
    // Snapshot first; onopen refresh closes the snapshot/subscription race.
    void refresh().then(() => { if (!disposed) unsubscribe = workflowApi.subscribe(() => void refresh()); });
    return () => { disposed = true; unsubscribe(); refreshVersion.current++; };
  }, [refresh]);
  useEffect(() => {
    setDetail(null); setLogText(""); setLogAttemptId(""); setDiff(""); setApproveChecked(false); setFeedback("");
    void refresh();
  }, [selected, refresh]);
  useEffect(() => { setApproveChecked(false); }, [detail?.issue.pullRequest?.headSha, detail?.issue.requirementsVersion, detail?.requests.find(r => r.kind === "approval" && r.status === "pending")?.id]);
  useEffect(() => {
    if (!projectPath && projects[0]) setProjectPath(projects[0].path);
  }, [projects, projectPath]);
  useEffect(() => {
    let current = true;
    setProject(null);
    if (projectPath) void workflowApi.project(projectPath).then(p => { if (current) setProject({ ...p, model: p.model ?? DEFAULT_MODEL[p.agent], effort: p.effort ?? DEFAULT_EFFORT[p.agent] }); }).catch(e => { if (current) setError(message(e)); });
    return () => { current = false; };
  }, [projectPath]);
  useEffect(() => { void workflowApi.settings().then(setSettings).catch(e => setError(message(e))); }, []);
  useEffect(() => {
    if (!selected || !detail || detail.issue.id !== selected) return;
    let current = true;
    if (tab === "diff") void workflowApi.diff(selected).then(r => { if (current) setDiff(r.diff); }).catch(e => { if (current) setError(message(e)); });
    if (tab === "logs") {
      const attempt = logAttemptId ? detail.attempts.find(a => a.id === logAttemptId) : detail.attempts.at(-1);
      if (attempt) void workflowApi.logs(selected, attempt.id).then(r => { if (current) setLogText(r.logs); }).catch(e => { if (current) setError(message(e)); });
    }
    return () => { current = false; };
  }, [tab, selected, detail, logAttemptId]);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); await refresh(); } catch (e) { setError(message(e)); await refresh(); } finally { setBusy(false); }
  };
  const issue = detail?.issue;
  const pending = detail?.requests.filter(r => r.status === "pending") ?? [];
  const attention = issues.filter(i => i.status === "waiting" || i.status === "stopped");
  const mutation = () => ({ revision: issue!.revision, idempotencyKey: crypto.randomUUID() });
  const selectIssue = (id: string) => { setSelected(id); setTab("overview"); const row = issues.find(i => i.id === id); if (row) setProjectPath(row.projectPath); };

  return <div className="flex min-h-0 flex-1 flex-col" data-testid="development-workflows-page">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
      <div className="flex items-center gap-3"><Button variant="ghost" size="icon" aria-label="ボードへ戻る" onClick={onBack}><ArrowLeft className="size-4" /></Button><div><h1 className="text-lg font-semibold">開発ワークフロー</h1><p className="text-xs text-muted-foreground">依頼から調査・実装・検証・PR・承認・マージまで</p></div></div>
      <div className="flex items-center gap-2"><Button variant="outline" onClick={() => setShowSettings(!showSettings)}><Settings2 className="mr-2 size-4" />設定</Button><Button variant="ghost" size="icon" aria-label="更新" onClick={() => void refresh()}><RefreshCw className="size-4" /></Button></div>
    </div>
    {error && <div role="alert" className="border-b bg-destructive/10 p-3 text-sm text-destructive">{error}<button className="ml-3 underline" onClick={() => setError(null)}>閉じる</button></div>}
    {notice && <div role="status" className="border-b p-3 text-sm">{notice}</div>}
    <div className="border-b px-5 py-2 text-xs text-muted-foreground">新ワークフローの日次利用：{budget ? minutes(budget.usedMs) + " / " + minutes(budget.limitMs) + " 分（予約 " + minutes(budget.reservedMs) + " 分）・" + budget.timezone : "読み込み中"}。通常 Task／Pipeline は対象外です。</div>
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-4 p-5">
        {showSettings && <section className="space-y-4 rounded-lg border bg-card p-4" aria-label="ワークフロー設定">
          <h2 className="font-semibold">プロジェクト設定</h2>
          <label className="block text-sm">プロジェクト<select aria-label="プロジェクト" className={field} value={projectPath} onChange={e => setProjectPath(e.target.value)}>{projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}</select></label>
          {project && project.projectPath === projectPath && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void act(async () => { const saved = await workflowApi.saveProject({ ...project, validationCommands: project.validationCommands.map(c => c.trim()).filter(Boolean) }); if (projectPathRef.current === saved.projectPath) setProject(saved); setNotice("プロジェクト設定を保存しました。開始済みの担当・接続先は固定されます。"); }); }}>
            <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Git remote<input className={field} value={project.remote} required onChange={e => setProject({ ...project, remote: e.target.value })} /></label><label className="text-sm">基準ブランチ<input className={field} value={project.baseBranch} required onChange={e => setProject({ ...project, baseBranch: e.target.value })} /></label></div>
            <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">担当 CLI<select className={field} value={project.agent} onChange={e => setProject({ ...project, agent: e.target.value as WorkflowProjectSettings["agent"], model: DEFAULT_MODEL[e.target.value as WorkflowProjectSettings["agent"]], effort: DEFAULT_EFFORT[e.target.value as WorkflowProjectSettings["agent"]] })}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label><label className="text-sm">モデル<input className={field} value={project.model ?? ""} required placeholder="モデル ID" onChange={e => setProject({ ...project, model: e.target.value || null })} /></label><label className="text-sm">Effort<input className={field} value={project.effort ?? ""} required={project.agent === "codex"} placeholder="high" onChange={e => setProject({ ...project, effort: e.target.value || null })} /></label></div>
            {profiles.length > 0 && <label className="block text-sm">保存済みプロファイルから CLI・モデル・effort を入力<select className={field} defaultValue="" onChange={e => { const p = profiles.find(p => p.id === e.target.value); if (p && (p.harness === "codex" || p.harness === "claude-code")) setProject({ ...project, agent: p.harness, model: p.model ?? DEFAULT_MODEL[p.harness], effort: p.effort ?? DEFAULT_EFFORT[p.harness] }); }}><option value="">選択してください</option>{profiles.filter(p => p.harness === "codex" || p.harness === "claude-code").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
            <label className="block text-sm">検証コマンド（一行に一つ）<textarea className={field} rows={3} value={project.validationCommands.join("\n")} placeholder="bun run typecheck" onChange={e => setProject({ ...project, validationCommands: e.target.value.split("\n") })} /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={project.githubEnabled} onChange={e => setProject({ ...project, githubEnabled: e.target.checked })} />このプロジェクトで GitHub への push・PR 作成を有効にする</label>
            <p className="text-xs text-muted-foreground">Ready 後に自動で進みます。マージは確認したコミットに対する承認後に Squash で行います。</p><Button disabled={busy}>プロジェクト設定を保存</Button>
          </form>}
          <form className="space-y-3 border-t pt-4" onSubmit={e => { e.preventDefault(); void act(async () => { setSettings(await workflowApi.saveSettings(settings)); setNotice("利用上限を保存しました。停止中の依頼は明示的に再開してください。"); }); }}>
            <h2 className="font-semibold">新ワークフローの利用上限</h2><div className="grid gap-3 sm:grid-cols-3">{([["parentBudgetMs", "依頼ごと（分）"], ["dailyBudgetMs", "一日合計（分）"], ["attemptTimeoutMs", "一回の実行（分）"]] as const).map(([key, label]) => <label key={key} className="text-sm">{label}<input className={field} type="number" min="1" required value={settings[key] / 60_000} onChange={e => setSettings({ ...settings, [key]: Number(e.target.value) * 60_000 })} /></label>)}</div>
            <label className="block text-sm">日次集計のタイムゾーン<input className={field} value={settings.timezone} required onChange={e => setSettings({ ...settings, timezone: e.target.value })} /></label><Button disabled={busy}>利用上限を保存</Button>
          </form>
        </section>}
        <form className="space-y-3 rounded-lg border bg-card p-4" onSubmit={e => { e.preventDefault(); void act(async () => { const created = await workflowApi.create({ projectPath, goal, title: title || undefined }); setGoal(""); setTitle(""); selectIssue(created.id); }); }}>
          <h2 className="font-semibold">新しい依頼</h2><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">対象プロジェクト<select aria-label="対象プロジェクト" className={field} required value={projectPath} onChange={e => setProjectPath(e.target.value)}><option value="">選択してください</option>{projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}</select></label><label className="text-sm">タイトル（任意）<input className={field} value={title} onChange={e => setTitle(e.target.value)} /></label></div>
          <label className="block text-sm">実現したいこと<textarea className={field} rows={3} required value={goal} onChange={e => setGoal(e.target.value)} placeholder="目的や制約を入力してください。合格条件は調査後に整理されます。" /></label><div className="flex items-center gap-3"><Button disabled={busy || !projectPath || !goal.trim()}><Plus className="mr-2 size-4" />Backlog に保存</Button><p className="text-xs text-muted-foreground">Ready にするまで実行しません。</p></div>
        </form>
        <section aria-label="あなたの対応待ち" className="rounded-lg border p-4"><h2 className="mb-2 font-semibold">あなたの対応待ち <span className="text-muted-foreground">{attention.length}</span></h2>{attention.length ? <div className="flex flex-wrap gap-2">{attention.map(i => <Button key={i.id} variant="outline" onClick={() => selectIssue(i.id)}>{i.title} · {stageLabels[i.stage]}</Button>)}</div> : <p className="text-sm text-muted-foreground">現在、対応待ちはありません。</p>}</section>
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="space-y-4" aria-label="依頼一覧">{Object.entries(statusLabels).map(([status, label]) => {
            const rows = issues.filter(i => i.status === status);
            if (!rows.length) return null;
            return <section key={status}><h3 className="mb-2 text-sm font-medium">{label} <span className="text-muted-foreground">{rows.length}</span></h3><div className="space-y-2">{rows.map(i => <button key={i.id} onClick={() => selectIssue(i.id)} className={"w-full rounded-lg border p-3 text-left " + (selected === i.id ? "border-primary bg-primary/5" : "bg-card hover:bg-muted")}><p className="truncate font-medium">{i.title}</p><p className="mt-1 text-xs text-muted-foreground">{stageLabels[i.stage]} · {minutes(i.consumedMs)} 分</p>{i.message && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{i.message}</p>}</button>)}</div></section>;
          })}{!issues.length && <p className="p-4 text-sm text-muted-foreground">まだ依頼はありません。</p>}</aside>
          <section className="min-w-0 rounded-lg border bg-card p-4" aria-label="依頼の詳細">
            {!issue ? <p className="text-sm text-muted-foreground">依頼を選択すると進捗と成果を確認できます。</p> : <div className="space-y-4">
              <div><h2 className="text-lg font-semibold">{issue.title}</h2><p className="text-sm text-muted-foreground">{statusLabels[issue.status]} · {stageLabels[issue.stage]} · {issue.settings.agent}{issue.settings.model ? " / " + issue.settings.model : ""}</p></div>
              <p className="whitespace-pre-wrap text-sm">{issue.goal}</p>
              {issue.message && <p className="rounded-md bg-muted p-3 text-sm" role="status">{issue.message}</p>}
              <div className="flex flex-wrap gap-2">
                {issue.status === "backlog" && <Button disabled={busy} onClick={() => void act(() => workflowApi.action(issue.id, "ready", mutation()))}>Ready にして開始</Button>}
                {(issue.status === "running" || issue.status === "ready" || issue.status === "waiting") && <Button disabled={busy} variant="outline" onClick={() => void act(() => workflowApi.action(issue.id, "stop", mutation()))}>停止</Button>}
                {issue.status === "stopped" && <Button disabled={busy} onClick={() => void act(() => workflowApi.action(issue.id, "resume", mutation()))}>再開</Button>}
                {!["done", "cancelled"].includes(issue.status) && <Button disabled={busy} variant="ghost" onClick={() => void act(() => workflowApi.action(issue.id, "cancel", mutation()))}>依頼を取り消す</Button>}
                {busy && <Loader2 className="size-5 animate-spin" />}
              </div>
              {issue.status === "backlog" && <p className="text-xs text-muted-foreground">Ready は調査・実装・検証・commit・push・PR 作成の許可です。マージは別途承認します。</p>}
              <nav className="flex flex-wrap gap-2 border-b pb-2" aria-label="成果表示">{([["overview", "要件・対応"], ["diff", "差分"], ["logs", "実行ログ"], ["history", "検証・履歴"]] as const).map(([key, label]) => <Button key={key} variant={tab === key ? "secondary" : "ghost"} onClick={() => setTab(key)}>{label}</Button>)}</nav>
              {tab === "overview" && <>
                {pending.map(r => <RequestCard key={r.id} request={r} busy={busy} onAnswer={answer => void act(() => workflowApi.answer(issue.id, r.id, { ...mutation(), answer }))} />)}
                {detail?.artifacts.filter(a => a.kind === "requirements").slice(-1).map(a => <div key={a.id}><h3 className="mb-2 font-medium">要件案 v{a.version}</h3><RequirementsView content={a.content} /></div>)}
                {issue.pullRequest && <div className="space-y-3 rounded-lg border p-4"><a className="flex items-center gap-2 font-medium text-primary underline" href={issue.pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequest className="size-4" />PR #{issue.pullRequest.number}</a><p className="break-all text-xs">確認対象 SHA：{issue.pullRequest.headSha}</p><p className="text-sm">CI：{issue.pullRequest.checksReported === false ? "未報告（設定されたローカル検証結果を確認してください）" : issue.pullRequest.checks} ／ マージ可能：{issue.pullRequest.mergeable === null ? "確認中" : issue.pullRequest.mergeable ? "はい" : "いいえ"}</p>
                  {pending.some(r => r.kind === "approval") && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approveChecked} onChange={e => setApproveChecked(e.target.checked)} />この SHA の差分・検証結果を確認しました</label><Button disabled={busy || !approveChecked || issue.pullRequest.checks !== "passed" || !issue.pullRequest.mergeable} onClick={() => void act(() => workflowApi.approve(issue.id, { ...mutation(), headSha: issue.pullRequest!.headSha }))}><CheckCircle2 className="mr-2 size-4" />承認して Squash マージ</Button></>}
                  {issue.status === "waiting" && issue.stage === "approval" && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void act(() => workflowApi.changes(issue.id, { ...mutation(), answer: feedback })); }}><input className={field} aria-label="修正依頼" placeholder="修正してほしい点" value={feedback} onChange={e => setFeedback(e.target.value)} /><Button variant="outline" disabled={busy || !feedback.trim()}>差し戻し</Button></form>}
                </div>}
              </>}
              {issue.status === "stopped" && <form className="space-y-2 rounded border p-3" onSubmit={e => { e.preventDefault(); void act(() => workflowApi.changes(issue.id, { ...mutation(), answer: feedback })); }}><label className="block text-sm">依頼を見直して調査から再開<textarea className={field} aria-label="追加の指示" value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="目的・条件の追加、または修正してほしい内容" /></label><Button variant="outline" disabled={busy || !feedback.trim()}>指示を追加して再開</Button></form>}
              {tab === "diff" && <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{diff || "表示できる差分はありません。"}</pre>}
              {tab === "logs" && <div className="space-y-3"><label className="block text-sm">実行ログの工程<select aria-label="実行ログの工程" className={field} value={logAttemptId} onChange={e => { setLogAttemptId(e.target.value); setLogText(""); }}><option value="">最新の実行</option>{detail?.attempts.map((a, index) => <option key={a.id} value={a.id}>{index + 1}. {stageLabels[a.stage]} · {a.status} · {new Date(a.startedAt ?? a.reservedAt).toLocaleString()}</option>)}</select></label><pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{logText || "まだ実行ログはありません。"}</pre></div>}
              {tab === "history" && <div className="space-y-3">{detail?.artifacts.map(a => <details key={a.id} className="rounded border p-3"><summary className="cursor-pointer text-sm">{a.kind} · v{a.version} · {new Date(a.createdAt).toLocaleString()}{a.headSha ? " · " + a.headSha.slice(0, 12) : ""}</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{a.content}</pre></details>)}{detail?.attempts.map(a => <p key={a.id} className="text-xs text-muted-foreground">{stageLabels[a.stage]} · {a.status} · {minutes(a.chargedMs)} 分 {a.error ?? ""}</p>)}</div>}
            </div>}
          </section>
        </div>
        <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">通知履歴（画面内のみ）</summary><div className="mt-3 space-y-2">{inbox.length ? inbox.map(n => <button key={n.id} className="block text-left text-sm hover:underline" onClick={() => selectIssue(n.issueId)}>{new Date(n.createdAt).toLocaleString()} · {n.summary}</button>) : <p className="text-sm text-muted-foreground">通知はありません。</p>}</div></details>
      </div>
    </div>
  </div>;
}
