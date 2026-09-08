// wall.js — the blocking overlay, as one function.
//
// Lives in its own file because two callers need it and neither can borrow it
// from the other: the worker injects it into arbitrary pages with
// chrome.scripting.executeScript, while the welcome page calls it directly on
// itself. That second case exists because chrome.scripting cannot inject into
// chrome-extension:// pages at all — not even the extension's own — so the
// setup demo has to render the wall in its own document.
//
// It must stay SELF-CONTAINED. When injected it arrives with no scope but the
// page it lands in, so it may not reference anything in background.js. The only
// extension API it uses is chrome.runtime.sendMessage, which works from both.

// injected into the page — the warning strip that runs BEFORE the wall.
//
// The wall used to arrive with no notice at all: you were reading something and
// the page went black. That reads as a malfunction rather than a rule you set,
// and it is the single most common reason a blocker gets uninstalled — not
// because it blocked the wrong thing, but because it blocked without warning
// while something was half-typed.
//
// So the block is announced. A small panel, top-right, counting down the last
// stretch of the grace period — and it takes an answer.
//
// Saying what you're doing here is the whole point of the warning. The wall
// already asks that question, but it asks it AFTER the page is gone, which is
// too late to be useful: by then the thing you were mid-way through has been
// interrupted, and answering only buys the page back. Asked during the
// countdown, while the page is still in front of you, the answer is worth
// something — it goes on the to-do list as a task, so the work survives the
// block instead of being remembered as "something I was doing on YouTube".
//
// Writing an answer does NOT cancel the wall. That distinction is the whole
// design: a text box that buys you out of the block is just a password, and one
// you'd learn to type without reading in about a day. The block still lands on
// schedule. What changes is that the reason left with you rather than with the
// tab.
//
// Self-contained for the same reason showShield is — see the note at the top.
// data = { seconds, host, pageUrl }
function showHeadsUp(data) {
  var ID = "__fsheadsup__";
  // The wall is already up, or a grant just landed — nothing to warn about.
  if (document.getElementById("__focusshield__")) return;
  if (window.__fsGrantedAt && (Date.now() - window.__fsGrantedAt) < 8000) return;

  var left = Math.max(1, Math.round(Number(data && data.seconds) || 10));

  // Already counting. Don't restart it — a second injection landing mid-count
  // would reset the number upward, so the strip would tick 5, 4, 10, 9… and
  // stop meaning anything. The existing timer is already correct.
  var old = document.getElementById(ID);
  if (old) return;

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var box = document.createElement("div");
  box.id = ID;
  // role=status, not alert: this is information arriving on a schedule, and an
  // assertive live region would interrupt whatever a screen reader was mid-way
  // through saying. The countdown itself is aria-hidden — a number changing
  // every second is unusable read aloud — so the sentence carries the meaning
  // and is announced once.
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  box.style.cssText = [
    "position:fixed","top:16px","right:16px","z-index:2147483646",
    // Opaque, with a light border. This started as a translucent material and
    // vanished into exactly the pages it matters on: over YouTube's near-black
    // chrome a .94 panel with a blur behind it has almost no edge, so the whole
    // thing read as a faint watermark rather than something to type into. A
    // notice you have to hunt for is not a notice. The border is what separates
    // it from a dark page; the shadow alone could not.
    "background:#1C1C1E",
    "border:1px solid rgba(255,255,255,.14)",
    "border-radius:14px","padding:12px 14px",
    "box-shadow:0 10px 34px rgba(0,0,0,.62)",
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif",
    // px, not rem. rem resolves against the HOST PAGE's root font size — the
    // same trap showShield pins its own base against — so on a site setting
    // html{font-size:12px} the strip was ~30px narrower than its text needed
    // and the second line was clipped mid-word. Rendering caught this; reading
    // the rule would not have.
    // Wide enough to hold the field comfortably, and it no longer sizes to its
    // content — a box that resized as the copy changed would jump around while
    // being typed into.
    "color:#FFFFFF","width:min(330px, calc(100vw - 32px))",
    // Interactive now. It was pointer-events:none back when this was a passive
    // notice; the field below cannot be typed into without this.
    "pointer-events:auto",
    "display:block",
    // Pinned so the host page's root font-size can't shrink or inflate it, the
    // same reason showShield pins its own base.
    "font-size:14px","line-height:1.35","letter-spacing:-.01em",
    "animation:" + (reduceMotion ? "__fsHuFade .12s linear" : "__fsHuIn .32s cubic-bezier(.32,.72,0,1)")
  ].join(";");

  var st = document.createElement("style");
  st.textContent =
    "@keyframes __fsHuFade{from{opacity:0}to{opacity:1}}" +
    "@keyframes __fsHuIn{from{opacity:0;transform:translateY(-10px) scale(.96)}to{opacity:1;transform:none}}" +
    "@keyframes __fsHuOut{from{opacity:1}to{opacity:0;transform:translateY(-6px)}}" +
    "@keyframes __fsHuRow{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}" +
    "#" + ID + ",#" + ID + " *{box-sizing:border-box}" +
    "#" + ID + " ::placeholder{color:#6b6b70}" +
    "#" + ID + " :focus-visible{outline:2px solid #409CFF;outline-offset:2px}" +
    "#" + ID + " input:focus{outline:none;box-shadow:0 0 0 3px rgba(64,156,255,.32)}";
  box.appendChild(st);

  // ---- header: the countdown and what it means ----
  var head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:10px";

  var ring = document.createElement("div");
  ring.setAttribute("aria-hidden", "true");
  ring.style.cssText = "flex:none;width:34px;height:34px;border-radius:50%;" +
    "display:grid;place-items:center;background:rgba(255,159,10,.16);" +
    // line-height:1 so the digit is centred on the box rather than on its own
    // text baseline, which was leaving it sitting visibly low in the circle.
    "color:#FF9F0A;font-weight:700;font-size:14px;line-height:1;" +
    "font-variant-numeric:tabular-nums";
  ring.textContent = String(left);

  var txt = document.createElement("div");
  txt.style.cssText = "min-width:0";
  var h = document.createElement("div");
  h.style.cssText = "font-weight:600;letter-spacing:-.012em";
  h.textContent = "Blocking this page";
  var p = document.createElement("div");
  p.style.cssText = "color:rgba(235,235,245,.60);font-size:12.5px;margin-top:1px";
  // What the seconds are FOR. The old copy said "save anything you're mid-way
  // through", which was advice about the page; this asks the question the
  // field below answers.
  p.textContent = "What were you doing here?";
  txt.appendChild(h);
  txt.appendChild(p);
  head.appendChild(ring);
  head.appendChild(txt);
  box.appendChild(head);

  // ---- the answer ----
  var form = document.createElement("div");
  form.style.cssText = "margin-top:10px";

  var input = document.createElement("input");
  input.type = "text";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-label", "What were you doing on this page? It becomes a task.");
  input.placeholder = "e.g. the DSA lecture I was halfway through";
  input.style.cssText = "width:100%;background:#0f0f11;border:1px solid #38383c;" +
    "border-radius:9px;color:#FFFFFF;font-family:inherit;font-size:13px;" +
    "padding:8px 10px;letter-spacing:-.01em;line-height:1.35";
  form.appendChild(input);

  var save = document.createElement("button");
  save.type = "button";
  save.textContent = "Add to my tasks";
  save.style.cssText = "width:100%;margin-top:7px;border:none;border-radius:9px;" +
    "background:#2C2C2E;color:rgba(235,235,245,.30);font-family:inherit;" +
    "font-size:13px;font-weight:600;letter-spacing:-.01em;padding:8px;" +
    "cursor:not-allowed;line-height:1.2;transition:background .16s,color .16s";
  form.appendChild(save);

  // States the deal exactly, because the deal is unusual and getting it wrong in
  // either direction is bad: someone who thinks the block is coming anyway won't
  // bother typing, and someone who thinks this is a general pass will be
  // ambushed on the next video.
  var note = document.createElement("div");
  note.style.cssText = "color:rgba(235,235,245,.42);font-size:11.5px;margin-top:6px;" +
    "line-height:1.35;letter-spacing:-.004em";
  // The price is stated BEFORE the button is pressed, not discovered afterward.
  // A cost you only learn about once it has been taken is a penalty; a cost you
  // can see while deciding is a price, and only the second one can change when
  // you write your list. data.lateCharge comes from the worker so the number
  // here and the number actually charged cannot drift apart.
  var price = Math.max(0, Number(data && data.lateCharge) || 0);
  note.textContent =
    (price ? "Costs " + price + (price === 1 ? " coin" : " coins") + " — this should've been on your list. " : "") +
    "Calls off this block, this page only, until you leave it.";
  form.appendChild(note);
  box.appendChild(form);

  (document.documentElement || document).appendChild(box);

  // Deliberately NOT auto-focused. This panel arrives unannounced over whatever
  // you were doing — stealing the caret mid-sentence would make it the very
  // interruption it exists to soften, and on a page with a search box open it
  // would swallow the next thing typed.

  var done = false;               // an answer has been saved; don't take another
  function ok() { return input.value.trim().length >= 4; }
  function paint() {
    var v = ok();
    save.style.background = v ? "#0A84FF" : "#2C2C2E";
    save.style.color = v ? "#FFFFFF" : "rgba(235,235,245,.30)";
    save.style.cursor = v ? "pointer" : "not-allowed";
    save.setAttribute("aria-disabled", v ? "false" : "true");
  }
  paint();
  input.addEventListener("input", paint);

  // Typing must not be interrupted by the panel leaving underneath the caret.
  // The countdown keeps running and the wall still lands on time — the wall
  // simply removes this panel when it arrives, which is the honest behaviour:
  // the block was never contingent on finishing the sentence.
  function fire() {
    if (!ok() || done) return;
    var text = input.value.trim();
    save.disabled = true;
    save.style.cursor = "wait";
    try {
      chrome.runtime.sendMessage(
        // reprieve:true — this is the pre-wall panel, so answering calls the
        // block off for this page. The wall's own capture screen sends the same
        // message without it: there the page is already blocked and you have
        // already chosen to leave.
        { type: "captureTask", text: text, url: (data && data.pageUrl) || "",
          host: (data && data.host) || "", reprieve: true },
        function (resp) {
          if (chrome.runtime.lastError || !resp) {
            save.disabled = false;
            save.style.cursor = "pointer";
            note.textContent = "Couldn't save that. Try once more.";
            note.style.color = "#FF453A";
            return;
          }
          done = true;
          confirmSaved(text, !!resp.merged, !!resp.reprieved, resp.charge);
        }
      );
    } catch (e) {
      save.disabled = false;
      save.style.cursor = "pointer";
    }
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); fire(); }
    // Esc dismisses the panel without saving. The countdown is not cancelled —
    // only this box goes away.
    if (e.key === "Escape") { e.preventDefault(); stop(); }
  });
  save.addEventListener("click", fire);

  // The task visibly joining the list, in place. Same idea as the wall's own
  // confirmation: "saved" is a claim, a row appearing is the thing itself.
  function confirmSaved(text, merged, held, charge) {
    form.remove();
    // The reprieve is the headline when there is one — it is the thing that
    // just changed on this screen. The task landing is the supporting detail,
    // shown in the row below either way.
    if (held) {
      // The countdown is over: there is no wall coming, so a number still
      // ticking toward zero would be describing something that is not going to
      // happen. Swapped for a mark rather than blanked, so the panel keeps its
      // shape while it finishes.
      clearInterval(tick);
      ring.textContent = "✓";
      ring.style.background = "rgba(70,196,91,.16)";
      ring.style.color = "#46C45B";
      h.textContent = "Block called off";
      p.textContent = "This page, until you leave it.";
    } else {
      h.textContent = merged ? "Already on your list" : "Added to your tasks";
      p.textContent = merged ? "You'd written this one already." : "It'll be there when you get back.";
    }
    var row = document.createElement("div");
    row.style.cssText = "margin-top:9px;padding:8px 10px;background:#0f0f11;" +
      "border-radius:9px;display:flex;gap:7px;align-items:flex-start;" +
      "font-size:12.5px;line-height:1.35;letter-spacing:-.01em;" +
      (reduceMotion ? "" : "animation:__fsHuRow .3s cubic-bezier(.32,.72,0,1) both");
    var mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.style.cssText = "flex:none;color:" + (merged ? "#409CFF" : "#46C45B");
    mark.textContent = merged ? "•" : "✓";
    var label = document.createElement("span");
    label.style.cssText = "min-width:0;overflow-wrap:anywhere;color:#FFFFFF";
    label.textContent = text;
    row.appendChild(mark);
    row.appendChild(label);
    box.appendChild(row);

    // What it actually cost. Shown as a receipt rather than a warning — the
    // decision is made, and the point of the line now is that the number is
    // real and was really taken.
    if (charge && (charge.taken > 0 || charge.debt > 0)) {
      var cost = document.createElement("div");
      cost.style.cssText = "margin-top:7px;font-size:11.5px;line-height:1.35;" +
        "letter-spacing:-.004em;color:rgba(235,235,245,.42)";
      cost.textContent = charge.debt
        // Owing more than you hold is worth saying plainly. The task was still
        // saved — that is the promise — but the balance could not cover it, and
        // hiding that would make the wallet inexplicable later.
        ? "Took " + charge.taken + " of " + charge.price +
          " — you're out of coins. Saved anyway."
        : "−" + charge.taken + (charge.taken === 1 ? " coin" : " coins") +
          " · " + charge.balance + " left";
      box.appendChild(cost);
    }

    // Let it be read, then get out of the way. If the wall lands first it
    // removes this panel itself, which is fine — the task is already saved.
    setTimeout(stop, 3000);
  }

  var tick = setInterval(function () {
    left--;
    // The wall landed (or the page granted itself through) — stand down rather
    // than counting down over the top of it.
    if (document.getElementById("__focusshield__")) { stop(); return; }
    if (left <= 0) {
      // The countdown is spent, but the panel outlives it when there is
      // something in the box: yanking a half-typed sentence away at zero
      // destroys exactly the note this feature exists to capture. The wall is
      // about to cover the page anyway and removes this panel on arrival, so
      // holding on costs nothing and saves the sentence.
      ring.textContent = "0";
      clearInterval(tick);
      if (!input.value.trim() && !done) stop();
      return;
    }
    ring.textContent = String(left);
    if (left <= 3) {
      ring.style.background = "rgba(255,45,42,.18)";
      ring.style.color = "#FF453A";
    }
  }, 1000);

  function stop() {
    clearInterval(tick);
    if (!box.isConnected) return;
    if (reduceMotion) { box.remove(); return; }
    box.style.animation = "__fsHuOut .2s linear forwards";
    setTimeout(function () { box.remove(); }, 220);
  }

  // Hard ceiling. If the wall never arrives — the tab stopped being junk, the
  // worker was suspended, the user paused it from the popup — the panel must
  // still leave on its own. A countdown stuck at 0 on someone's screen with no
  // block behind it is worse than never having warned them.
  //
  // Generous, because it is now a box someone may be typing into: cut short at
  // the old (left+4) it would vanish mid-sentence on a page the wall never got
  // around to covering. Ninety seconds is far longer than the wall's own
  // arrival and still bounded.
  setTimeout(function () { if (!done) stop(); }, 90000);
}

// injected into the page — opaque wall. Flow: answer questions one at a time →
// AI judges → PASS = instant access (data.grantMinutes); FAIL = type 15 words within 3 min
// (fresh words + timer on each miss) to force your way in.
// data = { heading, fomo, todos[], questions[], host, title }
function showShield(data) {
  var ID = "__focusshield__";
  if (document.getElementById(ID)) return;
  if (window.__fsGrantedAt && (Date.now() - window.__fsGrantedAt) < 8000) return;

  function freezeMedia() {
    // Leave fullscreen first, or none of this is visible.
    //
    // A fullscreen element is promoted to the browser's top layer, which sits
    // above ALL normal stacking — z-index:2147483647 included. So a wall that
    // landed during fullscreen playback rendered behind the video and could not
    // be seen at all, while the pause below kept firing every 500ms: the video
    // stopped, nothing explained why, pressing space resumed it, and it stopped
    // again half a second later. A stutter loop with no visible cause reads as
    // a broken browser rather than a working blocker.
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    // Picture-in-Picture survives the wall the same way — the OS window stays
    // on top of the page and keeps playing.
    try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) {}
    document.querySelectorAll("video,audio").forEach(function (m) { try { m.pause(); } catch (e) {} });
  }
  freezeMedia();
  var freezer = setInterval(freezeMedia, 500);
  // Scroll is locked on BOTH elements. html alone was not enough: most real
  // sites (YouTube, Reddit, X, Gmail) scroll an inner container or body itself,
  // and html{overflow:hidden} does nothing to those — so the page stayed live
  // and scrolling behind the wall.
  var prevOverflow = document.documentElement.style.overflow;
  var prevBodyOverflow = document.body ? document.body.style.overflow : "";
  document.documentElement.style.overflow = "hidden";
  if (document.body) document.body.style.overflow = "hidden";

  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]; }); };

  // Whole minutes into "45m" / "2h 10m". Defined in here rather than borrowed
  // from the worker: this function is injected into the page, so it only has
  // what it brings with it and what's passed in `data`.
  function fmtSavedMins(m) {
    m = Math.max(0, Math.round(Number(m) || 0));
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + "h " + r + "m" : h + "h";
  }

  var questions = data.questions || [];
  var idx = 0;                 // which question
  var answers = [];
  var timerHandle = null;

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var reduceTransparency = false;
  try { reduceTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)").matches; } catch (e) {}
  var moreContrast = false;
  try { moreContrast = window.matchMedia("(prefers-contrast: more)").matches; } catch (e) {}

  var EASE = "cubic-bezier(.32,.72,0,1)";

  var wrap = document.createElement("div");
  wrap.id = ID;
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-label", "Focus block — justify this page to continue");
  // The wall must stay opaque enough that the page behind is genuinely gone —
  // this is a blocker, not a scrim. The blur is layered ON TOP of a near-solid
  // base so it reads as material without ever becoming see-through, and it is
  // dropped entirely when the user asks for reduced transparency.
  var useMaterial = !reduceTransparency && !moreContrast;
  var wrapStyle = [
    "position:fixed","inset:0","z-index:2147483647",
    "background:" + (useMaterial ? "rgba(0,0,0,.86)" : "#000000"),
    // Centred by the grid, which — unlike flex + align-items:center — never
    // clips the top of an over-tall child: the row floor is the content's own
    // height, so it grows downward and the wall scrolls instead. That means one
    // rule handles both cases and no JS has to measure anything.
    //
    // min-height uses dvh where supported (a fallback vh is emitted first).
    // Mobile browsers change viewport height as the URL bar hides, and vh alone
    // is frozen at the TALLER value, so the bottom of the wall sat under the
    // chrome and "Leave" became unreachable.
    "display:grid","place-items:center","min-height:100vh","min-height:100dvh",
    "overflow-y:auto","overscroll-behavior:contain",
    // Margins are the smallest that keep the panel off the screen edge, and
    // they shrink on small screens rather than being a fixed block of dead
    // space. env() keeps clear of notches / rounded corners.
    "padding:max(0.75rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right))" +
      " max(0.75rem, env(safe-area-inset-bottom)) max(0.75rem, env(safe-area-inset-left))",
    "box-sizing:border-box",
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif",
    "color:#FFFFFF"
  ];
  if (useMaterial) {
    wrapStyle.push("-webkit-backdrop-filter:blur(20px) saturate(180%)");
    wrapStyle.push("backdrop-filter:blur(20px) saturate(180%)");
  }
  // Materialize on enter: blur + scale together, so the surface arrives like a
  // physical panel rather than a flat opacity fade. Reduced motion gets the
  // plain cross-fade instead.
  wrapStyle.push("animation:" + (reduceMotion ? "__fsFade .12s linear" : "__fsIn .42s " + EASE));
  wrap.style.cssText = wrapStyle.join(";");

  var st = document.createElement("style");
  st.textContent =
    "@keyframes __fsFade{from{opacity:0}to{opacity:1}}" +
    "@keyframes __fsIn{from{opacity:0;-webkit-backdrop-filter:blur(0);backdrop-filter:blur(0)}" +
      "to{opacity:1}}" +
    "@keyframes __fsStep{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}" +
    "@keyframes __fsStepReduced{from{opacity:0}to{opacity:1}}" +
    "#" + ID + " ::placeholder{color:#5c554c}" +
    // Keyboard focus must be unmistakable on top of an opaque wall.
    "#" + ID + " :focus-visible{outline:2px solid #409CFF;outline-offset:3px;border-radius:12px}" +
    // focus ring on the text fields, which have no border of their own now
    "#" + ID + " input:focus,#" + ID + " textarea:focus{outline:none;box-shadow:0 0 0 4px rgba(64,156,255,.25)}" +
    // The wall's sizes are in rem, which resolve against the HOST PAGE's root
    // font size — a site that sets html{font-size:12px} shrank the whole wall.
    // Pin our own base so the wall is the same size on every site.
    //
    // The base then SCALES WITH THE VIEWPORT. Everything inside is sized in em,
    // so this one number sets the whole panel.
    //
    // Both axes feed it, because each one alone gets a case wrong: pure vh
    // makes a short wide window tiny, pure vw makes a tall narrow one huge.
    // The vh term leads (the buttons-below-the-fold failure is the one that
    // actually breaks the wall) with vw contributing enough to fill a big
    // display. The layout no longer depends on this fitting exactly — the grid
    // scrolls if it doesn't — so this is now purely about how big it FEELS.
    "#" + ID + "{font-size:clamp(15px, 1.55vh + 0.45vw, 27px)}" +
    // The wall is injected into arbitrary pages whose own CSS reaches every
    // element on the document. Pinning box-sizing keeps padded elements from
    // measuring wider than their container and scrolling the wall sideways.
    "#" + ID + ",#" + ID + " *{box-sizing:border-box}" +
    // The panel is a flex column, where children shrink by default. The things
    // you must be able to read and press are exempt: only the task list gives
    // up space. Without this a short window squeezed the textarea below its two
    // rows and flattened the buttons.
    "#" + ID + " .__fs_step > *{flex:none}" +
    // Buttons and fields carry their own floor. flex-shrink:0 alone does not
    // save them: a nested row (the Back/Next pair) is itself a flex container,
    // so its children are governed by that row rather than by the rule above,
    // and a column running short still compresses the row below its content
    // height — which centres the label into a box too short for it and shaves
    // the descenders off. min-height:fit-content is the actual guarantee.
    "#" + ID + " input,#" + ID + " textarea,#" + ID + " button{flex:none;min-height:fit-content}" +
    // The label is centred rather than left on the text baseline, so a button
    // reads the same whether or not its text has descenders.
    "#" + ID + " button{display:inline-flex;align-items:center;justify-content:center;line-height:1.2}" +
    // Rows of controls must not be squeezed shorter than the controls in them.
    "#" + ID + " .__fs_row{flex:none;align-items:stretch;min-height:fit-content}" +
    // …except the task card, which is the designated shrinkable one. Declared
    // after the blanket rule so it wins on source order at equal specificity.
    "#" + ID + " .__fs_flex{flex:0 1 auto;min-height:0}" +
    "#" + ID + " button{transition:transform .16s " + EASE + ",filter .16s " + EASE +
      ",background .16s " + EASE + ",border-color .16s " + EASE + ",color .16s " + EASE + "}" +
    "#" + ID + " button.__fs_press{transform:scale(.975);filter:brightness(.94)}" +
    (reduceMotion ? "#" + ID + " *{animation-duration:.01ms !important;transition-duration:.01ms !important}" +
      "#" + ID + " button.__fs_press{transform:none}" : "");
  wrap.appendChild(st);
  document.documentElement.appendChild(wrap);
  // The document_start placeholder has done its job — the real wall is up.
  var hold = document.getElementById("__fshold__");
  if (hold) hold.remove();
  // Same for the warning strip. Its own interval also notices the wall and
  // stands down, but that runs up to a second later — long enough for the strip
  // to be visibly sitting on top of the wall it was announcing.
  var hu = document.getElementById("__fsheadsup__");
  if (hu) hu.remove();

  // No pasting into the wall's fields. On the typing test this is the whole
  // point — copying the sentence would defeat the gate outright — and on the
  // questions it stops a canned answer being dropped in. Drag-and-drop and
  // middle-click paste are blocked for the same reason.
  ["paste", "drop", "dragover", "auxclick"].forEach(function (evt) {
    wrap.addEventListener(evt, function (e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
        e.preventDefault();
        sayBlocked();
      }
    }, true);
  });

  // Both screens carry a #__fs_hint now, but they differ: on the typing test
  // it starts empty and is owned by the matcher, while on the question screen
  // it holds standing copy that has to come back. data-fs-rest carries the
  // text to restore, so this doesn't need to know which screen it's on.
  var restoreHint = null;
  function sayBlocked() {
    var hint = wrap.querySelector("#__fs_hint");
    if (!hint) return;
    if (restoreHint) { clearTimeout(restoreHint); restoreHint = null; }
    var rest = hint.getAttribute("data-fs-rest");
    hint.textContent = "Type it out — pasting is disabled.";
    hint.style.color = "#FF9F0A";
    if (rest === null) return;          // typing test: the matcher takes it back
    restoreHint = setTimeout(function () {
      restoreHint = null;
      // The screen may have changed under the timer.
      var h = wrap.querySelector("#__fs_hint");
      if (!h || h !== hint) return;
      h.textContent = rest;
      h.style.color = "rgba(235,235,245,.60)";
    }, 2400);
  }

  // Belt and braces: block the shortcuts too, so a paste that never raises a
  // paste event still can't land.
  wrap.addEventListener("keydown", function (e) {
    if (!e.target || (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA")) return;
    var k = (e.key || "").toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "v") { e.preventDefault(); sayBlocked(); }
    if (e.shiftKey && e.key === "Insert") { e.preventDefault(); sayBlocked(); }
  }, true);

  // A task link is the way BACK to work, so it's the one navigation the wall
  // actively helps with. Handled here rather than by the anchor's own default:
  // the wall lives inside a blocked page, and a plain target=_blank inherits
  // that page's context. The worker opens it instead, and the wall stays up —
  // this tab is still blocked, you're just leaving it behind.
  wrap.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-fs-task-link]");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    var url = a.getAttribute("data-fs-task-link");
    if (!url) return;
    try { chrome.runtime.sendMessage({ type: "openTask", url: url }); } catch (err) {}
  }, true);

  // press feedback on pointer-down for every button inside the wall
  wrap.addEventListener("pointerdown", function (e) {
    var b = e.target.closest && e.target.closest("button");
    if (b) b.classList.add("__fs_press");
  });
  var clearPress = function () {
    var n = wrap.querySelectorAll("button.__fs_press");
    for (var i = 0; i < n.length; i++) n[i].classList.remove("__fs_press");
  };
  wrap.addEventListener("pointerup", clearPress);
  wrap.addEventListener("pointercancel", clearPress);
  wrap.addEventListener("pointerleave", clearPress);

  // Keep keyboard focus inside the wall. Without this, Tab walks straight into
  // the page behind it — the block would be defeated by pressing Tab twice.
  function focusables() {
    return wrap.querySelectorAll("input,textarea,button,[href],[tabindex]:not([tabindex='-1'])");
  }
  function trapKey(e) {
    if (e.key !== "Tab") return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", trapKey, true);
  // if focus escapes some other way (click, programmatic), pull it back
  function refocus(e) {
    if (!wrap.contains(e.target)) {
      var f = focusables();
      if (f.length) { e.stopPropagation(); f[0].focus(); }
    }
  }
  document.addEventListener("focusin", refocus, true);

  var torn = false;
  var byeTimer = null;      // the goodbye message's close delay
  function cleanup() {
    // Reachable twice: once from the button that dismissed the wall, and again
    // from the observer watching for the wall's removal — which that same
    // wrap.remove() below triggers.
    if (torn) return;
    torn = true;
    clearInterval(freezer);
    if (timerHandle) clearInterval(timerHandle);
    if (restoreHint) { clearTimeout(restoreHint); restoreHint = null; }
    if (byeTimer) { clearTimeout(byeTimer); byeTimer = null; }
    if (gone) { gone.disconnect(); gone = null; }
    document.removeEventListener("keydown", trapKey, true);
    document.removeEventListener("focusin", refocus, true);
    document.documentElement.style.overflow = prevOverflow;
    if (document.body) document.body.style.overflow = prevBodyOverflow;
    wrap.remove();
  }

  // The wall can leave the DOM without either button being pressed — a page
  // script wiping the body, an element deleted by hand, a framework re-render.
  // Nothing else notices, and what's left behind is worse than no wall at all:
  // the freezer keeps pausing every video on the page twice a second, and
  // refocus() — whose containment test can no longer be true for anything once
  // wrap is detached — swallows every focusin on the page and drags focus to a
  // node that isn't in the document. Every field on the page stops working. If
  // the tab is still junk the poll loop puts a fresh wall up within ~3s, but
  // the leak survives that, so the teardown has to be tied to the element.
  var gone = null;
  try {
    gone = new MutationObserver(function () {
      if (!wrap.isConnected) cleanup();
    });
    // wrap is a direct child of documentElement, so childList on that one node
    // is enough — subtree:true would fire the callback for every DOM change on
    // the page to learn nothing extra. If the page replaces documentElement
    // outright the observer goes with it, but the poll loop notices the missing
    // wall within ~3s and injects again from scratch.
    gone.observe(document.documentElement, { childList: true });
  } catch (e) {}
  // legit=true → the AI genuinely approved (may be remembered);
  // legit=false → forced in via typing test (timed access only, NEVER cached).
  function grantAndExit(legit) {
    window.__fsGrantedAt = Date.now();
    // A demo has nothing to grant. Sending grantAccess here would pause the
    // whole extension for three minutes because someone looked at a preview
    // during setup — the tool switching itself off is the opposite of what a
    // first run should teach.
    if (!data.demo) {
      try { chrome.runtime.sendMessage({ type: "grantAccess", host: data.host, title: data.title, legit: !!legit }); } catch (e) {}
    }
    cleanup();
  }
  // Does this page hold work that closing it would destroy? Checked before the
  // tab is closed, because "Leave" is meant to cost you a distraction, not a
  // half-written comment or a filled-in form. Deliberately conservative: it
  // only looks at fields the user has actually put something in, and it ignores
  // our own wall.
  function hasUnsavedWork() {
    try {
      var fields = document.querySelectorAll(
        "textarea, input[type=text], input[type=email], input[type=search], " +
        "input[type=url], input[type=tel], input[type=password], [contenteditable=true]"
      );
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (wrap.contains(f)) continue;                 // our own inputs
        var v = f.isContentEditable ? f.textContent : f.value;
        // A few characters is noise (a search box with a stray keystroke); a
        // real draft is longer. Twenty is high enough to ignore the former.
        if (v && String(v).trim().length >= 20) return true;
      }
    } catch (e) {}
    return false;
  }


  // The actual departure, split out so the goodbye screen's timer and the
  // teardown path agree on what leaving means.
  var keepTabOnLeave = false;
  var creditBanked = false;    // "leaving" is worth exactly one walk-away
  function finishLeaving() {
    cleanup();
    if (data.demo) return;
    if (keepTabOnLeave) {
      try { window.location.href = "about:blank"; } catch (e) {}
      return;
    }
    try { chrome.runtime.sendMessage({ type: "closeTab" }); } catch (e) {}
    try { window.close(); } catch (e) {}   // best-effort fallback
  }

  // Leaving goes straight to the goodbye now.
  //
  // There used to be a screen here asking "were you doing something?" before
  // the tab closed. It was asking too late to be worth answering: by the time
  // this wall is up the page is already covered, and the answer only ever
  // bought back a tab you had just chosen to abandon. The same question is now
  // asked by the countdown panel BEFORE anything is blocked, where answering it
  // actually protects the thing you were doing — so keeping a second copy here
  // meant being asked twice about one page, the second time pointlessly.
  function leave() {
    // Say what walking away just bought before the tab goes. Closing instantly
    // made the one good outcome the only one with no acknowledgement — the
    // grant screen states its terms, so leaving should get a moment too. The
    // worker is told on this side of the delay so the credit is recorded even
    // if the tab is closed by hand during it.
    // A demo credits nothing. Banking seven "saved" minutes for a preview would
    // put a number in the scoreboard that was never earned, and the scoreboard
    // is only worth reading if every figure in it is true.
    //
    // Guarded because leave() is attached to several buttons and the goodbye
    // screen can be reached more than once in a teardown race; a walk-away is
    // worth exactly one credit.
    if (!data.demo && !creditBanked) {
      creditBanked = true;
      try { chrome.runtime.sendMessage({ type: "leaving" }); } catch (e) {}
    }
    // Closing a tab that holds a half-written draft is destroying the user's
    // work to enforce a focus rule, which is a trade nobody agreed to. When
    // there is something in a field, the tab is navigated to a blank page
    // instead: the distraction is just as gone, the wall's promise is kept, and
    // the browser's own "leave site?" prompt gets a chance to intervene.
    var keepTab = !data.demo && hasUnsavedWork();
    keepTabOnLeave = keepTab;

    var box = document.createElement("div");
    box.innerHTML =
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .625em;opacity:.9">'
        : '') +
      '<h2 role="status" style="font-family:inherit;font-size:1.5em;line-height:1.16;' +
        'letter-spacing:-.028em;color:#46C45B;font-weight:700;margin:0 0 .5em">' +
        (data.demo
          ? 'That\'s the wall.'
          : 'Good. That\'s ' + (data.savedMinutes || 7) + ' minutes back.') + '</h2>' +
      '<p style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;' +
        'letter-spacing:-.01em;margin:0">' +
        (data.demo
          ? 'On a real page it closes the tab. Nothing was counted.'
          : (keepTab
              ? 'You had something typed here, so the tab stays open — leaving it blank.'
              : 'Closing the tab…')) +
      '</p>';
    swap(box);
    // Tracked so teardown can cancel it. Untracked, a wall removed during
    // this window would leave the timer to fire against a dead wall.
    byeTimer = setTimeout(function () {
      byeTimer = null;
      // The demo never closes the setup tab, and a page holding a draft goes to
      // about:blank rather than being closed — both handled by finishLeaving(),
      // which the capture screen ends in too.
      finishLeaving();
    }, data.demo ? 2200 : (keepTab ? 2200 : 1400));
  }

  function swap(node) {
    var old = wrap.querySelector(".__fs_step");
    if (old) old.remove();
    node.className = "__fs_step";
    // margin:auto centres the panel vertically while it fits and simply stops
    // centring once it's taller than the wall — which is what keeps a long task
    // list reachable instead of clipped off the top.
    // The panel is a column: the task list is the only part allowed to absorb
    // leftover space (and to give it back), so the question, the input and the
    // buttons keep their natural size and the buttons can never be pushed off
    // the bottom. Sizes are in em, so the fluid base scales the whole thing.
    // border-box so the horizontal padding is INSIDE width:100% — without it
    // the panel measured wider than its container on a narrow window and the
    // wall scrolled sideways. Host pages set wild global box-sizing, so it is
    // stated here rather than assumed.
    node.style.cssText = "max-width:34em;width:100%;box-sizing:border-box;" +
      "padding:1.25em 1.5em;text-align:center;" +
      "display:flex;flex-direction:column;min-height:0;" +
      "animation:" +
      (reduceMotion ? "__fsStepReduced .12s linear" : "__fsStep .28s " + EASE);
    wrap.appendChild(node);
  }
  function dots(count, at, color) {
    var d = "";
    for (var i = 0; i < count; i++) {
      var c = i < at ? "#46C45B" : (i === at ? (color || "#409CFF") : "#2C2C2E");
      var w = i === at ? "1.375em" : "0.438em";
      d += '<span style="height:.438em;width:' + w + ';border-radius:20px;background:' + c +
           ';transition:width .28s ' + EASE + ',background .28s ' + EASE + '"></span>';
    }
    return '<div aria-hidden="true" style="display:flex;gap:6px;justify-content:center;margin-bottom:1.25em">' + d + '</div>';
  }

  // Hosts arrive as the raw hostname, so "www." leaks into the UI where it
  // carries no meaning.
  function prettyHost(h) {
    return String(h || "this site").replace(/^www\./, "");
  }

  // The open tasks. This is the ARGUMENT the wall is making — "you said you'd
  // do something else" — so it leads the panel rather than trailing it as a
  // footnote under the buttons, where it read as decoration you scroll past.
  // Every task is listed: truncating to five and saying "and 2 more" hid the
  // exact thing the wall exists to remind you of. The list scrolls on its own
  // once it gets long, so a big backlog can't push the answer box off-screen.
  // last=true when the card ends the screen, so it drops the bottom margin it
  // otherwise needs to clear the answer box below it.
  function todoPanel(last) {
    var gap = last ? "0" : "0 0 1.25em";
    // Prefer the rich list (carries links); fall back to the flat strings so a
    // worker mid-update still renders something.
    var list = (data.todoItems && data.todoItems.length)
      ? data.todoItems.filter(function (t) { return t && t.text; })
      : (data.todos || []).filter(Boolean).map(function (t) { return { text: t, url: "", host: "" }; });
    if (!list.length) {
      // No tasks set is worth saying out loud — an empty list is the reason
      // this page looked appealing in the first place.
      return '<div style="margin:' + gap + ';padding:.75em .875em;background:#1C1C1E;border-radius:.75em;' +
        'text-align:left;font-size:.813em;line-height:1.45;letter-spacing:-.01em;color:rgba(235,235,245,.60)">' +
        'You set no tasks today. That\'s the real problem — not this page.' +
      '</div>';
    }
    // This sits between the question and the answer box, so every pixel it
    // takes is one the buttons lose. As the panel's only shrinkable child
    // (min-height:0 lets a flex item shrink below its content) it absorbs
    // slack on a tall screen and yields it on a short one, scrolling its own
    // list rather than pushing anything off the bottom.
    return '<div class="__fs_flex" style="margin:' + gap + ';padding:.75em .875em;background:#1C1C1E;' +
      'border-radius:.75em;text-align:left;display:flex;flex-direction:column">' +
      '<div style="font-size:.688em;font-weight:600;letter-spacing:.02em;text-transform:uppercase;' +
        'color:#409CFF;margin-bottom:.5em;flex:none">' +
        'Do this instead' +
      '</div>' +
      // Capped in vh, not em: the list is the one part that should give space
      // back when the window is short, and take it when there's room. Below the
      // cap it is simply as tall as its content — no dead space for one task.
      // The cap is a ceiling, not a target — flex shrinking can take it lower
      // still on a screen whose fixed content leaves less room.
      '<div style="max-height:min(14em, 26vh);overflow-y:auto;overscroll-behavior:contain;' +
        'flex:0 1 auto;min-height:0">' +
        list.map(function (t) {
          // A task carrying a link is the shortest path back to the work, so
          // it's a real anchor. The worker opens it in a new tab and the link
          // is already exempt from scanning, so clicking it can't re-trigger
          // the wall on arrival.
          var label = t.url
            ? '<a href="' + esc(t.url) + '" data-fs-task-link="' + esc(t.url) + '" ' +
                'rel="noreferrer noopener" ' +
                'style="font-size:.875em;line-height:1.4;letter-spacing:-.01em;color:#FFFFFF;' +
                'overflow-wrap:anywhere;min-width:0;text-decoration:none;border-bottom:1px solid rgba(64,156,255,.45)">' +
                esc(t.text) +
                '<span style="color:#409CFF;margin-left:.35em;font-size:.85em">&#8599;</span>' +
              '</a>'
            : '<span style="font-size:.875em;line-height:1.4;letter-spacing:-.01em;color:#FFFFFF;' +
                'overflow-wrap:anywhere;min-width:0">' + esc(t.text) + '</span>';
          return '<div style="display:flex;gap:.5em;align-items:baseline;padding:.156em 0">' +
            '<span aria-hidden="true" style="color:#409CFF;flex:none;font-size:.75em">&#8226;</span>' +
            label +
          '</div>';
        }).join("") +
      '</div>' +
    '</div>';
  }

  // ---------- PHASE 1: questions, one at a time ----------
  function renderQuestion() {
    var box = document.createElement("div");
    box.innerHTML =
      dots(questions.length, idx) +
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .625em;opacity:.95">'
        : '') +
      // Only on the first wall ever. Named so the user can connect what just
      // happened to a thing they chose to install, before they read it as an
      // attack on their browser.
      (data.firstEver
        ? '<div style="background:#1C1C1E;border-radius:.75em;padding:.75em .875em;margin-bottom:1em;' +
            'text-align:left;font-size:.813em;line-height:1.45;letter-spacing:-.01em;color:rgba(235,235,245,.60)">' +
            '<b style="color:#FFFFFF;font-weight:600">This is Nice Try — the extension you installed.</b><br>' +
            'You asked for this. Answer honestly and you get in; walk away and it counts in your favour.' +
          '</div>'
        : '') +
      '<div style="font-size:.813em;font-weight:600;letter-spacing:-.006em;color:#FF2D2A;margin-bottom:.75em">' + esc(data.heading) + '</div>' +
      // Large display type: negative tracking, tight leading — the size-specific
      // typography rule, not one tracking value applied everywhere.
      '<h2 id="__fs_q" style="font-family:inherit;font-size:1.625em;line-height:1.16;letter-spacing:-.028em;color:#fff;font-weight:700;margin:0 0 1em">' + esc(questions[idx]) + '</h2>' +
      // The tasks sit directly above the answer box: the last thing read before
      // typing an excuse should be the work the excuse is competing with.
      todoPanel() +
      '<input id="__fs_in" type="text" autocomplete="off" aria-labelledby="__fs_q" ' +
        'style="width:100%;background:#1C1C1E;border:none;border-radius:.75em;color:#FFFFFF;font-size:1.0625em;padding:.813em 1em;font-family:inherit;text-align:center;letter-spacing:-.01em;transition:box-shadow .16s ' + EASE + '" ' +
        'placeholder="answer honestly, then press Enter…">' +
      // Doubles as the paste-blocked notice. Without an element to write to,
      // a blocked paste on this screen did nothing visible at all and the
      // field simply looked broken. The standing copy comes back afterwards,
      // so nothing is permanently lost to a transient message.
      '<p id="__fs_hint" role="status" aria-live="polite" data-fs-rest="Your answers decide if you get in. Be honest — vague excuses fail." ' +
        'style="color:rgba(235,235,245,.60);font-size:.813em;line-height:1.4;letter-spacing:-.006em;margin:.625em 0 1em">' +
        'Your answers decide if you get in. Be honest — vague excuses fail.</p>' +
      '<div class="__fs_row" style="display:flex;gap:.625em">' +
        (idx === 0 ? "" : '<button id="__fs_back" style="background:#2C2C2E;border:none;color:#409CFF;border-radius:980px;padding:.875em 1.375em;font-size:1.0625em;font-weight:500;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Back</button>') +
        '<button id="__fs_next" style="flex:1;background:#2C2C2E;color:rgba(235,235,245,.30);border:none;border-radius:980px;padding:.875em;font-weight:600;font-size:1.0625em;cursor:not-allowed;font-family:inherit;letter-spacing:-.01em">' +
          (idx === questions.length - 1 ? "Submit for review" : "Next") + '</button>' +
      '</div>' +
      '<button id="__fs_leave" style="width:100%;margin-top:.875em;background:none;border:none;color:rgba(235,235,245,.60);font-size:.938em;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Leave — I don\'t need this</button>' +
      // Their own running total, directly under the button that adds to it.
      // Shown only once there is something to show.
      ((data.savedWeek && data.savedWeek.walks)
        ? '<p style="color:rgba(235,235,245,.30);font-size:.813em;line-height:1.4;' +
            'letter-spacing:-.006em;margin:.625em 0 0">You\'ve walked away ' +
            data.savedWeek.walks + (data.savedWeek.walks === 1 ? " time" : " times") +
            ' this week. That\'s ' + fmtSavedMins(data.savedWeek.minutes) + ' back.</p>'
        : '');
    swap(box);

    var input = box.querySelector("#__fs_in");
    var next = box.querySelector("#__fs_next");
    input.focus();
    if (answers[idx]) input.value = answers[idx];
    function ok() { return input.value.trim().length >= 2; }
    function paint() {
      var v = ok();
      next.style.background = v ? "#0A84FF" : "#2C2C2E";
      next.style.color = v ? "#FFFFFF" : "rgba(235,235,245,.30)";
      next.style.cursor = v ? "pointer" : "not-allowed";
      next.style.fontWeight = v ? "600" : "500";
      // aria-disabled (not the disabled attribute) keeps it focusable, so a
      // keyboard user can still reach it and hear why it won't activate.
      next.setAttribute("aria-disabled", v ? "false" : "true");
    }
    paint();
    input.addEventListener("input", paint);
    function go() {
      if (!ok()) return;
      answers[idx] = input.value.trim();
      if (idx === questions.length - 1) { submit(); return; }
      idx++; renderQuestion();
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
    next.addEventListener("click", go);
    var back = box.querySelector("#__fs_back");
    if (back) back.addEventListener("click", function () { idx--; renderQuestion(); });
    box.querySelector("#__fs_leave").addEventListener("click", leave);
  }

  // ---------- PHASE 2: submit answers → AI judges ----------
  function submit() {
    var box = document.createElement("div");
    box.innerHTML =
      '<div role="status" aria-live="polite" style="font-family:inherit;font-size:1.5em;font-weight:600;letter-spacing:-.024em;color:#fff;margin-bottom:.875em">Weighing your reasons…</div>' +
      // A spinner is a continuous animation — under reduced motion, show a
      // static indicator instead of a rotating one.
      (reduceMotion
        ? '<div aria-hidden="true" style="width:2.125em;height:2.125em;border:3px solid #2C2C2E;border-top-color:#409CFF;border-radius:50%;margin:.5em auto"></div>'
        : '<div aria-hidden="true" style="width:2.125em;height:2.125em;border:3px solid #2C2C2E;border-top-color:#409CFF;border-radius:50%;margin:.5em auto;animation:__fsSpin .8s linear infinite"></div>');
    swap(box);
    if (!wrap.querySelector("#__fsSpinKf")) {
      var k = document.createElement("style"); k.id = "__fsSpinKf";
      k.textContent = "@keyframes __fsSpin{to{transform:rotate(360deg)}}"; wrap.appendChild(k);
    }
    try {
      chrome.runtime.sendMessage(
        { type: "judgeAnswers", title: data.title, questions: questions, answers: answers },
        function (resp) {
          if (chrome.runtime.lastError || !resp) { startTypingSafe(""); return; }  // AI dead → typing test
          if (resp.pass) renderPass(resp.reason);
          else startTypingSafe(resp.sentence || "", resp.reason);
        }
      );
    } catch (e) { startTypingSafe(""); }
  }

  // ---------- PASS ----------
  // Both routes end on the same screen so the terms are always stated; the
  // AI's reason, when there is one, is carried through to it.
  function renderPass(reason) { renderGranted(true, reason); }

  // ---------- GRANTED: state the terms before letting go ----------
  // Reached from both routes. legit=true means the AI accepted the reasons;
  // false means the typing test was completed. Same grant either way, but
  // the wording differs — one was earned, the other was forced, and the tool
  // shouldn't congratulate someone for overriding it.
  function renderGranted(legit, reason) {
    var mins = data.grantMinutes || 5;
    var box = document.createElement("div");
    box.innerHTML =
      // Sized to match the question screen. This screen carries the most fixed
      // content of any step — mark, headline, clock card, terms, two buttons —
      // so oversized display type here was what pushed it off both ends.
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .5em;opacity:.9">'
        : '<div aria-hidden="true" style="font-size:2.25em;margin-bottom:.375em">' + (legit ? "✓" : "⏱") + '</div>') +
      '<h2 role="status" style="font-family:inherit;font-size:1.5em;line-height:1.16;letter-spacing:-.028em;color:' +
        (legit ? "#46C45B" : "#FFFFFF") + ';font-weight:700;margin:0 0 .625em">' +
        (legit ? "Fair enough. You're in." : "You typed it out. Fine.") + '</h2>' +
      '<div style="background:#1C1C1E;border-radius:.75em;padding:.813em 1em;margin-bottom:1em">' +
        '<div style="font-size:1.875em;font-weight:700;letter-spacing:-.028em;color:#409CFF;' +
          'font-variant-numeric:tabular-nums;line-height:1.1">' + mins + ':00</div>' +
        '<div style="font-size:.938em;color:#FFFFFF;letter-spacing:-.014em;margin-top:.375em">' +
          'Nice Try is off' +
        '</div>' +
        '<div style="font-size:.813em;color:rgba(235,235,245,.60);letter-spacing:-.006em;margin-top:.125em">' +
          'Nothing is blocked or tracked until it ends' +
        '</div>' +
      '</div>' +
      (legit && reason
        ? '<p style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;letter-spacing:-.01em;margin:0 0 .75em">' +
          esc(reason) + '</p>'
        : '') +
      '<p style="color:rgba(235,235,245,.60);font-size:.875em;line-height:1.4;letter-spacing:-.01em;margin:0 0 1.125em">' +
        (legit
          ? "The clock starts when you continue. When it runs out, everything is watched again."
          : "This wasn't earned, so it isn't remembered — you'll have to justify this page again next time.") +
      '</p>' +
      '<button id="__fs_enter" style="background:#0A84FF;color:#FFFFFF;border:none;border-radius:980px;padding:.875em 2em;' +
        'font-weight:600;font-size:1.0625em;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Start the ' + mins + ' minutes</button>' +
      '<button id="__fs_leave2" style="width:100%;margin-top:.875em;background:none;border:none;' +
        'color:rgba(235,235,245,.60);font-size:.938em;cursor:pointer;font-family:inherit;letter-spacing:-.01em">' +
        'Actually, take me back to work</button>' +
      // On the grant screen the tasks trail rather than lead — access is
      // already won, so this is a parting reminder, not the argument. The
      // wrapper must carry __fs_flex too: as a bare child of the flex column it
      // was pinned at full height by the blanket flex:none rule, so a long list
      // pushed this screen off both ends instead of scrolling inside the card.
      // The card carries a bottom margin for the question screen, where the
      // input follows it. Here it is last, so that margin is cancelled rather
      // than left as dead space above the panel's own padding.
      '<div class="__fs_flex" style="margin-top:1.25em;display:flex;flex-direction:column">' +
        todoPanel(true) +
      '</div>';
    swap(box);
    var go = box.querySelector("#__fs_enter");
    go.focus();
    go.addEventListener("click", function () { grantAndExit(legit); });
    box.querySelector("#__fs_leave2").addEventListener("click", leave);
  }

  // ---------- FAIL → 15 words, 3 minutes, retry on timeout ----------
  function startTyping(sentence, reason) {
    var LIMIT = 180;                     // 3 minutes
    var remaining = LIMIT;

    function draw(sent) {
      var box = document.createElement("div");
      box.innerHTML =
        '<div style="font-size:.813em;font-weight:600;letter-spacing:-.006em;color:#FF2D2A;margin-bottom:.875em">Not convincing enough</div>' +
        '<h2 style="font-family:inherit;font-size:1.625em;line-height:1.18;letter-spacing:-.028em;color:#fff;font-weight:700;margin:0 0 .5em">If you really need this, earn it.</h2>' +
        (reason ? '<p style="color:rgba(235,235,245,.60);font-size:.875em;line-height:1.45;letter-spacing:-.01em;margin:0 0 .5em">' + esc(reason) + '</p>' : '') +
        '<p id="__fs_lbl" style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;letter-spacing:-.01em;margin:0 0 1.125em">Type these 15 words within the time. Miss it and you get a fresh set.</p>' +
        // Rounded, tabular numerals — the iOS timer treatment. The digits must
        // not reflow as the countdown ticks.
        '<div id="__fs_clock" role="timer" aria-live="off" style="font-size:2.25em;font-weight:600;letter-spacing:-.02em;color:#409CFF;font-variant-numeric:tabular-nums;margin-bottom:1em;transition:color .28s ' + EASE + '">3:00</div>' +
        '<div style="background:#1C1C1E;border:none;border-radius:.75em;padding:1em;font-size:1.0625em;line-height:1.65;letter-spacing:-.01em;color:#409CFF;user-select:none;margin-bottom:.75em">' + esc(sent) + '</div>' +
        '<textarea id="__fs_in" rows="2" spellcheck="false" autocomplete="off" aria-labelledby="__fs_lbl" ' +
          'style="width:100%;background:#1C1C1E;border:none;border-radius:.75em;color:#FFFFFF;font-size:1.0625em;line-height:1.65;letter-spacing:-.01em;padding:.875em;font-family:inherit;resize:none;text-align:center;transition:box-shadow .16s ' + EASE + '" ' +
          'placeholder="type the 15 words…"></textarea>' +
        '<p id="__fs_hint" role="status" aria-live="polite" style="color:#FF2D2A;font-size:.813em;line-height:1.4;letter-spacing:-.006em;min-height:1em;margin:.625em 0 1.125em"></p>' +
        '<button id="__fs_leave" style="width:100%;background:#2C2C2E;border:none;color:rgba(235,235,245,.60);border-radius:980px;padding:.875em;font-size:1.0625em;font-weight:500;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Give up — leave the site</button>' +
        // The appeal. Deliberately the quietest thing on the screen: it is the
        // escape hatch for a wrong verdict, not a second "let me in" button. If
        // it looked like one it would simply become the path everyone takes and
        // the wall would stop meaning anything.
        //
        // It exists because title-only classification WILL misfire, and without
        // this the only remedy is typing fifteen words to reach a page that was
        // never a distraction — which is the moment an extension gets
        // uninstalled. It also produces the one thing that can make the
        // classifier better: labelled corrections.
        '<button id="__fs_appeal" style="width:100%;margin-top:.75em;background:none;border:none;' +
          'color:rgba(235,235,245,.30);font-size:.813em;cursor:pointer;font-family:inherit;' +
          'letter-spacing:-.006em;text-decoration:underline">This was flagged by mistake</button>';
      swap(box);

      var input = box.querySelector("#__fs_in");
      var clock = box.querySelector("#__fs_clock");
      var hint = box.querySelector("#__fs_hint");
      input.focus();

      if (timerHandle) clearInterval(timerHandle);
      remaining = LIMIT;
      timerHandle = setInterval(function () {
        remaining--;
        var mm = Math.floor(remaining / 60), ss = remaining % 60;
        clock.textContent = mm + ":" + (ss < 10 ? "0" : "") + ss;
        clock.style.color = remaining <= 30 ? "#FF2D2A" : "#409CFF";
        if (remaining <= 0) {
          clearInterval(timerHandle); timerHandle = null;
          // fresh words + fresh timer
          try {
            chrome.runtime.sendMessage({ type: "newSentence" }, function (r) {
              draw((r && r.sentence) ? r.sentence : sent);
            });
          } catch (e) { draw(sent); }
        }
      }, 1000);

      // The friction should come from typing fifteen words, not from fighting
      // the matcher. Case and runs of whitespace are normalised away: a mobile
      // keyboard capitalising the first word, or a double space after a word,
      // are not the user trying to cheat — they were just failing the test for
      // reasons that had nothing to do with the test.
      //
      // What is NOT normalised: the words themselves, their order, and the
      // requirement to type every one. That is the actual gate.
      function norm(s) { return String(s).trim().toLowerCase().replace(/\s+/g, " "); }
      var target = norm(sent);

      input.addEventListener("input", function () {
        var typed = norm(input.value);
        if (typed === target) {
          clearInterval(timerHandle); timerHandle = null;
          // Don't dump the user straight onto the page. Say what they've been
          // given and for how long, so the block ending is a decision they
          // acknowledge rather than something that just stops happening.
          renderGranted(false);
        } else if (typed && target.indexOf(typed) !== 0) {
          // Only once the text has actually diverged. Warning on every
          // keystroke meant the first letter of a correct attempt lit up red
          // and stayed red until the last word landed — the whole test read as
          // failing while it was being passed.
          // Colour is reasserted, not assumed: a blocked paste turns this
          // element amber, and without this a later mismatch would inherit
          // that colour instead of reading as an error.
          hint.textContent = "Doesn't match — type all 15 words in order.";
          hint.style.color = "#FF2D2A";
        } else { hint.textContent = ""; }
      });
      box.querySelector("#__fs_leave").addEventListener("click", leave);
      var appeal = box.querySelector("#__fs_appeal");
      if (appeal) appeal.addEventListener("click", function () {
        if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
        renderAppeal();
      });
    }
    draw(sentence);
  }

  // ---------- APPEAL: the verdict was wrong ----------
  // Asks for one sentence, then lets you in and REMEMBERS the correction, so
  // the same page isn't walled again tomorrow. The reason is required — not as
  // a hurdle, but because a correction with no statement of what was wrong
  // teaches the classifier nothing, and this screen's whole justification is
  // that it produces something learnable.
  function renderAppeal() {
    var box = document.createElement("div");
    box.innerHTML =
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .625em;opacity:.95">'
        : '') +
      '<div style="font-size:.813em;font-weight:600;letter-spacing:-.006em;color:#409CFF;margin-bottom:.75em">Correcting the verdict</div>' +
      '<h2 id="__fs_aq" style="font-family:inherit;font-size:1.5em;line-height:1.16;letter-spacing:-.028em;' +
        'color:#fff;font-weight:700;margin:0 0 .625em">What is this page actually for?</h2>' +
      '<p style="color:rgba(235,235,245,.60);font-size:.875em;line-height:1.45;letter-spacing:-.01em;margin:0 0 1em">' +
        'One line. This page stops being blocked, and Nice Try remembers it — ' +
        'so say what makes it work, not why you want it.</p>' +
      '<input id="__fs_ain" type="text" autocomplete="off" aria-labelledby="__fs_aq" ' +
        'style="width:100%;background:#1C1C1E;border:none;border-radius:.75em;color:#FFFFFF;' +
        'font-size:1.0625em;padding:.813em 1em;font-family:inherit;text-align:center;' +
        'letter-spacing:-.01em;transition:box-shadow .16s ' + EASE + '" ' +
        'placeholder="e.g. it\'s the docs for the library I\'m using">' +
      '<p id="__fs_hint" role="status" aria-live="polite" data-fs-rest="Be specific — this is what it learns from." ' +
        'style="color:rgba(235,235,245,.60);font-size:.813em;line-height:1.4;letter-spacing:-.006em;margin:.625em 0 1.125em">' +
        'Be specific — this is what it learns from.</p>' +
      '<div class="__fs_row" style="display:flex;gap:.625em">' +
        '<button id="__fs_aback" style="background:#2C2C2E;border:none;color:#409CFF;border-radius:980px;' +
          'padding:.875em 1.375em;font-size:1.0625em;font-weight:500;cursor:pointer;font-family:inherit;' +
          'letter-spacing:-.01em">Back</button>' +
        '<button id="__fs_asend" style="flex:1;background:#2C2C2E;color:rgba(235,235,245,.30);border:none;' +
          'border-radius:980px;padding:.875em;font-weight:600;font-size:1.0625em;cursor:not-allowed;' +
          'font-family:inherit;letter-spacing:-.01em">Unblock this page</button>' +
      '</div>';
    swap(box);

    var input = box.querySelector("#__fs_ain");
    var send = box.querySelector("#__fs_asend");
    input.focus();
    // A real sentence, not a shrug. Ten characters is low enough not to be a
    // puzzle and high enough that "no" and "work" don't clear it.
    function ok() { return input.value.trim().length >= 10; }
    function paint() {
      var v = ok();
      send.style.background = v ? "#0A84FF" : "#2C2C2E";
      send.style.color = v ? "#FFFFFF" : "rgba(235,235,245,.30)";
      send.style.cursor = v ? "pointer" : "not-allowed";
      send.setAttribute("aria-disabled", v ? "false" : "true");
    }
    paint();
    input.addEventListener("input", paint);

    function fire() {
      if (!ok()) return;
      // The correction is recorded and the verdict flipped by the worker; the
      // wall only reports what happened. A demo records nothing.
      if (!data.demo) {
        try {
          chrome.runtime.sendMessage({
            type: "appealVerdict",
            title: data.title,
            host: data.host,
            reason: input.value.trim()
          });
        } catch (e) {}
      }
      renderAppealDone();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); fire(); }
    });
    send.addEventListener("click", fire);
    box.querySelector("#__fs_aback").addEventListener("click", function () {
      startTypingSafe("");
    });
  }

  // Confirmation. Separate from the grant screen because the terms are
  // different: this is not five borrowed minutes, it is the verdict being
  // withdrawn — so it should not show a countdown implying the block returns.
  function renderAppealDone() {
    var box = document.createElement("div");
    box.innerHTML =
      '<div aria-hidden="true" style="font-size:2.25em;margin-bottom:.375em">✓</div>' +
      '<h2 role="status" style="font-family:inherit;font-size:1.5em;line-height:1.16;letter-spacing:-.028em;' +
        'color:#46C45B;font-weight:700;margin:0 0 .625em">Noted. That was our mistake.</h2>' +
      '<p style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;letter-spacing:-.01em;margin:0 0 1.25em">' +
        'This page won\'t be blocked again. If it keeps getting it wrong, ' +
        'sharpening your mission in Settings fixes it at the root.</p>' +
      '<button id="__fs_adone" style="background:#0A84FF;color:#FFFFFF;border:none;border-radius:980px;' +
        'padding:.875em 2em;font-weight:600;font-size:1.0625em;cursor:pointer;font-family:inherit;' +
        'letter-spacing:-.01em">Continue</button>';
    swap(box);
    var go = box.querySelector("#__fs_adone");
    go.focus();
    // legit=false: this must NOT re-enter the normal grant path, which would
    // start a global three-minute pause. The worker has already cached the
    // corrected verdict, so simply taking the wall down is enough — the next
    // classify() reads "productive" from cache and never re-walls.
    go.addEventListener("click", function () {
      window.__fsGrantedAt = Date.now();
      cleanup();
    });
  }

  // if the typing test is reached without a sentence (AI dead), fetch one first
  function startTypingSafe(sentence, reason) {
    if (sentence) { startTyping(sentence, reason); return; }
    try {
      chrome.runtime.sendMessage({ type: "newSentence" }, function (r) {
        startTyping((r && r.sentence) ? r.sentence : "focus work study code build learn grow steady honest patient effort matter choice moment reason", reason);
      });
    } catch (e) {
      startTyping("focus work study code build learn grow steady honest patient effort matter choice moment reason", reason);
    }
  }

  // ---------- STRICT: a focus session is running ----------
  // No questions, no typing test, no appeal. The session was started
  // deliberately, while thinking clearly, precisely so that this moment has no
  // negotiation available in it. The two actions offered are the only honest
  // ones: go back to the work, or end the session — and ending it is a single
  // named act, not something you can back into one page at a time.
  function renderStrict() {
    var left = Math.max(0, Number(data.sessionLeftMs) || 0);

    function fmtLeft(ms) {
      var s = Math.ceil(ms / 1000);
      var m = Math.floor(s / 60);
      var ss = s % 60;
      return m + ":" + (ss < 10 ? "0" : "") + ss;
    }

    var box = document.createElement("div");
    box.innerHTML =
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .625em;opacity:.95">'
        : '') +
      '<div style="font-size:.813em;font-weight:600;letter-spacing:-.006em;color:#46C45B;margin-bottom:.75em">' +
        esc(data.heading) + '</div>' +
      '<h2 style="font-family:inherit;font-size:1.625em;line-height:1.16;letter-spacing:-.028em;' +
        'color:#fff;font-weight:700;margin:0 0 .75em">You said this one was non-negotiable.</h2>' +
      // The clock is the argument. It is the thing the user set, counting down
      // in front of them, and it is far more persuasive than any sentence.
      '<div style="background:#1C1C1E;border-radius:.75em;padding:.938em 1em;margin-bottom:1em">' +
        '<div id="__fs_sclock" role="timer" aria-live="off" ' +
          'style="font-size:2.25em;font-weight:700;letter-spacing:-.028em;color:#46C45B;' +
          'font-variant-numeric:tabular-nums;line-height:1.1">' + fmtLeft(left) + '</div>' +
        '<div style="font-size:.938em;color:#FFFFFF;letter-spacing:-.014em;margin-top:.375em">' +
          'left in this session' +
        '</div>' +
        (data.sessionTask
          ? '<div style="font-size:.875em;color:rgba(235,235,245,.60);letter-spacing:-.006em;' +
              'margin-top:.375em;overflow-wrap:anywhere">on: ' + esc(data.sessionTask) + '</div>'
          : '') +
      '</div>' +
      '<p style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;letter-spacing:-.01em;margin:0 0 1.125em">' +
        'There are no questions this time. That was the point of starting it.</p>' +
      '<button id="__fs_sback" style="width:100%;background:#0A84FF;color:#FFFFFF;border:none;' +
        'border-radius:980px;padding:.875em;font-weight:600;font-size:1.0625em;cursor:pointer;' +
        'font-family:inherit;letter-spacing:-.01em">Back to work</button>' +
      // Ending the session is allowed — a tool that traps you is one you
      // uninstall — but it is named for what it is, and it is quiet.
      '<button id="__fs_sabandon" style="width:100%;margin-top:.875em;background:none;border:none;' +
        'color:rgba(235,235,245,.30);font-size:.813em;cursor:pointer;font-family:inherit;' +
        'letter-spacing:-.006em;text-decoration:underline">End the session early</button>' +
      '<div class="__fs_flex" style="margin-top:1.25em;display:flex;flex-direction:column">' +
        todoPanel(true) +
      '</div>';
    swap(box);

    var clock = box.querySelector("#__fs_sclock");
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(function () {
      left -= 1000;
      if (left <= 0) {
        clearInterval(timerHandle); timerHandle = null;
        // The session ended while the wall was up. The worker reaps it on its
        // own tick; the wall just gets out of the way rather than sitting on a
        // page as a block that no longer applies.
        cleanup();
        return;
      }
      clock.textContent = fmtLeft(left);
    }, 1000);

    var backBtn = box.querySelector("#__fs_sback");
    backBtn.focus();
    // "Back to work" closes the tab — same as Leave, because on a strict wall
    // there is nothing else this tab can become.
    backBtn.addEventListener("click", leave);

    box.querySelector("#__fs_sabandon").addEventListener("click", function () {
      if (data.demo) { cleanup(); return; }
      try {
        chrome.runtime.sendMessage({ type: "endSession" }, function () {
          // The session is over, so this page is judged on its own merits
          // again — which means the ordinary wall, not a free pass.
          window.__fsGrantedAt = Date.now();
          cleanup();
        });
      } catch (e) { cleanup(); }
    });
  }

  // start
  if (data.strict) { renderStrict(); }
  else if (!questions.length) { startTypingSafe(""); }
  else renderQuestion();
}
