import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DoneFollowupsOutput } from "./DoneFollowupsOutput.tsx";

test("candidate fields and the original output remain text, never executable HTML", () => {
  const candidate = {
    title: '<img src=x onerror="alert(1)">',
    rationale: "Reason & context",
    scope: '<script>alert("scope")</script>',
    acceptanceCriteria: ['<a href="javascript:alert(1)">accept</a>'],
  };
  const original = `<kaname-followups>${JSON.stringify({ candidates: [candidate] })}</kaname-followups>`;
  const html = renderToStaticMarkup(<DoneFollowupsOutput candidates={[candidate]} original={original} />);
  expect(html).toContain("追加タスクの提案 · 1 件");
  expect(html).toContain("候補の保存・起票状況");
  expect(html).toContain("Reason &amp; context");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;kaname-followups&gt;");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("<button");
  expect(html).toContain('<details data-testid="done-followups-original"');
  expect(html).not.toContain(" open=");
});

test("zero candidates are an explicit normal result", () => {
  const html = renderToStaticMarkup(<DoneFollowupsOutput candidates={[]} original={'<kaname-followups>{"candidates":[]}</kaname-followups>'} />);
  expect(html).toContain("追加タスクの提案 · 0 件");
  expect(html).toContain("追加タスクの提案はありません。");
});
