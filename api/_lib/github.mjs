export function githubToken() {
  return String(process.env.XHS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").replace(/\s+/g, "");
}

export function repoInfo() {
  const [owner, repo] = String(process.env.GITHUB_REPO || "louyuhong807-dotcom/hailing-quote").split("/");
  return { owner, repo, branch: process.env.GITHUB_BRANCH || "main" };
}

export async function githubRequest(path, options = {}) {
  if (!githubToken()) throw new Error("后台未配置 GitHub 写入密钥");
  const { owner, repo } = repoInfo();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `GitHub 请求失败：${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function readRepoFile(path) {
  const { branch } = repoInfo();
  const file = await githubRequest(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
  return {
    sha: file.sha,
    text: Buffer.from(String(file.content || ""), "base64").toString("utf8"),
  };
}

export async function writeRepoFile(path, previousSha, text, message) {
  const { branch } = repoInfo();
  return githubRequest(`/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      branch,
      message,
      sha: previousSha,
      content: Buffer.from(String(text), "utf8").toString("base64"),
    }),
  });
}

export async function updateJsonFile(path, updater, message, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const file = await readRepoFile(path);
      const current = JSON.parse(file.text);
      const result = await updater(current);
      if (result?.unchanged) return { ...result, value: current };
      const value = result?.value ?? result;
      await writeRepoFile(path, file.sha, `${JSON.stringify(value, null, 2)}\n`, message);
      return { ...result, value };
    } catch (error) {
      lastError = error;
      if (error.status !== 409 || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
    }
  }
  throw lastError;
}

