// ============================================================
//  Nice Try  ·  coins
//  Credit for keeping the tool armed and for actually obeying it.
// ============================================================
//
// Why an economy at all: the switch had no cost. Flipping it off was free,
// silent, and permanent, and the tool's own scoreboard kept looking fine
// because nothing was being measured to look bad. Coins give the "on" state
// something to accumulate, so turning it off finally forfeits something.
//
// What is deliberately NOT rewarded here:
//   · Time with the extension merely installed. Armed time only counts while
//     you are present — the same presence check the tracker already uses — so
//     leaving Chrome open overnight earns nothing. A currency you can farm by
//     doing nothing teaches you to do nothing.
//   · Talking your way past a wall. The gauntlet grant pays zero. Crediting it
//     would mean the balance climbs fastest on the days the tool works least,
//     which is precisely backwards.
//
// The ledger is append-only and capped. It exists so a balance can be
// questioned — a number you cannot audit is a number you stop believing.

// ---- rates ---------------------------------------------------------
// Chosen so a genuine working day lands around 40-60 coins, and a single
// pause costs enough to be a decision without being unaffordable. Tuning
// these is fine; keep EARN_PER_BLOCK well above ten minutes of armed time,
// or walking away becomes worth less than idling with the tool on.
const COIN_MINUTES_PER_TICK = 10;   // armed+present minutes per coin
const EARN_PER_BLOCK   = 5;         // walked away from a wall
const EARN_PER_SESSION = 10;        // finished a focus session
const LEDGER_CAP = 200;

// Streak multiplier. Applies to earnings only — never to the balance you
// already hold, so a broken streak cannot retroactively shrink what you
// banked. Ramps to 1.5x over a week; beyond that it stops, because a
// multiplier that keeps climbing makes one missed day catastrophic and turns
// the tool into something you dread rather than use.
function streakMultiplier(days) {
  const d = Math.max(0, Number(days) || 0);
  if (d < 2) return 1;
  return Math.min(1.5, 1 + (d - 1) * 0.0833);   // 1.0 -> 1.5 across 7 days
}

function coinsTodayKey() {
  const dt = new Date();
  return dt.getFullYear() + "-" +
    String(dt.getMonth() + 1).padStart(2, "0") + "-" +
    String(dt.getDate()).padStart(2, "0");
}

function dayBefore(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() - 1);
  return dt.getFullYear() + "-" +
    String(dt.getMonth() + 1).padStart(2, "0") + "-" +
    String(dt.getDate()).padStart(2, "0");
}

// The whole wallet in one record, so a read is one storage hit on a path that
// runs every few seconds.
//   balance     spendable coins
//   earned      lifetime gross, never decremented — the honest total
//   streak      consecutive days with any armed time
//   lastEarnDay day the streak last advanced
//   partialSec  armed seconds not yet worth a whole coin, carried across ticks
//   ledger      newest-first, capped
function emptyWallet() {
  return {
    balance: 0, earned: 0, spent: 0,
    streak: 0, bestStreak: 0, lastEarnDay: "",
    partialSec: 0, ledger: [],
    // Celebration bookkeeping. pendingMilestone is consumed by the popup;
    // lastMilestone stops the same one firing twice; brokeFrom records a
    // streak that just ended so the loss can be acknowledged once.
    pendingMilestone: 0, lastMilestone: 0, brokeFrom: 0,
    // The permanent record: every milestone ever reached, as
    // { n: days, at: ms, count: times reached }. A milestone banner fires once
    // and is gone in a second; this is the part that is still there in March.
    //
    // It deliberately OUTLIVES a broken streak. Losing 17 days already zeroes
    // the number on the popup — if it also erased the proof you once did 14,
    // the tool would be telling you that you had never done it, on the exact
    // day you most need to know that you had.
    held: []
  };
}

async function getWallet() {
  const d = await chrome.storage.local.get("wallet");
  const w = d.wallet && typeof d.wallet === "object" ? d.wallet : {};
  const base = emptyWallet();
  for (const k in base) if (w[k] !== undefined) base[k] = w[k];
  if (!Array.isArray(base.ledger)) base.ledger = [];
  // Same guard as the ledger: a wallet stored before `held` existed carries no
  // such key, and one corrupted to a non-array would throw on the first push.
  if (!Array.isArray(base.held)) base.held = [];

  // Backfill. `held` arrived after the streak did, so a wallet already on
  // day 12 had walked past 3 and 7 with nothing written down — and the shelf
  // then pointed at "3 days · 0 days away" underneath a 13-day streak. A run
  // of N days is proof that every milestone up to N was reached, so the record
  // is rebuilt from the two numbers that WERE kept. Dates: a milestone inside
  // the current run has a knowable day (count back from the last earn); one
  // reachable only through an older bestStreak has none, and at:0 says so
  // rather than inventing one. Runs once — after this every entry exists.
  const have = new Set(base.held.filter(h => h && h.n).map(h => h.n));
  const live = streakIsStale(base) ? 0 : (base.streak || 0);
  let filled = false;
  for (const m of MILESTONES) {
    if (have.has(m) || m > (base.bestStreak || 0)) continue;
    let at = 0;
    if (m <= live && base.lastEarnDay) {
      const [y, mo, d] = String(base.lastEarnDay).split("-").map(Number);
      at = new Date(y, (mo || 1) - 1, (d || 1) - (live - m), 12).getTime();
    }
    base.held.push({ n: m, at, count: 1, inferred: true });
    filled = true;
  }
  if (filled) {
    base.held.sort((a, b) => (a.n || 0) - (b.n || 0));
    await putWallet(base);
  }
  return base;
}

async function putWallet(w) {
  w.ledger = (w.ledger || []).slice(0, LEDGER_CAP);
  await chrome.storage.local.set({ wallet: w });
  return w;
}

// Roll the streak forward to today. Called on every earn, so the streak is a
// function of days you actually armed the tool rather than days you had it
// installed.
//
// Missing yesterday breaks it. That is the entire incentive: what you lose by
// switching off is the multiplier, not the balance. Confiscating banked coins
// reads as punishment and is the fastest route to an uninstall.
function advanceStreak(w) {
  const today = coinsTodayKey();
  if (w.lastEarnDay === today) return w;
  // The RAW stored streak, not liveStreak(): a lapsed streak already reports
  // 0, so reading it through liveStreak made "you just lost 17 days"
  // indistinguishable from "you never had one" — and the loss went unreported.
  const had = w.streak || 0;
  w.streak = (w.lastEarnDay === dayBefore(today)) ? (w.streak || 0) + 1 : 1;
  w.lastEarnDay = today;
  if (w.streak > (w.bestStreak || 0)) w.bestStreak = w.streak;

  // A streak that was alive and is now back to 1 was BROKEN. Recorded so the
  // popup can acknowledge it once — silently resetting a 17-day streak to 1
  // is the moment someone decides the tool isn't worth it. Naming it, and
  // showing the best they ever reached, turns a loss into a target.
  if (had > 1 && w.streak === 1) w.brokeFrom = had;
  else if (w.streak > 1) w.brokeFrom = 0;

  // A broken streak clears the milestone latch, because the next climb has to
  // be able to earn them again. Without this, lastMilestone stayed pinned at
  // the highest number ever reached: someone who lost a 14-day run and fought
  // back to 14 got nothing at all — no banner, and (once `held` existed) no
  // second count either. The rebuild is the harder of the two climbs and it
  // was the one the tool stayed silent for.
  if (w.streak === 1) w.lastMilestone = 0;

  // Milestone flag for the popup to celebrate exactly once. Written here (the
  // single place a streak advances) rather than derived in the UI, which would
  // re-fire the celebration on every popup open all day.
  const m = milestoneFor(w.streak);
  if (m && w.lastMilestone !== m) {
    w.pendingMilestone = m; w.lastMilestone = m;
    // Write it to the permanent record at the same moment, in the same single
    // place a streak advances. Reaching 14 again after a break is not a new
    // trophy — it is the same one, earned again — so the count goes up and the
    // ORIGINAL date is kept. "First held 23 Aug, three times since" is a truer
    // sentence than either a duplicate row or a silently overwritten date.
    const prior = w.held.find(h => h && h.n === m);
    if (prior) { prior.count = (prior.count || 1) + 1; prior.lastAt = Date.now(); }
    else w.held.push({ n: m, at: Date.now(), count: 1 });
  }
  return w;
}

// Has the streak already lapsed? Read-only — used by the UI to show a broken
// streak as broken without waiting for the next earn to write it. A streak
// whose last earn was today or yesterday is still alive; yesterday's is alive
// because today is not over yet.
function streakIsStale(w) {
  if (!w || !w.lastEarnDay) return true;
  const today = coinsTodayKey();
  return w.lastEarnDay !== today && w.lastEarnDay !== dayBefore(today);
}
function liveStreak(w) {
  return streakIsStale(w) ? 0 : (w.streak || 0);
}

// Has today's streak already been secured? A streak whose last earn was
// YESTERDAY is still alive, but it is alive on borrowed time — it dies at
// midnight unless something is earned today. That distinction is the whole
// retention mechanic: "17 days, safe" and "17 days, at risk" are the same
// number and completely different feelings, and only one of them makes
// someone leave the tool on this evening.
function earnedToday(w) {
  return !!w && w.lastEarnDay === coinsTodayKey();
}
function streakAtRisk(w) {
  return liveStreak(w) > 0 && !earnedToday(w);
}

// Milestones worth marking. Deliberately sparse and front-loaded: the early
// ones arrive while the habit is still fragile and the later ones are far
// enough apart that hitting one still means something. A reward on every
// single day trains you to expect a reward every single day, which makes an
// ordinary day feel like a loss.
const MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365];
function milestoneFor(streak) {
  return MILESTONES.includes(streak) ? streak : 0;
}
function nextMilestone(streak) {
  for (const m of MILESTONES) if (m > streak) return m;
  return 0;                       // past the last one — no target to dangle
}

function pushLedger(w, kind, amount, note) {
  w.ledger.unshift({ at: Date.now(), kind, amount, note: note || "" });
}

// Credit whole coins for armed, present seconds. Fractions are carried in
// partialSec rather than rounded, so three minutes here and seven there still
// pays — rounding each tick to zero would mean short focused stretches earned
// nothing at all.
async function earnFromArmedTime(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 0) return null;
  const w = await getWallet();
  w.partialSec = (w.partialSec || 0) + s;
  const need = COIN_MINUTES_PER_TICK * 60;
  if (w.partialSec < need) { await putWallet(w); return null; }

  const whole = Math.floor(w.partialSec / need);
  w.partialSec -= whole * need;
  advanceStreak(w);
  // Multiplier is read AFTER advancing, so the first earn of a new day already
  // reflects the day it just extended.
  const mult = streakMultiplier(liveStreak(w));
  const paid = Math.max(1, Math.round(whole * mult));
  w.balance += paid;
  w.earned  += paid;
  pushLedger(w, "armed", paid,
    whole * COIN_MINUTES_PER_TICK + "m focused" + (mult > 1 ? " ×" + mult.toFixed(2) : ""));
  await putWallet(w);
  return { paid, balance: w.balance, streak: liveStreak(w) };
}

// ---- the late-task charge ------------------------------------------
// Writing a task from a wall costs coins. It is the one charge in here that is
// not buying anything, and that is deliberate: it is a price on WHEN the task
// was written, not on writing it.
//
// A task added at the start of the day is planning. The same task typed into a
// countdown on a page you were about to be blocked on is a reconstruction — you
// are naming work you had already drifted away from, and the list that was
// supposed to steer the day was empty when it mattered. The classifier reads
// that list; an empty list is the single biggest thing holding it back, because
// today's tasks override every other verdict. So the day you write nothing down
// is the day this tool is worst at its job, and it should not be free.
//
// Small on purpose. Two coins is roughly twenty minutes of armed time — enough
// to notice and to prefer writing the list in the morning, nowhere near enough
// to make anyone hide a real task to avoid the fee. A charge that discourages
// capture would defeat the feature it is attached to.
const LATE_TASK_CHARGE = 2;

// The same charge, taken at the wall instead of the countdown. One coin more:
// the countdown was the cheap window, and it was on screen for eighteen
// seconds saying so. Missing it is the late fee. Still the cheaper of the two
// doors on that wall — writing the task down is the honest exit, and the honest
// exit must never cost more than the other one.
const WALL_TASK_CHARGE = 3;

// ---- "just this once" ---------------------------------------------
// The other door on the ambiguous wall: fifteen minutes on this one page,
// counted as wasted, no task written. It is the door for "I know this is not
// work and I am doing it anyway", which is a legitimate thing to decide and a
// terrible thing to lie about — so it asks for no reason at all. There is
// nothing to argue with; there is a price.
//
// Priced against the armed rate like every other sink: fifteen minutes armed
// earns 1.5 coins, and this costs 4 at list — same as the ten-minute pause,
// because a wall you can buy past for less than a pause is a cheaper pause.
// The price climbs on the COUNT for the day (half again per prior claim, so
// the third costs double), because the failure this door is watching for is
// not one fifteen-minute detour, it is the fifth. A medium-confidence verdict
// — one made with a task list to read against — adds half again on top: the
// tool had more to go on, and overriding it should cost more than overriding
// a guess. Capped at six times list, like the pause.
const ONCE_LIST = 4;
const ONCE_MINUTES = 15;
function onceMultiplier(ctx) {
  const n = Math.max(0, Number(ctx && ctx.claimsToday) || 0);
  let m = 1 + 0.5 * Math.min(n, 4);
  if (ctx && ctx.tier === "medium") m *= 1.5;
  return Math.min(6, m);
}
function oncePrice(ctx) {
  return Math.ceil(ONCE_LIST * onceMultiplier(ctx));
}

// Debit for a once-pass. Unlike the task charge below this one CAN refuse:
// it is buying access, not recording work, and a balance that cannot cover it
// is the economy saying no. The caller offers the other door.
async function spendOnce(price, why) {
  const cost = Math.max(ONCE_LIST, Math.ceil(Number(price) || ONCE_LIST));
  const w = await getWallet();
  if (w.balance < cost) {
    return { ok: false, reason: "poor", balance: w.balance, need: cost };
  }
  w.balance -= cost;
  w.spent = (w.spent || 0) + cost;
  pushLedger(w, "once", -cost, ONCE_MINUTES + " min on one page" + (why ? " · " + why : ""));
  await putWallet(w);
  return { ok: true, balance: w.balance, minutes: ONCE_MINUTES };
}

// Never blocks the write. The caller saves the task first and calls this after,
// so a balance of zero costs you the coins you have and the note still lands.
// The alternative — refusing to record work because you cannot afford to — would
// destroy exactly what this whole path exists to protect, and would teach you to
// stop writing things down, which is the opposite of the point.
//
// `debt` is reported so the UI can say what happened rather than silently
// showing a balance that did not move as much as the price implied.
//
// `price` defaults to the countdown's charge; the wall passes its own.
async function chargeLateTask(note, price) {
  const w = await getWallet();
  price = Math.max(0, Math.round(Number(price) || LATE_TASK_CHARGE));
  const taken = Math.min(w.balance, price);
  const debt = price - taken;
  if (taken > 0) {
    w.balance -= taken;
    w.spent = (w.spent || 0) + taken;
  }
  // Logged even when nothing could be taken, because "you owed 2 and had 0" is
  // the entry most worth being able to look back at.
  pushLedger(w, "latetask", -taken,
    (note || "task added late") + (debt ? " (couldn't cover " + debt + ")" : ""));
  await putWallet(w);
  return { price, taken, debt, balance: w.balance };
}

// One-off awards. Same multiplier, same ledger, so every coin in the balance
// can be traced to a thing that happened.
async function earnEvent(kind, note) {
  const table = { block: EARN_PER_BLOCK, session: EARN_PER_SESSION };
  const base = table[kind];
  if (!base) return null;
  const w = await getWallet();
  advanceStreak(w);
  const mult = streakMultiplier(liveStreak(w));
  const paid = Math.max(1, Math.round(base * mult));
  w.balance += paid;
  w.earned  += paid;
  pushLedger(w, kind, paid, note || "");
  await putWallet(w);
  return { paid, balance: w.balance, streak: liveStreak(w) };
}

// ---- the store -----------------------------------------------------
// Pause minutes are the only sink that costs the tool anything to sell, and
// that is the point: standing the wall down should draw on credit you built
// by keeping it up. Priced above the armed rate — ten minutes armed earns one
// coin, ten minutes of pause costs four — so pausing is never a net win. A
// sink you can profit from is a loophole, not an economy.
const STORE = [
  { id: "pause10", label: "10 minutes off",  minutes: 10, price: 4 },
  { id: "pause30", label: "30 minutes off",  minutes: 30, price: 14 },
  { id: "pause60", label: "An hour off",     minutes: 60, price: 30 }
];
function storeItem(id) { return STORE.find(i => i.id === id) || null; }

// ---- the downtime budget ------------------------------------------
// How long the tool may be stood down in a day — off, paused, or talked past —
// before standing it down starts costing more. One number, chosen to be
// generous: an hour is a lunch and a call, not a working afternoon. The point
// is not to make an hour off impossible; it is to make the SECOND hour a
// decision. The same number is drawn on the popup as a bar, so the budget is
// something you can watch yourself spend rather than a rule you trip over.
const DOWN_BUDGET_MIN = 60;

// TESTING ONLY — set back to false before shipping.
//
// Lifts the ration on the popup's free pause row (normally one a day, and none
// once the downtime budget above is spent). Exercising this extension means
// standing it down repeatedly, and a one-a-day rule makes it untestable by its
// own author — who then flips the off switch instead, which tests nothing and
// leaves the tool dead.
//
// This lifts the RATION and nothing else. Every free pause is still written to
// the pause log, still gets a ledger row at zero, still counts toward the
// downtime budget, and still shows in the free count on the scoreboard. The
// hole stays fully visible in the numbers, which is what makes it safe to
// open — and easy to confirm closed again. The popup keeps its own copy of
// this flag (it does not load this file); both must move together.
const FREE_PAUSE_UNLIMITED = true;

// What a pause costs right now. The list price is for the FIRST pause of a
// day, inside the budget. Each further pause today adds half again (so the
// third costs double), and going over the budget doubles whatever that is.
// Capped at six times list so a bad day is expensive rather than absurd.
//
// Why frequency and duration are priced separately: they are different
// habits. Six ten-minute pauses and one hour-long one cost the same minutes
// and are not the same problem — the first is a tool being switched off
// every time it works, the second is an afternoon given up. The multiplier
// climbs on the count, the budget catches the length, and either alone
// would leave the other habit free.
function pauseMultiplier(ctx) {
  const n = Math.max(0, Number(ctx && ctx.pausesToday) || 0);
  let m = 1 + 0.5 * Math.min(n, 4);
  if (ctx && ctx.overBudget) m *= 2;
  return Math.min(6, m);
}
function pausePrice(item, ctx) {
  return Math.ceil(item.price * pauseMultiplier(ctx));
}

// Take the pending celebration and clear it, so it shows once and never again.
// Read-and-clear lives here rather than in the popup because two popups (or a
// popup and the scoreboard) could otherwise both claim the same milestone.
async function claimCelebration() {
  const w = await getWallet();
  const out = { milestone: w.pendingMilestone || 0, brokeFrom: w.brokeFrom || 0 };
  if (out.milestone || out.brokeFrom) {
    w.pendingMilestone = 0;
    w.brokeFrom = 0;
    await putWallet(w);
  }
  return out;
}

// A free pause, written to the ledger at zero. Nothing moves, and that is the
// point: a stand-down that costs nothing would otherwise be the one event of
// the day the wallet had no record of, and the ledger exists precisely so the
// balance can be questioned. "Paused for free" three times in a row is a fact
// the scoreboard should be able to show, because it is the fact that decides
// whether the free row survives.
async function noteFreePause(minutes, reason) {
  const w = await getWallet();
  const why = String(reason || "").trim().slice(0, 60);
  pushLedger(w, "freepause", 0, minutes + " min" + (why ? " · " + why : ""));
  await putWallet(w);
  return w;
}

// Debit. Returns {ok:false, reason} rather than throwing — every caller is a
// UI handler that has to say something useful either way.
// `price` is the live price from pausePrice(); the list price is only the
// floor. `why` names the surcharge in the ledger ("3rd today, over budget")
// so a row that cost 28 next to one that cost 14 explains itself.
async function spend(itemId, price, why) {
  const item = storeItem(itemId);
  if (!item) return { ok: false, reason: "unknown" };
  const cost = Math.max(item.price, Math.ceil(Number(price) || item.price));
  const w = await getWallet();
  if (w.balance < cost) {
    return { ok: false, reason: "poor", balance: w.balance, need: cost };
  }
  w.balance -= cost;
  w.spent = (w.spent || 0) + cost;
  pushLedger(w, "spend", -cost, item.label + (why ? " · " + why : ""));
  await putWallet(w);
  return { ok: true, balance: w.balance, minutes: item.minutes, label: item.label };
}
