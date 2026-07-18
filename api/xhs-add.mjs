function jsonResponse(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

function safeTitle(value, category) {
  const text = decodeText(value).replace(/[\u2028\u2029\r\n\t]+/g, " ").trim();
  const fallback = `${category}新增监控帖子`;
  if (!text) return fallback;
  const beforeUrl = text.split(/https?:\/\//i)[0].trim();
  const title = (beforeUrl || text).replace(/[^\u4e00-\u9fa5a-zA-Z0-9 ，。！？、｜|/()+-]/g, "").trim();
  return title ? title.slice(0, 40) : fallback;
}

function cleanCategory(value) {
  const category = decodeText(value);
  if (category === "hailing") return "海陵岛";
  if (category === "dinglong") return "鼎龙湾";
  return category === "海陵岛" ? "海陵岛" : "鼎龙湾";
}

function token() {
  return String(process.env.XHS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").replace(/\s+/g, "");
}

function repoInfo() {
  const [owner, repo] = String(process.env.GITHUB_REPO || "louyuhong807-dotcom/hailing-quote").split("/");
  return { owner, repo, branch: process.env.GITHUB_BRANCH || "main" };
}

function decodeBase64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function encodeBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function githubRequest(path, options = {}) {
  if (!token()) throw new Error("后台未配置 XHS_GITHUB_TOKEN");
  const authToken = token();
  const { owner, repo } = repoInfo();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `GitHub 请求失败：${response.status}`);
  return data;
}

async function readLinksFile() {
  const { branch } = repoInfo();
  const file = await githubRequest(`/contents/xhs-monitor-links.json?ref=${encodeURIComponent(branch)}`);
  return {
    sha: file.sha,
    links: JSON.parse(decodeBase64(file.content)),
  };
}

async function writeLinksFile(previousSha, links, title) {
  const { branch } = repoInfo();
  return githubRequest("/contents/xhs-monitor-links.json", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      branch,
      message: "Add XHS monitor link",
      sha: previousSha,
      content: encodeBase64(JSON.stringify(links, null, 2) + "\n"),
    }),
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
    if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });

    const body = await readJsonBody(req);
    const url = normalizeUrl(body.url);
    if (!url || !isXhsUrl(url)) return jsonResponse(res, 400, { error: "请提交有效的小红书链接" });

    const category = cleanCategory(body.category);
    const title = safeTitle(body.title, category);
    const file = await readLinksFile();
    const inputKey = url.toLowerCase();
    const knownKeys = (file.links || []).map((item) => normalizeUrl(item.url).toLowerCase()).filter(Boolean);
    if (knownKeys.includes(inputKey)) return jsonResponse(res, 409, { error: "这个链接已经在监控列表里，不能重复添加" });

    const links = [...file.links, { title, url, category }];
    await writeLinksFile(file.sha, links, title);
    return jsonResponse(res, 200, {
      ok: true,
      configured_count: links.length,
      post: { title, url, category },
      message: "已接入后台监控，下一轮检查后会显示在页面里",
    });
  } catch (error) {
    return jsonResponse(res, 500, { error: String(error.message || error).slice(0, 220) });
  }
}
