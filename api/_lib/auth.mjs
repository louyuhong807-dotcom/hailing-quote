import crypto from "node:crypto";

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const ROLE_PERMISSIONS = {
  admin: ["monitor:view", "monitor:add", "monitor:sync", "users:manage"],
  operator: ["monitor:view", "monitor:add"],
  viewer: ["monitor:view"],
};

export function setCors(res, methods = "GET,POST,OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function jsonResponse(res, status, body, methods) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  setCors(res, methods);
  res.end(JSON.stringify(body));
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function authSecret() {
  const secret = process.env.MONITOR_AUTH_SECRET || process.env.XHS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!secret) throw new Error("后台未配置登录密钥");
  return secret;
}

function signature(value) {
  return crypto.createHmac("sha256", authSecret()).update(value).digest("base64url");
}

export function createAccessToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    sub: user.username,
    name: user.displayName || user.username,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  }));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${signature(unsigned)}`;
}

export function verifyAccessToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = signature(unsigned);
  const actual = parts[2];
  if (actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.sub || !ROLE_PERMISSIONS[payload.role] || Number(payload.exp || 0) <= Date.now() / 1000) return null;
    return {
      username: payload.sub,
      displayName: payload.name || payload.sub,
      role: payload.role,
      permissions: ROLE_PERMISSIONS[payload.role],
    };
  } catch {
    return null;
  }
}

export function currentUser(req) {
  const header = String(req.headers?.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? verifyAccessToken(match[1]) : null;
}

export function requirePermission(req, res, permission) {
  const user = currentUser(req);
  if (!user) {
    jsonResponse(res, 401, { error: "请先登录管理账号", code: "AUTH_REQUIRED" });
    return null;
  }
  if (!user.permissions.includes(permission)) {
    jsonResponse(res, 403, { error: "当前账号没有此操作权限", code: "PERMISSION_DENIED" });
    return null;
  }
  return user;
}

export function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, passwordHash: hash };
}

export function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = crypto.scryptSync(String(password), String(salt), 64);
    const expected = Buffer.from(String(expectedHash), "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function verifyPlainPassword(value, expected) {
  const left = Buffer.from(crypto.createHash("sha256").update(String(value)).digest("hex"));
  const right = Buffer.from(crypto.createHash("sha256").update(String(expected)).digest("hex"));
  return crypto.timingSafeEqual(left, right);
}

