const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const OWNER_REPLY_TEXTS = new Set([
  "私您啦，查收，请别相信其他人的私信，防止以防受骗",
  "查收[偷笑R]",
  "查收[害羞R]",
  "發您[害羞R]",
  "私信你了",
  "私您啦[飞吻R]",
]);

function jsonResponse(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/https?:\/\/[^\s，,。]+/i);
  if (!match) return "";
  try {
    const url = new URL(match[0]);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isXhsUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "xhslink.com" || host.endsWith(".xhslink.com") || host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  } catch {
    return false;
  }
}

function decodeText(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\\\//g, "/").trim();
}

function formatTime(ms) {
  const date = new Date(Number(ms || 0));
  if (Number.isNaN(date.getTime())) return "未知时间";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, item) => ({ ...acc, [item.type]: item.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function extractBalancedObject(text, key) {
  const start = text.indexOf(`"${key}":`);
  if (start < 0) return null;
  const brace = text.indexOf("{", start);
  if (brace < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let idx = brace; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(brace, idx + 1);
    }
  }
  return null;
}

async function fetchComments(url) {
  const response = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!response.ok) throw new Error(`小红书访问失败：${response.status}`);
  const finalUrl = normalizeUrl(response.url || url);
  const html = await response.text();
  const raw = extractBalancedObject(html, "commentData");
  if (!raw) return { finalUrl, comments: [] };
  const data = JSON.parse(raw);
  const rows = [];
  for (const comment of data.comments || []) {
    rows.push(comment, ...(comment.subComments || []));
  }
  const seen = new Set();
  const comments = rows.flatMap((item) => {
    const id = String(item.id || "");
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const content = decodeText(item.content);
    if (!content || OWNER_REPLY_TEXTS.has(content)) return [];
    const user = item.user || {};
    const timeMs = Number(item.time || 0);
    return [{
      id,
      content,
      nickname: decodeText(user.nickname) || "未知用户",
      xhs_user_id: decodeText(user.userId) || "页面未提供",
      time_ms: timeMs,
      time: formatTime(timeMs),
    }];
  }).sort((a, b) => b.time_ms - a.time_ms);
  return { finalUrl, comments };
}

function token() {
  return process.env.XHS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
}

function repoInfo() {
  const [owner, repo] = String(process.env.GITHUB_REPO || "louyuhong807-dotcom/hailing-quote").split("/");
  return { owner, repo, branch: process.env.GITHUB_BRANCH || "main" };
}

async function githubRequest(path, options = {}) {
  if (!token()) throw new Error("后台未配置 XHS_GITHUB_TOKEN");
  const { owner, repo } = repoInfo();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `GitHub 请求失败：${response.status}`);
  return data;
}

function decodeBase64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function encodeBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

async function readRepoFile(path) {
  const { branch } = repoInfo();
  const file = await githubRequest(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
  return { sha: file.sha, text: decodeBase64(file.content) };
}

async function writeRepoFile(path, previousSha, text, message) {
  const { branch } = repoInfo();
  return githubRequest(`/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      branch,
      message,
      sha: previousSha,
      content: encodeBase64(text),
    }),
  });
}

function parseDataJs(text) {
  const match = String(text || "").match(/window\.XHS_MONITOR_DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!match) return { checked_at: "", posts: [], new_comments: [], alert_history: [], errors: [] };
  return JSON.parse(match[1]);
}

function renderDataJs(data) {
  return `window.XHS_MONITOR_DATA = ${JSON.stringify(data, null, 2)};\n`;
}

async function loadStore() {
  const [linksFile, dataFile] = await Promise.all([
    readRepoFile("xhs-monitor-links.json"),
    readRepoFile("xhs-monitor-data.js"),
  ]);
  return {
    linksFile,
    dataFile,
    links: JSON.parse(linksFile.text),
    data: parseDataJs(dataFile.text),
  };
}

function makePost(title, url, finalUrl, comments, now) {
  return {
    title,
    url,
    final_url: finalUrl,
    last_checked: now,
    last_count: comments.length,
    latest_comments: comments.slice(0, 5),
    seen_ids: comments.map((item) => item.id),
  };
}

async function addLink(req, res) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const url = normalizeUrl(body.url);
  if (!url || !isXhsUrl(url)) return jsonResponse(res, 400, { error: "请提交有效的小红书链接" });
  const title = decodeText(body.title) || "新监控小红书帖子";
  const { finalUrl, comments } = await fetchComments(url);
  const store = await loadStore();
  const inputKey = url.toLowerCase();
  const finalKey = normalizeUrl(finalUrl).toLowerCase();
  const duplicate = [
    ...(store.links || []).map((item) => normalizeUrl(item.url).toLowerCase()),
    ...(store.data.posts || []).flatMap((post) => [normalizeUrl(post.url).toLowerCase(), normalizeUrl(post.final_url).toLowerCase()]),
  ].filter(Boolean).includes(inputKey) || (store.data.posts || []).some((post) => normalizeUrl(post.final_url).toLowerCase() === finalKey);
  if (duplicate) return jsonResponse(res, 409, { error: "这个链接已经在监控列表里，不能重复添加" });

  const now = new Date().toISOString();
  store.links.push({ title, url });
  store.data.checked_at = now;
  store.data.new_comments = [];
  store.data.errors = [];
  store.data.posts = [...(store.data.posts || []), makePost(title, url, finalUrl, comments, now)];

  await writeRepoFile("xhs-monitor-links.json", store.linksFile.sha, JSON.stringify(store.links, null, 2) + "\n", `Add XHS monitor link: ${title}`);
  await writeRepoFile("xhs-monitor-data.js", store.dataFile.sha, renderDataJs(store.data), `Initialize XHS monitor data: ${title}`);
  return jsonResponse(res, 200, { ok: true, post: store.data.posts.at(-1), message: "已接入后台监控，并已建立当前评论基线" });
}

async function syncLinks(res) {
  const store = await loadStore();
  const previousByUrl = new Map((store.data.posts || []).map((post) => [normalizeUrl(post.url).toLowerCase(), post]));
  const finalUrlSeen = new Map();
  const now = new Date().toISOString();
  const posts = [];
  const newComments = [];
  const errors = [];
  for (const [index, item] of (store.links || []).entries()) {
    const title = decodeText(item.title) || `小红书帖子 ${index + 1}`;
    const url = normalizeUrl(item.url);
    try {
      const { finalUrl, comments } = await fetchComments(url);
      const finalKey = normalizeUrl(finalUrl).toLowerCase();
      if (finalUrlSeen.has(finalKey)) {
        errors.push({ title, url, error: `重复帖子，已和「${finalUrlSeen.get(finalKey)}」指向同一篇小红书笔记` });
        continue;
      }
      finalUrlSeen.set(finalKey, title);
      const previous = previousByUrl.get(url.toLowerCase()) || {};
      const oldIds = new Set(previous.seen_ids || (previous.latest_comments || []).map((comment) => comment.id));
      const previousCheck = Date.parse(previous.last_checked || 0);
      const threshold = Number.isNaN(previousCheck) ? 0 : previousCheck - 120000;
      const fresh = comments.filter((comment) => oldIds.size && !oldIds.has(comment.id) && Number(comment.time_ms || 0) >= threshold);
      for (const comment of fresh) newComments.push({ title, url, ...comment });
      posts.push(makePost(title, url, finalUrl, comments, now));
    } catch (error) {
      errors.push({ title, url, error: String(error.message || error).slice(0, 220) });
      const previous = previousByUrl.get(url.toLowerCase());
      if (previous) posts.push({ ...previous, last_checked: now });
    }
  }
  store.data = {
    checked_at: now,
    posts,
    new_comments: newComments,
    alert_history: [...newComments, ...(store.data.alert_history || [])].slice(0, 30),
    errors,
  };
  await writeRepoFile("xhs-monitor-data.js", store.dataFile.sha, renderDataJs(store.data), "Sync XHS monitor data");
  return jsonResponse(res, 200, { ok: true, new_comments: newComments, errors, checked_at: now });
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
    if (req.method === "POST") return addLink(req, res);
    if (req.method === "GET") {
      if (process.env.XHS_SYNC_SECRET && req.query?.secret !== process.env.XHS_SYNC_SECRET) {
        return jsonResponse(res, 401, { error: "Unauthorized" });
      }
      return syncLinks(res);
    }
    return jsonResponse(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return jsonResponse(res, 500, { error: String(error.message || error) });
  }
}
