// Deadlines. A task's `date` is the day it is PLANNED for — it decides which
// day's list it sits on and when its link stops being walled. `due` is the
// separate, optional answer to "by when must this be finished", stored as
// "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" in local time. Never derived from `date`
// and never used to order the list: order is set by hand (see rankOf).
//
// Shared by popup.js and tasks.js. The phone app keeps a copy in
// mobile/lib/task-list.ts; test/due.test.cjs holds the two to the same labels.
(function (root) {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = n => String(n).padStart(2, "0");

  function parse(due) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(due || ""));
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(v => v === undefined ? undefined : +v);
    const at = new Date(y, mo - 1, d);
    if (at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
    if (h !== undefined && (h > 23 || mi > 59)) return null;
    return { y, mo, d, time: h === undefined ? "" : pad(h) + ":" + pad(mi), h, mi };
  }
  // The form fields' values back into one string. A time with no date is
  // meaningless, so it is dropped rather than guessed onto today.
  function join(date, time) {
    if (!date) return "";
    const due = time ? date + "T" + time : date;
    return parse(due) ? due : "";
  }
  function clock(h, mi) {
    const suffix = h < 12 ? "AM" : "PM", h12 = h % 12 || 12;
    return h12 + (mi ? ":" + pad(mi) : "") + " " + suffix;
  }
  // Calendar days from `now`'s day to the deadline's day. UTC on both sides so
  // a daylight-saving change cannot turn one day into 0.96 of one.
  function daysUntil(p, now) {
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  // { label, level, title } for an open task's deadline, or null without one.
  // level: "over" (past it), "soon" (today or tomorrow), "later".
  function info(due, now) {
    const p = parse(due);
    if (!p) return null;
    now = now || new Date();
    const days = daysUntil(p, now);
    const at = p.time ? " " + clock(p.h, p.mi) : "";
    const end = p.time ? new Date(p.y, p.mo - 1, p.d, p.h, p.mi)
                       : new Date(p.y, p.mo - 1, p.d, 23, 59, 59, 999);
    const left = end - now;
    const when = DAYS[new Date(p.y, p.mo - 1, p.d).getDay()] + " " + p.d + " " + MONTHS[p.mo - 1] + (p.time ? ", " + clock(p.h, p.mi) : "");
    let label, level;
    if (left < 0) {
      level = "over";
      label = days < 0 ? "Overdue · " + plural(-days, "day") : "Overdue · was due" + at;
    } else if (days === 0) {
      level = "soon";
      const mins = Math.floor(left / 60000);
      label = p.time && mins < 180
        ? "Due in " + (mins < 60 ? Math.max(mins, 1) + "m" : Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : ""))
        : "Due today" + at;
    } else if (days === 1) {
      level = "soon"; label = "Due tomorrow" + at;
    } else {
      level = "later";
      label = "Due " + (days <= 6 ? DAYS[new Date(p.y, p.mo - 1, p.d).getDay()] : p.d + " " + MONTHS[p.mo - 1]) + at;
    }
    const rest = left < 0 ? "missed" : days === 0 ? "today" : plural(days, "day") + " left";
    return { label, level, title: "Deadline: " + when + " · " + rest };
  }

  // For a finished task: did it make the deadline? Compared by day, because a
  // completion is only recorded as a day (doneDate).
  function outcome(due, doneDate) {
    const p = parse(due), q = parse(doneDate);
    if (!p || !q) return "";
    const late = Math.round((Date.UTC(q.y, q.mo - 1, q.d) - Date.UTC(p.y, p.mo - 1, p.d)) / 86400000);
    return late > 0 ? "Missed by " + plural(late, "day") : "Met";
  }

  root.NiceTryDue = { parse, join, info, outcome };
  if (typeof module !== "undefined") module.exports = root.NiceTryDue;
})(globalThis);
