# How I Built Focus Shield

*The story of an AI focus blocker for Chrome — and how I reasoned my way through the system-design problems that stood between the idea and a viable product.*

---

## Why I started, and the first thing I got right

I'm a CS student with a placement to land and a family loan I carry every day. My problem was concrete: I'd sit down for DSA and lose an hour to a YouTube rabbit hole. A loop that fires the moment there's unstructured time.

Existing blockers didn't solve it, and I could articulate *why* — they operate at the wrong granularity. They block a whole domain (`youtube.com`), so they're either too blunt to matter or so strict I disable them by noon. The unit they act on is wrong.

My first instinct was a routine — advice, a system. I built a static page for it and immediately saw its architectural flaw: **it's a pull model. It waits to be opened.** But the behavior I'm fighting is a push event — the loop fires on its own. A pull-model tool can never win against a push-model problem. That mismatch told me what I actually needed: something event-driven that *watches and interrupts*, not something I visit.

That reframing was the first real design decision, and everything followed from it.

---

## Killing the naive version fast

I built the obvious next thing — scheduled desktop nags. Fixed-time notifications, fired even with the browser closed.

I killed it within an hour, and again I could name the reason: **it had no access to state.** It fired blindly at 7:30pm whether I was in LeetCode or Instagram. A system that acts without reading the current state of the world produces false positives constantly, and false positives destroy trust in a tool faster than anything. The requirement crystallized: **the trigger has to be a function of what I'm actually doing right now.**

---

## The core insight: classify intent, not domains

The key realization was about *where the signal lives.* The same domain carries opposite meaning — "Binary Search Explained" and "2025 Year-End Megamix" are both youtube.com, but one is work and one is the loop. Domain-level blocking throws away the signal that actually matters. **The signal is in the title, and reading it requires understanding, not string-matching.**

That defined the whole architecture. And it immediately raised the real system-design question: if judging intent needs an LLM, and an LLM call is slow, rate-limited, and costs money — **I cannot call it on every tab.** That constraint, not the feature, drove the design.

**My answer was a tiered classification funnel** — push the work down to the cheapest layer that can decide it:

1. Deterministic rules first (URL scheme, hard-coded junk/allow domains, distinctive keywords) — instant, free, offline. These resolve ~90% of tabs.
2. A per-title verdict **cache** — judge any unique title once, remember it forever.
3. The LLM **only** for the genuinely ambiguous remainder, and even then only after a dwell threshold.

This is the same principle as a CPU cache hierarchy or a CDN: most requests should never reach the expensive origin. That funnel is what made an LLM-powered tool actually viable instead of a rate-limit disaster.

---

## The system-design problems I had to reason through

Building it surfaced a series of real engineering problems. Each one I had to diagnose to a root cause before I could fix it — patching the symptom would've just moved the bug.

**Substring collisions in classification.** "Prime Video" was classified productive because the title contained "prime" (from my "Apna Prime" course keyword). The root cause wasn't that one word — it was that I was doing **substring matching on an unstructured string** and treating it as authoritative. Two fixes followed from that diagnosis: order the checks so junk is evaluated before productive (fail-safe toward blocking), and match *sites* by parsed hostname rather than fragile substrings. Same root cause killed the "Merge Sort **vs** Quicksort → junk" bug — I'd let a generic token do a specific job.

**Time accounting was inflated to 6h 53m.** I traced it: my tick ran on a 3s poll *and* on every tab-switch *and* every title-change, and each invocation added a fixed slice. So the logged time was a function of *event frequency*, not *elapsed time* — a classic instrumentation error. The fix was to measure **actual wall-clock delta between ticks** and make the accounting idempotent to how often the tick fires. Then I realized a deeper version of the same flaw: it counted time even when Chrome was minimized or I'd walked away. So "elapsed" had to be gated on **presence** — window focused AND machine not idle. The metric had to measure *attention*, not clock time, or it was measuring the wrong thing.

**The MV3 service-worker lifecycle.** My poll silently never ran. Root cause: I'd used `chrome.alarms`, which is clamped to a 60-second minimum — so a "3-second" poll was a lie, and worse, MV3 kills the worker after ~30s idle. I had to design around an **ephemeral, evictable** runtime: a self-scheduling timer for the fast loop, a 1-minute keep-alive alarm to resurrect the worker, and — critically — **all state persisted to storage, never held in a running timer**, so the worker can die and resume without losing anything. You don't fight the platform's lifecycle; you design so it doesn't matter.

**A dependency I don't control.** The LLM provider was the single point of failure — auto-routing silently picked *paid* models my free key rejected; hardcoded model slugs went dead because the provider rotates its free list; valid models got rate-limited. I stopped treating the provider as stable infrastructure and designed for its failure: **discover available models at runtime** instead of hardcoding, add a **second provider** (Groq) auto-detected from the key, and **cache aggressively** so a title costs at most one call ever. The provider became something I route around, not something I depend on.

---

## Designing for failure: the fallback

The most important architectural stance I took: **the tool must degrade gracefully, never fail open and never fully lock me out.** A discipline tool that silently stops disciplining the instant a free API hiccups is worse than no tool — it gives a false sense of protection.

So I built the fallback as a **layered decision**, where the LLM is one layer, not the whole thing:

- **Cache** answers first — anything seen before needs no API.
- **Deterministic rules** still catch hard junk (Instagram, Netflix) and keyword-obvious content with zero API.
- **My to-do override** still resolves offline — if a title matches today's tasks, it's work.
- **Only when genuinely undecided** does it fall through — and even then it doesn't wave me through. It returns an `"unsure"` state that raises a *"the AI couldn't verify this — you decide"* gate. Blind, it still makes me justify myself.

And the block's own gate fails safe in the other direction: if the AI can't judge my answers, it doesn't reject me outright — it drops me to the typing test, whose passphrase is generated **locally** with no API at all. So the system can never trap me out either. **Never fail open, never fail closed-and-stuck.** That symmetry was a deliberate design goal.

---

## Turning the block into a real gate (and catching my own loophole)

The blocker started as a blur — I could click past it on reflex, so it was security theater. It became a **fully opaque wall** that force-pauses media so nothing runs behind it.

Then I added a justification gate, and immediately spotted its flaw *myself*: I could type garbage into the questions and still get in. **The gate wasn't validating anything.** So I made the questions load-bearing — the LLM actually **judges the answers**, balanced: an honest, specific reason passes instantly; a rationalization fails. And failure has a real, proportional cost — type 15 random words against a 3-minute clock.

The last loophole I closed is the one I'm most pleased with, because it's a trust-model distinction: **passing because the AI approved you is not the same as forcing in via the typing test.** The first is an endorsement — so that verdict gets cached and you're not re-asked. The second is an *override* — so it grants time but is **deliberately never cached**, and the same title challenges you again. Treating an override as an endorsement would've been a silent authorization bug. Keeping them separate keeps the system honest.

---

## The UX reasoning

The interface decisions were design reasoning too, not decoration. I split the surface by **frequency of use**: a daily "cockpit" popup (checkbox to-dos, on/off, live AI-status pill, scoreboard) versus a set-once settings page (key, allow-list). Mixing daily controls with rarely-touched config is how UIs become cluttered; separating them by cadence keeps the common path clean.

The scoreboard I designed as an **honest mirror** — focused vs wasted minutes, per-tab breakdown, a blunt verdict — because the whole tool's leverage is confronting me with a number I'd otherwise avoid. And I rebuilt the styling onto a single token system after it drifted into ad-hoc per-section CSS, so the design reads as one system instead of parts.

---

## What this actually demonstrates

Not "a focus blocker." A system where I had to reason about **cost-aware tiered classification**, **caching strategy**, **designing around an unreliable external dependency**, **an ephemeral serverless runtime**, **correct instrumentation of a metric**, and a **fail-safe trust model** — and where nearly every decision was forced by a constraint I had to identify first.

The idea was the easy part. Making it *viable* — cheap enough, reliable enough, and honest enough to trust — was the engineering. That's the part I'm proud of: not that I wanted the tool, but that I could think through the system it takes to make one actually work.
