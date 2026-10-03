/** Text-only Done follow-up protocol, shared by persistence and log previews.
 * Keep this module free of server, filesystem, and UI imports. */
export const DONE_FOLLOWUPS_MAX_CANDIDATES = 5;
export const DONE_FOLLOWUPS_OPEN_TAG = "<kaname-followups>";
export const DONE_FOLLOWUPS_CLOSE_TAG = "</kaname-followups>";

export interface DoneFollowupCandidateInput {
  title: string;
  rationale: string;
  scope: string;
  acceptanceCriteria: string[];
}

export type DoneFollowupParseResult =
  | { ok: true; candidates: DoneFollowupCandidateInput[] }
  | { ok: false; error: string };

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    offset = text.indexOf(marker, offset);
    if (offset === -1) return count;
    count++;
    offset += marker.length;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Strict all-or-nothing protocol parse. A malformed candidate, more than
 * five candidates, multiple envelopes, or an unknown shape never produces a
 * partial subset.
 */
export function parseDoneFollowups(output: string): DoneFollowupParseResult {
  if (
    countOccurrences(output, DONE_FOLLOWUPS_OPEN_TAG) !== 1
    || countOccurrences(output, DONE_FOLLOWUPS_CLOSE_TAG) !== 1
  ) {
    return { ok: false, error: "expected exactly one <kaname-followups> envelope" };
  }
  const open = output.indexOf(DONE_FOLLOWUPS_OPEN_TAG);
  const close = output.indexOf(DONE_FOLLOWUPS_CLOSE_TAG);
  if (close < open + DONE_FOLLOWUPS_OPEN_TAG.length) {
    return { ok: false, error: "malformed <kaname-followups> envelope" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(output.slice(open + DONE_FOLLOWUPS_OPEN_TAG.length, close));
  } catch {
    return { ok: false, error: "follow-up envelope is not valid JSON" };
  }
  if (!plainObject(decoded) || !exactKeys(decoded, ["candidates"]) || !Array.isArray(decoded.candidates)) {
    return { ok: false, error: "follow-up JSON must be exactly {\"candidates\": [...]}" };
  }
  if (decoded.candidates.length > DONE_FOLLOWUPS_MAX_CANDIDATES) {
    return { ok: false, error: "follow-up JSON has more than five candidates" };
  }

  const candidates: DoneFollowupCandidateInput[] = [];
  for (const item of decoded.candidates) {
    if (
      !plainObject(item)
      || !exactKeys(item, ["title", "rationale", "scope", "acceptanceCriteria"])
      || !Array.isArray(item.acceptanceCriteria)
      || item.acceptanceCriteria.length < 1
    ) {
      return { ok: false, error: "each candidate needs title, rationale, scope, and acceptanceCriteria" };
    }
    const title = nonBlankString(item.title);
    const rationale = nonBlankString(item.rationale);
    const scope = nonBlankString(item.scope);
    const acceptanceCriteria = item.acceptanceCriteria.map(nonBlankString);
    if (!title || !rationale || !scope || acceptanceCriteria.some((value) => value === null)) {
      return { ok: false, error: "candidate fields must be non-empty strings" };
    }
    candidates.push({
      title,
      rationale,
      scope,
      acceptanceCriteria: acceptanceCriteria as string[],
    });
  }
  return { ok: true, candidates };
}
