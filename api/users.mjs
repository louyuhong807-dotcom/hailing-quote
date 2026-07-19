import { hashPassword, jsonResponse, permissionsForRole, requirePermission } from "./_lib/auth.mjs";
import { readRepoFile, updateJsonFile } from "./_lib/github.mjs";

const VALID_ROLES = new Set(["admin", "operator", "viewer"]);

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    active: user.active !== false,
    permissions: permissionsForRole(user.role),
    updatedAt: user.updatedAt || user.createdAt,
  };
}

async function listUsers() {
  const file = await readRepoFile("monitor-users.json");
  return JSON.parse(file.text).users || [];
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
    const admin = requirePermission(req, res, "users:manage");
    if (!admin) return;
    if (req.method === "GET") {
      return jsonResponse(res, 200, { ok: true, users: (await listUsers()).map(publicUser) });
    }
    if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const displayName = String(body.displayName || username).trim().slice(0, 40);
    const role = String(body.role || "viewer");
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return jsonResponse(res, 400, { error: "账号需为 3 至 32 位字母、数字、点、横线或下划线" });
    if (!VALID_ROLES.has(role)) return jsonResponse(res, 400, { error: "账号角色无效" });
    if (password && password.length < 8) return jsonResponse(res, 400, { error: "密码至少需要 8 位" });

    const result = await updateJsonFile("monitor-users.json", (store) => {
      const users = Array.isArray(store.users) ? [...store.users] : [];
      const index = users.findIndex((item) => String(item.username).toLowerCase() === username);
      if (index < 0 && !password) throw new Error("新账号必须设置初始密码");
      const now = new Date().toISOString();
      const previous = index >= 0 ? users[index] : {};
      const passwordFields = password ? hashPassword(password) : { salt: previous.salt, passwordHash: previous.passwordHash };
      const next = {
        ...previous,
        username,
        displayName,
        role,
        active: body.active !== false,
        ...passwordFields,
        createdAt: previous.createdAt || now,
        updatedAt: now,
        updatedBy: admin.username,
      };
      if (index >= 0) users[index] = next;
      else users.push(next);
      return { value: { version: 1, users }, user: next };
    }, `Update monitor account: ${username}`);
    return jsonResponse(res, 200, { ok: true, user: publicUser(result.user) });
  } catch (error) {
    return jsonResponse(res, 500, { error: String(error.message || error).slice(0, 220) });
  }
}

