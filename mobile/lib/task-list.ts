import type { Task } from "./task-service";
const rank = (task: Task) => Number.isFinite(task.rank) ? task.rank! : Infinity;
export const compareRank = (a: Task, b: Task) => rank(a)-rank(b) || a.id.localeCompare(b.id);

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
  const raw = task.url || task.text.match(/https?:\/\/[^\s]+/i)?.[0];
  if (!raw) return null;
  try { const url = new URL(raw); return ["https:","http:"].includes(url.protocol) ? url : null; }
  catch { return null; }
}

// Calendar-day difference, independent of daylight-saving time changes.
export function completionTiming(task: Task): string {
  if (!task.done || !task.date || !task.doneDate) return "";
  const days = Math.round((Date.parse(task.doneDate+"T00:00:00Z")-Date.parse(task.date+"T00:00:00Z"))/86400000);
  if (!Number.isFinite(days)) return "";
  return days===0 ? "On planned day" : `${Math.abs(days)} day${Math.abs(days)===1?"":"s"} ${days>0?"late":"early"}`;
}
