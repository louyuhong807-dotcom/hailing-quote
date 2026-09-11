import assert from "node:assert/strict";
import { test } from "node:test";
import addXhs from "../api/xhs-add.mjs";
import addDouyin from "../api/douyin-add.mjs";
import monitorXhs from "../api/xhs-monitor.mjs";
import { createAccessToken } from "../api/_lib/auth.mjs";

process.env.MONITOR_AUTH_SECRET = "test-only";
process.env.XHS_GITHUB_TOKEN = "test-only";
process.env.XHS_SYNC_SECRET = "";

const hubei = "\u6e56\u5317\u4e13\u5347\u672c";
const groups = [
  ["hailing", "\u6d77\u9675\u5c9b"],
  ["dinglong", "\u9f0e\u9f99\u6e7e"],
  ["hubei", hubei],
];

function setup(t, files, commentsByUrl = {}) {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (Object.hasOwn(commentsByUrl, url)) return new Response(JSON.stringify({ commentData: { comments: commentsByUrl[url] } }));
    assert.equal(parsed.hostname, "api.github.com", "Unexpected external request");
    const name = parsed.pathname.split("/contents/")[1];
    assert.ok(Object.hasOwn(files, name), `Unexpected file: ${name}`);
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      files[name] = Buffer.from(body.content, "base64").toString("utf8");
      writes.push(name);
      return Response.json({ content: { sha: "new-sha" } });
    }
    return Response.json({ sha: "old-sha", content: Buffer.from(files[name]).toString("base64") });
  });
  return writes;
}

async function invoke(handler, body, authorized = true, method = "POST") {
  const req = { method, body, headers: {} };
  if (authorized) req.headers.authorization = `Bearer ${createAccessToken({ username: "test", role: "operator" })}`;
  const res = {
    status(code) { this.code = code; return this; },
    setHeader() { return this; },
    end(raw) { this.body = JSON.parse(raw); },
  };
  await handler(req, res);
  return res;
}

test("scan preserves each category and baselines new posts before alerts", async (t) => {
  const links = groups.map(([code, category]) => ({ category, title: code, url: `https://www.xiaohongshu.com/explore/${code}` }));
  const commentsByUrl = Object.fromEntries(links.map((post) => [post.url, [{
    id: `${post.title}-old`, content: "baseline", time: Date.now(), user: { nickname: "test" },
  }]]));
  const files = {
    "xhs-monitor-links.json": JSON.stringify(links),
    "xhs-monitor-data.js": "window.XHS_MONITOR_DATA = {};",
  };
  setup(t, files, commentsByUrl);
  const first = await invoke(monitorXhs, null, true, "GET");
  assert.equal(first.code, 200);
  assert.deepEqual(first.body.new_comments, []);
  const baseline = JSON.parse(files["xhs-monitor-data.js"].replace("window.XHS_MONITOR_DATA = ", "").replace(/;\s*$/, ""));
  assert.deepEqual(baseline.categories, groups.map(([, label]) => label));
  assert.deepEqual(baseline.posts.map((post) => post.category), groups.map(([, label]) => label));
  commentsByUrl[links[2].url].push({ id: "hubei-new", content: "new comment", time: Date.now(), user: { nickname: "test" } });
  const second = await invoke(monitorXhs, null, true, "GET");
  assert.equal(second.code, 200);
  assert.equal(second.body.new_comments.length, 1);
  assert.equal(second.body.new_comments[0].category, hubei);
});

for (const [name, handler, file, url] of [
  ["xhs", addXhs, "xhs-monitor-links.json", "https://www.xiaohongshu.com/explore/test"],
  ["douyin", addDouyin, "douyin-monitor-links.json", "https://www.douyin.com/video/test"],
  ["legacy xhs", monitorXhs, "xhs-monitor-links.json", "https://www.xiaohongshu.com/explore/test"],
]) {
  for (const [code, label] of groups) {
    for (const category of name === "legacy xhs" && code !== "hubei" ? [label] : [code, label]) {
      test(`${name}: preserves ${category}`, async (t) => {
        const original = { title: "existing", url: `${url}-existing`, category: groups[1][1] };
        const files = { [file]: JSON.stringify([original]) };
        const writes = setup(t, files);
        const result = await invoke(handler, { url, category, title: "test" });
        assert.equal(result.code, 200);
        assert.equal(result.body.post.category, label);
        assert.equal(result.body.configured_count, 2);
        assert.deepEqual(JSON.parse(files[file])[0], original);
        assert.equal(JSON.parse(files[file])[1].category, label);
        assert.deepEqual(writes, [file]);
      });
    }
  }
  test(`${name}: duplicate does not move between categories`, async (t) => {
    const existing = { url, title: "existing", category: groups[1][1] };
    const files = { [file]: JSON.stringify([existing]) };
    const writes = setup(t, files);
    await invoke(handler, { url: `${url}#fragment`, category: "hubei" });
    assert.deepEqual(JSON.parse(files[file]), [existing]);
    assert.deepEqual(writes, []);
  });
  test(`${name}: still requires authorization`, async (t) => {
    const files = { [file]: "[]" };
    const writes = setup(t, files);
    const result = await invoke(handler, { url, category: "hubei" }, false);
    assert.equal(result.code, 401);
    assert.deepEqual(writes, []);
  });
}
