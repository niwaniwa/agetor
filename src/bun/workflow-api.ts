import type { WorkflowEngine } from "./workflow-engine.ts";
import { WorkflowError, type WorkflowAnswerInput, type WorkflowApprovalInput, type WorkflowCreateInput, type WorkflowMutation, type WorkflowProjectSettings, type WorkflowSettings } from "../shared/development-workflow.ts";

/** Called only behind the core's existing bearer/origin authentication gate.
 * Kept as a Request handler so API contracts can be tested without real ports. */
export function createWorkflowApi(engine: WorkflowEngine) {
  return async function workflowApi(req: Request): Promise<Response> {
    const url = new URL(req.url), route = url.pathname;
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
    const body = async () => {
      if (Number(req.headers.get("content-length")) > 128 * 1024) throw new WorkflowError("Request body is too large", 413);
      const raw = await req.text();
      if (new TextEncoder().encode(raw).byteLength > 128 * 1024) throw new WorkflowError("Request body is too large", 413);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new WorkflowError("JSON object required"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError("JSON object required");
      return value;
    };
    try {
      if (route === "/workflow/issues") {
        if (req.method === "GET") return json(engine.listIssues());
        if (req.method === "POST") return json(engine.createIssue(await body() as WorkflowCreateInput), 201);
      }
      if (route === "/workflow/projects") {
        if (req.method === "GET") return json(engine.projectSettings(url.searchParams.get("path") ?? ""));
        if (req.method === "PUT") { const input = await body() as WorkflowProjectSettings; return json(engine.setProjectSettings(input.projectPath, input)); }
      }
      if (route === "/workflow/settings") {
        if (req.method === "GET") return json(engine.settings());
        if (req.method === "PUT") return json(engine.setSettings(await body() as WorkflowSettings));
      }
      if (route === "/workflow/inbox" && req.method === "GET") return json(engine.inbox());
      if (route === "/workflow/notifications" && req.method === "GET") return json(engine.store.notifications().slice(-200).reverse());
      if (route === "/workflow/budget" && req.method === "GET") return json(engine.budgets());
      if (route === "/workflow/events" && req.method === "GET") {
        // Events invalidate a persisted snapshot; reconnect always rereads DB.
        // No decision/approval can be submitted through this GET endpoint.
        let timer: ReturnType<typeof setInterval> | undefined;
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = () => { if (!closed) controller.enqueue(new TextEncoder().encode("event: update\ndata: {}\n\n")); };
            const close = () => { if (closed) return; closed = true; clearInterval(timer); controller.close(); };
            send(); timer = setInterval(send, 5000); timer.unref();
            req.signal.addEventListener("abort", close, { once: true });
          },
          cancel() { closed = true; clearInterval(timer); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
      }
      const match = route.match(/^\/workflow\/issues\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]!), operation = match[2];
        if (!operation && req.method === "GET") return json(engine.getDetail(id));
        if (operation === "diff" && req.method === "GET") return json({ diff: await engine.diff(id) });
        const log = operation?.match(/^attempts\/([^/]+)\/logs$/);
        if (log && req.method === "GET") return json({ logs: (await engine.logs(id, decodeURIComponent(log[1]!))).logs ?? "" });
        if (req.method === "POST") {
          const input = await body();
          if (operation === "ready") return json(engine.ready(id, input as WorkflowMutation));
          if (operation === "stop") return json(engine.stop(id, input as WorkflowMutation));
          if (operation === "resume") return json(engine.resume(id, input as WorkflowMutation));
          if (operation === "cancel") return json(engine.cancel(id, input as WorkflowMutation));
          if (operation === "approve") return json(engine.approve(id, input as WorkflowApprovalInput));
          if (operation === "changes") return json(engine.requestChanges(id, input as WorkflowAnswerInput));
          const answer = operation?.match(/^requests\/([^/]+)\/answer$/);
          if (answer) return json(engine.answer(id, decodeURIComponent(answer[1]!), input as WorkflowAnswerInput));
        }
      }
      return json({ error: "Workflow route or method not found" }, 404);
    } catch (error) {
      if (error instanceof WorkflowError) return json({ error: error.message }, error.status);
      console.error("[kaname:workflow] request failed", error);
      return json({ error: "Workflow operation failed. See the service log for details." }, 500);
    }
  };
}
