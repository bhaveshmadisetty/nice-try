import type { Task } from "./task-service";
import "./due.js";

// Deadline labels: the same file the popup and task board load (ui/due.js,
// copied by scripts/prepare-mobile.cjs), so all three say the same thing.
type DueInfo = { label: string; level: "over" | "soon" | "later"; title: string };
export const due = (globalThis as unknown as { NiceTryDue: {
  parse(value?: unknown): { time: string } | null;
  join(day: string, time: string): string;
  info(value?: unknown, now?: Date): DueInfo | null;
  outcome(value?: unknown, doneDate?: string): string;
} }).NiceTryDue;
const rank = (task: Task) => Number.isFinite(task.rank) ? task.rank! : Infinity;
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
// Ties break the way the extension breaks them (ui/popup.js tasksFor): the more
// overdue open task first, then rank/id list order. The extension ranks per
// day, so carried-over tasks share ranks with today's; breaking those ties by
// id alone showed a different order here than on the PC.
const overdueKey = (task: Task, day: string) => !task.done && task.date && task.date < day ? task.date : "￿";
export const compareRank = (a: Task, b: Task) => {
  const day = localDay(), x = overdueKey(a, day), y = overdueKey(b, day);
  return rank(a)-rank(b) || (x < y ? -1 : x > y ? 1 : 0) || a.id.localeCompare(b.id);
};

// Move against the full ordering so filtered-out tasks keep their relative order.
export function moveTask(tasks: Task[], id: string, targetId: string, direction: -1 | 1): Task[] {
  const ordered = [...tasks].sort(compareRank);
  const moving = ordered.find(t => t.id === id), target = ordered.find(t => t.id === targetId);
  if (!moving || !target || id === targetId || moving.done !== target.done) return tasks;
  ordered.splice(ordered.indexOf(moving), 1);
  const position = ordered.indexOf(target) + (direction > 0 ? 1 : 0);
  ordered.splice(position, 0, moving);
  const before = position ? rank(ordered[position-1]) : rank(ordered[position+1])-2048;
  const after = position < ordered.length-1 ? rank(ordered[position+1]) : before+2048;
  const nextRank = before+(after-before)/2;
  if (Number.isFinite(nextRank) && nextRank > before && nextRank < after) {
    return tasks.map(t => t.id === id ? {...t,rank:nextRank} : t);
  }
  // Tied legacy ranks or exhausted floating point gaps need fresh spacing.
  const ranks = new Map(ordered.map((t,i) => [t.id,(i+1)*1024]));
  return tasks.map(t => ({...t,rank:ranks.get(t.id)!}));
}

export function taskLink(task: Task): URL | null {
  const raw = task.url || textParts(task.text).find(part => part.href)?.href;
  if (!raw) return null;
  try { const url = new URL(raw); return ["https:","http:"].includes(url.protocol) ? url : null; }
  catch { return null; }
}

// Same rules as the extension's edit row (ui/popup.js): a missing scheme gets
// https://, and the host has to look like one so a sentence is not saved as a
// link. "" clears the link; null means the field holds something unusable.
const looksLikeHost = (h: string) => h === "localhost" || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(h);
export function parseLink(raw: string): { url: string; host: string } | "" | null {
  let url = raw.trim();
  if (!url) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  try {
    const parsed = new URL(url), host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return /^https?:$/.test(parsed.protocol) && looksLikeHost(host) ? { url: parsed.href, host } : null;
  } catch { return null; }
}

// Split task text so URLs typed into it render as real links. Trailing
// punctuation stays text: "see https://a.com." links to https://a.com.
export function textParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const value = match[0].replace(/[.,;:!?)\]}'"]+$/, ""), at = match.index!;
    let href: string | undefined;
    try { const u = new URL(value); if (u.protocol === "https:" || u.protocol === "http:") href = u.href; } catch {}
    if (!href) continue;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: value, href });
    last = at + value.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// Calendar-day difference, independent of daylight-saving time changes.
export function completionTiming(task: Task): string {
  if (!task.done || !task.date || !task.doneDate) return "";
  const days = Math.round((Date.parse(task.doneDate+"T00:00:00Z")-Date.parse(task.date+"T00:00:00Z"))/86400000);
  if (!Number.isFinite(days)) return "";
  return days===0 ? "On planned day" : `${Math.abs(days)} day${Math.abs(days)===1?"":"s"} ${days>0?"late":"early"}`;
}
