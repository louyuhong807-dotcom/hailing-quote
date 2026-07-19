import { createAccessToken, jsonResponse, permissionsForRole, verifyPassword, verifyPlainPassword } from "./_lib/auth.mjs";
import { readRepoFile } from "./_lib/github.mjs";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function storedUsers() {
  try {
    const file = await readRepoFile("monitor-users.json");
    return JSON.parse(file.text).users || [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
    if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!username || !password) return jsonResponse(res, 400, { error: "请输入账号和密码" });

    const adminUsername = String(process.env.MONITOR_ADMIN_USERNAME || "admin").trim().toLowerCase();
    const adminPassword = String(process.env.MONITOR_ADMIN_PASSWORD || "");
    let user = null;
    if (adminPassword && username === adminUsername && verifyPlainPassword(password, adminPassword)) {
      user = { username: adminUsername, displayName: "系统管理员", role: "admin", active: true };
    } else {
      const found = (await storedUsers()).find((item) => String(item.username).toLowerCase() === username);
      if (found?.active !== false && verifyPassword(password, found?.salt, found?.passwordHash)) user = found;
    }
    if (!user) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return jsonResponse(res, 401, { error: "账号或密码不正确" });
    }
    const token = createAccessToken(user);
    return jsonResponse(res, 200, {
      ok: true,
      token,
      expires_in: 7 * 24 * 60 * 60,
      user: {
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
        permissions: permissionsForRole(user.role),
      },
    });
  } catch (error) {
    return jsonResponse(res, 500, { error: String(error.message || error).slice(0, 220) });
  }
}

