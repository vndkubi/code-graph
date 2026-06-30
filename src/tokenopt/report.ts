import fs from "node:fs";
import path from "node:path";
import { readRepoEvents } from "./observability.js";
import type { TokenOptConfig } from "./types.js";

interface DailyStatEntry {
  ts?: string;
  tokensAvoided?: number;
  taskType?: string;
}

function readAllDailyStats(): { date: string; calls: number; tokensAvoided: number; taskTypes: Record<string, number> }[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  const dir = path.join(home, ".tokenopt", "stats");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, 30)
    .map((f) => {
      const date = f.replace(".jsonl", "");
      let calls = 0;
      let tokensAvoided = 0;
      const taskTypes: Record<string, number> = {};
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        for (const line of raw.trim().split("\n")) {
          if (!line) continue;
          const entry = JSON.parse(line) as DailyStatEntry;
          calls += 1;
          tokensAvoided += entry.tokensAvoided ?? 0;
          if (entry.taskType) taskTypes[entry.taskType] = (taskTypes[entry.taskType] ?? 0) + 1;
        }
      } catch {
        // skip corrupt files
      }
      return { date, calls, tokensAvoided, taskTypes };
    })
    .filter((d) => d.calls > 0);
}

export function buildReport(config: TokenOptConfig, repoRoot: string): string {
  const events = readRepoEvents(config, repoRoot);
  const daily = readAllDailyStats();

  const byAction = new Map<string, number>();
  let eventTokensSaved = 0;
  for (const event of events) {
    byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
    eventTokensSaved += event.estimatedTokensSaved ?? 0;
  }

  const actionLines = [...byAction.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([action, count]) => `  ${action}: ${count}`);

  const last = events.slice(-5).map(
    (event) => `  ${event.timestamp} ${event.eventName} ${event.action}${event.reason ? `: ${event.reason}` : ""}`
  );

  const dailyLines = daily.slice(0, 7).map((d) => {
    const top = Object.entries(d.taskTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}(${v})`)
      .join(" ");
    return `  ${d.date}  calls=${d.calls}  saved=~${d.tokensAvoided}tok  tasks=${top || "—"}`;
  });

  const totalAvoided = daily.reduce((s, d) => s + d.tokensAvoided, 0);
  const totalCalls = daily.reduce((s, d) => s + d.calls, 0);

  return [
    "TokenOpt report",
    "",
    "── Token savings (last 30 days) ─────────────────────",
    `  total contextgate calls : ${totalCalls}`,
    `  total tokens avoided    : ~${totalAvoided}`,
    `  days tracked            : ${daily.length}`,
    ...(dailyLines.length > 0 ? ["", "  Daily breakdown (newest first):", ...dailyLines] : []),
    "",
    "── Repo event log ───────────────────────────────────",
    `  events: ${events.length}`,
    `  estimated tokens saved (policy): ${eventTokensSaved}`,
    ...(actionLines.length > 0 ? ["", "  Actions:", ...actionLines] : []),
    ...(last.length > 0 ? ["", "  Recent:", ...last] : [])
  ].join("\n");
}
