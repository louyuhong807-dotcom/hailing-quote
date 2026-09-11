const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");

const hubei = "\u6e56\u5317\u4e13\u5347\u672c";
const hailing = "\u6d77\u9675\u5c9b";
const dinglong = "\u9f0e\u9f99\u6e7e";
const root = path.resolve(__dirname, "..");
const now = new Date().toISOString();
const post = (category, id) => ({
  category, title: id, url: `https://www.xiaohongshu.com/explore/${id}`,
  last_checked: now, latest_comments: [{ id, nickname: id, content: id, time_ms: Date.now(), time: now }],
});
const data = {
  xhs: { categories: [hailing, dinglong], checked_at: now, posts: [post(hailing, "hailing-post"), post(dinglong, "dinglong-post")] },
  douyin: { categories: [hailing, dinglong], posts: [] },
};
const links = { xhs: data.xhs.posts.map(({ category, url, title }) => ({ category, url, title })), douyin: [] };
const submitted = [];

async function main() {
  const html = await fs.readFile(path.join(root, "xhs-monitor.html"), "utf8");
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" });
  try {
    const context = await browser.newContext();
    await context.addInitScript(({ hubei }) => {
      localStorage.setItem("monitor-management-session-v1", JSON.stringify({
        token: "test-only", user: { username: "test", permissions: ["monitor:add", "monitor:view"] },
      }));
      localStorage.setItem("xhs-monitor-pending-links", JSON.stringify([
        { category: hubei, url: "https://xhslink.com/o/pending", createdAt: new Date().toISOString() },
        { url: "https://xhslink.com/o/legacy", createdAt: new Date().toISOString() },
      ]));
    }, { hubei });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/xhs-monitor.html") return route.fulfill({ contentType: "text/html", body: html });
      const platform = url.pathname.includes("douyin") ? "douyin" : "xhs";
      if (url.pathname.endsWith("-monitor-data.js")) return route.fulfill({
        contentType: "application/javascript", body: `window.${platform === "xhs" ? "XHS" : "DOUYIN"}_MONITOR_DATA = ${JSON.stringify(data[platform])};`,
      });
      if (url.pathname.endsWith("-monitor-links.json")) return route.fulfill({ json: links[platform] });
      if (/\/api\/(xhs|douyin)-add$/.test(url.pathname)) {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          submitted.push({ platform, ...body });
          assert.equal(body.category, "hubei");
          await new Promise((resolve) => setTimeout(resolve, 150));
          const added = { ...body, category: hubei };
          links[platform].push(added);
          return route.fulfill({ json: { ok: true, post: added, configured_count: links[platform].length } });
        }
        return route.fulfill({ json: { ok: true, links: links[platform], configured_count: links[platform].length } });
      }
      if (url.hostname === "github.com" && url.pathname.endsWith("/issues/new")) return route.fulfill({ body: "test-only" });
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://monitor.test/xhs-monitor.html?platform=xhs&area=${encodeURIComponent(hubei)}`);
    await page.waitForFunction(() => document.getElementById("postCount").textContent === "0 \u6761");
    assert.equal(await page.locator(".category-button").count(), 3);
    assert.equal(await page.locator("h1").textContent(), `${hubei}\u622a\u6d41`);
    assert.equal(await page.locator('#posts a[href="https://xhslink.com/o/pending"]').count(), 2);
    assert.doesNotMatch(await page.locator("#posts").textContent(), /hailing-post|dinglong-post/);
    assert.equal(await page.locator('#posts a[href="https://xhslink.com/o/legacy"]').count(), 0);
    assert.equal(await page.locator("#coverageCount").textContent(), "0/0 \u6761");

    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: width > 768 ? 1000 : 900 });
      const fits = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth <= innerWidth,
        tabs: [...document.querySelectorAll(".category-button")].every((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight),
      }));
      assert.deepEqual(fits, { page: true, tabs: true }, `Layout overflow at ${width}px`);
      const screenshot = path.join(os.tmpdir(), `hubei-monitor-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(screenshot);
    }

    const hubeiPost = post(hubei, "hubei-post");
    data.xhs.posts.push(hubeiPost);
    data.xhs.alert_history = [
      { ...hubeiPost.latest_comments[0], category: hubei, url: hubeiPost.url, title: hubeiPost.title },
      { ...post(hailing, "other-alert").latest_comments[0], category: hailing },
      { ...hubeiPost.latest_comments[0], id: "expired", content: "expired-alert", category: hubei, time_ms: Date.now() - 25 * 3600000 },
    ];
    links.xhs.push({ category: hubei, url: hubeiPost.url, title: hubeiPost.title });
    await page.evaluate(async () => { await refreshRemoteData(); await refreshConfiguredLinks(); });
    assert.equal(await page.locator("#postCount").textContent(), "1 \u6761");
    assert.equal(await page.locator("#coverageCount").textContent(), "1/1 \u6761");
    assert.match(await page.locator("#alerts").textContent(), /hubei-post/);
    assert.doesNotMatch(await page.locator("#alerts").textContent(), /other-alert|expired-alert/);
    assert.equal(await page.locator("#alerts details").getAttribute("open"), null);
    await page.locator(`[data-category="${hailing}"]`).click();
    assert.match(await page.locator("#posts").textContent(), /hailing-post/);
    assert.doesNotMatch(await page.locator("#posts").textContent(), /hubei-post|dinglong-post|pending/);
    await page.locator(`[data-category="${hubei}"]`).click();
    await page.locator("#newLinkInput").fill("https://xhslink.com/o/new-test");
    await page.locator("#addLinkButton").click();
    await page.locator('[data-platform="douyin"]').click();
    await page.waitForFunction(() => !document.getElementById("addLinkButton").disabled);
    assert.equal(await page.locator(".category-button.active").textContent(), hubei);
    assert.equal(await page.locator("#postCount").textContent(), "0 \u6761");
    assert.doesNotMatch(await page.locator("#posts").textContent(), /new-test|hubei-post|pending/);
    await page.locator("#newLinkInput").fill("https://www.douyin.com/video/new-test");
    await page.locator("#addLinkButton").click();
    await page.waitForFunction(() => !document.getElementById("addLinkButton").disabled);
    assert.equal(await page.locator("#postCount").textContent(), "1 \u6761");
    assert.equal(await page.locator("#coverageCount").textContent(), "0/1 \u6761");
    assert.equal(submitted.length, 2);

    await page.goto(`https://louyuhong807-dotcom.github.io/xhs-monitor.html?platform=xhs&area=${encodeURIComponent(hubei)}`);
    await page.locator("#newLinkInput").fill("https://xhslink.com/o/issue-test");
    await page.locator("#addLinkButton").click();
    await page.waitForURL("https://github.com/**");
    const issue = new URL(page.url());
    assert.ok(issue.searchParams.get("body").includes(`\u5206\u7ec4\uff1a${hubei}`));
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: empty category, isolated counts/comments, pending exclusion, both platforms, in-flight switching, GitHub intake and four viewport sizes.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
