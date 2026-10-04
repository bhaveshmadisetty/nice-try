// A task link exempts ONE page, never a class of pages. Every assertion here is
// a collision that was real: two different pages that reduced to one identity,
// so attaching the first to a to-do silently exempted the second.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extensionRoot = require("../extension-root.cjs");
const test = require("node:test");
const vm = require("node:vm");

// Take the shipped function, not a copy of it. A copy drifts and then the test
// passes while the extension is broken.
const bg = fs.readFileSync(path.join(extensionRoot, "src/background.js"), "utf8");
const start = bg.indexOf("function linkIdentity(url)");
assert.ok(start >= 0, "linkIdentity not found");
const tableStart = bg.indexOf("const ID_PARAM_HOSTS = {", start);
const tableEnd = bg.indexOf("};", tableStart) + 2;
assert.ok(tableStart > start && tableEnd > tableStart, "ID_PARAM_HOSTS not found");
const fnEnd = bg.indexOf("\n}", start) + 2;
const context = { URL };
vm.createContext(context);
vm.runInContext(bg.slice(tableStart, tableEnd) + "\n" + bg.slice(start, fnEnd), context);
const linkIdentity = context.linkIdentity;

test("a video is identified by its id, not by the shared /watch path", () => {
  assert.equal(linkIdentity("https://www.youtube.com/watch?v=abc"), "youtube.com/watch?v=abc");
  // A timestamp is the same page resumed, not a different page.
  assert.equal(linkIdentity("https://www.youtube.com/watch?v=abc&t=90"), "youtube.com/watch?v=abc");
  assert.notEqual(linkIdentity("https://www.youtube.com/watch?v=abc"),
                  linkIdentity("https://www.youtube.com/watch?v=zzz"));
});

test("an uppercased path cannot skip the video-id branch", () => {
  // YouTube serves /WATCH as /watch. A literal === fell through to host+path,
  // so one mixed-case link exempted every watch page on the site.
  assert.equal(linkIdentity("https://youtube.com/WATCH?v=abc"), "youtube.com/watch?v=abc");
  assert.notEqual(linkIdentity("https://youtube.com/WATCH?v=abc"), "youtube.com/WATCH");
});

test("a watch URL with no readable id exempts nothing", () => {
  // Returning the bare path here would match every video whose id we failed to
  // read. An unexemptable page is walled; that is the safe failure direction.
  assert.equal(linkIdentity("https://www.youtube.com/watch"), "");
  assert.equal(linkIdentity("https://www.youtube.com/watch?V=abc"), "");
});

test("playlists are told apart by ?list=", () => {
  // The real bug: both reduced to "youtube.com/playlist", so a study playlist
  // on a to-do exempted a music playlist too.
  const study = linkIdentity("https://www.youtube.com/playlist?list=PL_DSA");
  const music = linkIdentity("https://www.youtube.com/playlist?list=PL_MUSIC");
  assert.equal(study, "youtube.com/playlist?list=PL_DSA");
  assert.notEqual(study, music);
  assert.equal(linkIdentity("https://www.youtube.com/playlist"), "");
});

test("shorts and youtu.be keep their own identity", () => {
  assert.equal(linkIdentity("https://www.youtube.com/shorts/aaa"), "youtube.com/shorts/aaa");
  assert.notEqual(linkIdentity("https://www.youtube.com/shorts/aaa"),
                  linkIdentity("https://www.youtube.com/shorts/bbb"));
  // A short link is the same video as the long one.
  assert.equal(linkIdentity("https://youtu.be/abc"), "youtube.com/watch?v=abc");
});

test("a feed is never the same identity as a page on it", () => {
  for (const [page, feed] of [
    ["https://www.reddit.com/r/x/comments/1/t", "https://www.reddit.com/"],
    ["https://www.instagram.com/p/XYZ/",        "https://www.instagram.com/"],
    ["https://x.com/u/status/1",               "https://x.com/"],
    ["https://www.netflix.com/watch/8012",      "https://www.netflix.com/browse"],
  ]) assert.notEqual(linkIdentity(page), linkIdentity(feed), page);
});

test("non-web URLs have no identity", () => {
  for (const u of ["chrome://extensions", "file:///c:/x.html", "about:blank", "not a url"]) {
    assert.equal(linkIdentity(u), "");
  }
});
