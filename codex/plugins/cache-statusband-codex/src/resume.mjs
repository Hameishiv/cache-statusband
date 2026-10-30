import { formatAge, formatPercent, formatTokens } from "./format.mjs";

export function resumeMessage(summary, now = Date.now()) {
  if (!Number.isFinite(summary?.contextUsed) || !Number.isFinite(summary?.contextWindow)) return null;
  const model = [summary.model, summary.effort].filter(Boolean).join("/") || "unknown model";
  const context = `${formatTokens(summary.contextUsed)}/${formatTokens(summary.contextWindow)} (${formatPercent(summary.contextUsed, summary.contextWindow)})`;
  const age = formatAge(summary.tokenReportAt ?? summary.updatedAt, now);
  return `Cache Statusband Codex: restored ${model}; saved context ${context}; last token report ${age} ago. Prompt-cache warm/cold state is not exposed by Codex.`;
}
