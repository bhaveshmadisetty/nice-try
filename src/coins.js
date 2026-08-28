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
    pendingMilestone: 0, lastMilestone: 0, brokeFrom: 0
  };
}

async function getWallet() {
  const d = await chrome.storage.local.get("wallet");
  const w = d.wallet && typeof d.wallet === "object" ? d.wallet : {};
  const base = emptyWallet();
  for (const k in base) if (w[k] !== undefined) base[k] = w[k];
  if (!Array.isArray(base.ledger)) base.ledger = [];
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

  // Milestone flag for the popup to celebrate exactly once. Written here (the
  // single place a streak advances) rather than derived in the UI, which would
  // re-fire the celebration on every popup open all day.
  const m = milestoneFor(w.streak);
  if (m && w.lastMilestone !== m) { w.pendingMilestone = m; w.lastMilestone = m; }
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

// Debit. Returns {ok:false, reason} rather than throwing — every caller is a
// UI handler that has to say something useful either way.
async function spend(itemId) {
  const item = storeItem(itemId);
  if (!item) return { ok: false, reason: "unknown" };
  const w = await getWallet();
  if (w.balance < item.price) {
    return { ok: false, reason: "poor", balance: w.balance, need: item.price };
  }
  w.balance -= item.price;
  w.spent = (w.spent || 0) + item.price;
  pushLedger(w, "spend", -item.price, item.label);
  await putWallet(w);
  return { ok: true, balance: w.balance, minutes: item.minutes, label: item.label };
}
