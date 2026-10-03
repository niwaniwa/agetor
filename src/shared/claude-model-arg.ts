/** Pure CLI model normalization, shared by legacy adapters and DB-free workers. */
export const CLAUDE_MODEL_FLAG: Readonly<Record<string, string>> = {
  "mythos-5.1": "claude-mythos-5-1",
  "fable-5.1": "claude-fable-5-1",
  "mythos-5": "claude-mythos-5",
  "fable-5": "claude-fable-5",
  "opus-5.5": "claude-opus-5-5",
  "opus-5": "claude-opus-5",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "sonnet-5.5": "claude-sonnet-5-5",
  "sonnet-5": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "haiku-4.5": "claude-haiku-4-5",
};

/** Unknown future IDs and native aliases pass through unchanged. */
export function toClaudeModelArg(id: string): string { return CLAUDE_MODEL_FLAG[id] ?? id; }
