/**
 * CatPaw (妙手) Passport QR login, ported out of the desktop app.
 *
 * The app performs login as a pure HTTP flow; nothing in it needs Electron:
 *
 *   1. GET  {gateway}/api/gateway/passport/login-config  -> { loginEntryUrl }
 *   2. build {loginEntryUrl}?state=<hex>&redirect=http://127.0.0.1:<port>/callback&sid=<hex>
 *   3. open it in a browser; the user scans the QR code / confirms
 *   4. race two channels for the token:
 *        a) loopback: the browser redirects to http://127.0.0.1:<port>/callback?token=..&state=..
 *        b) polling : GET {gateway}/api/gateway/passport/poll-token?sid=<hex>
 *   5. write ~/.meituan-catpaw/auth.json
 *
 * Personal (Passport) tokens carry no refresh token: the app itself reports
 * `canRefresh: false` for this provider, so an expired token always means a
 * fresh scan. Enterprise (EPassport) accounts use the device-code flow at
 * passport.catpaw.meituan.com and do return a refresh token.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_GATEWAY = "https://catx.nocode.cn";
export const LOGIN_CONFIG_PATH = "/api/gateway/passport/login-config";
export const POLL_PATH = "/api/gateway/passport/poll-token";
export const CURRENT_USER_PATH = "/api/gateway/passport/current-user";

const DEFAULT_TIMEOUT_MS = 300000;
const POLL_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;

const SUCCESS_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>登录成功 - CatPaw</title>
<body style="font-family:system-ui;padding:48px">
<h1>登录成功</h1><p>已把凭据交给 DeepSeek Harness，可以关闭此页面。</p></body></html>`;

const ERROR_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>登录失败 - CatPaw</title>
<body style="font-family:system-ui;padding:48px">
<h1>登录失败</h1><p>未获取到登录凭据，请回到 DeepSeek Harness 重新发起登录。</p></body></html>`;

function hex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function jsonRequest(baseURL, path, { method = "GET", token, body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timer = AbortSignal.timeout(timeoutMs);
  const composite = signal ? AbortSignal.any([signal, timer]) : timer;
  return fetch(`${baseURL}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { "X-Auth-Token": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: composite,
  }).then(async (response) => {
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${path} 返回了非 JSON 响应 (HTTP ${response.status})`);
    }
    if (!response.ok || (typeof payload?.code === "number" && payload.code !== 0)) {
      const message = payload?.message || `HTTP ${response.status}`;
      throw new Error(`${path} 失败：${message}`);
    }
    return payload?.data ?? null;
  });
}

/** Ask the gateway where the login page lives. Needs no credentials. */
export async function fetchLoginConfig({ baseURL = DEFAULT_GATEWAY, signal } = {}) {
  const data = await jsonRequest(baseURL, LOGIN_CONFIG_PATH, { signal });
  const loginEntryUrl = data?.loginEntryUrl;
  if (typeof loginEntryUrl !== "string" || loginEntryUrl.length === 0) {
    throw new Error("login-config 没有返回 loginEntryUrl");
  }
  return { loginEntryUrl };
}

/** Append the three query parameters the login page expects. */
export function buildAuthorizeUrl(loginEntryUrl, { state, redirect, sid }) {
  const url = new URL(loginEntryUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect", redirect);
  url.searchParams.set("sid", sid);
  return url.toString();
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Loopback listener for the browser redirect. Falls back to polling alone when
 * the port cannot be bound (the app does the same).
 */
export function startCallbackServer() {
  return new Promise((resolve, reject) => {
    let settle;
    let fail;
    const tokenPromise = new Promise((res, rej) => {
      settle = res;
      fail = rej;
    });
    const server = createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end(ERROR_HTML);
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404).end(ERROR_HTML);
        return;
      }
      const token = url.searchParams.get("token") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!token) {
        res.writeHead(400).end(ERROR_HTML);
        fail(new Error("回调没有携带 token"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_HTML);
      settle({ token, state });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        redirect: `http://127.0.0.1:${port}/callback`,
        waitForToken: () => tokenPromise,
        close: () => {
          try {
            server.close();
          } catch {}
        },
      });
    });
  });
}

/** One poll attempt; null while the user has not approved yet. */
export async function pollToken(sid, { baseURL = DEFAULT_GATEWAY, signal } = {}) {
  const data = await jsonRequest(baseURL, `${POLL_PATH}?sid=${encodeURIComponent(sid)}`, { signal });
  if (!data) return null;
  if (typeof data === "string") return { token: data };
  const token = data.token ?? data.accessToken ?? data.access_token;
  if (typeof token !== "string" || token.length === 0) return null;
  return { token, raw: data };
}

/** Resolve the signed-in identity for a fresh token. */
export async function whoami(token, { baseURL = DEFAULT_GATEWAY, signal } = {}) {
  const data = await jsonRequest(baseURL, CURRENT_USER_PATH, { token, signal });
  if (!data || typeof data !== "object") return null;
  const uid = data.userId == null ? "" : String(data.userId);
  const name = data.userName || data.name || "";
  return { uid, loginName: name, name };
}

/** Whether the stored token is still accepted by the gateway. */
export async function validateToken(token, { baseURL = DEFAULT_GATEWAY, signal } = {}) {
  try {
    await whoami(token, { baseURL, signal });
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expired = /401|403|token|expired|认证|登录/i.test(message);
    return { valid: false, expired, message };
  }
}

/** Persist credentials in the exact shape the desktop app writes. */
export function saveAuth(authPath, { accessToken, account = {}, loginType = "passport", extra = {} }) {
  const uid = account.uid ? String(account.uid) : "";
  const record = {
    auth: { loginType, accessToken, tokenType: "Bearer" },
    account: { uid, loginName: account.loginName ?? "", name: account.name ?? "", entId: account.entId ?? "" },
    ...extra,
    scopeSuffix: uid ? `-${uid}` : "",
    updatedAt: Date.now(),
  };
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

/**
 * Run one interactive login.
 *
 * `onUrl` fires as soon as the authorize URL exists, so a caller (the plugin
 * tool) can hand it to the user without waiting for the scan.
 */
export async function runLogin({
  baseURL = DEFAULT_GATEWAY,
  authPath,
  onUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  openBrowser = true,
} = {}) {
  const controller = new AbortController();
  const relay = () => controller.abort(new Error("登录已取消"));
  if (signal?.aborted) relay();
  else signal?.addEventListener("abort", relay, { once: true });

  const timer = setTimeout(() => controller.abort(new Error("登录超时，请重新发起")), timeoutMs);
  const state = hex(16);
  const sid = hex(16);

  let callback = null;
  try {
    callback = await startCallbackServer();
  } catch {
    callback = null;
  }

  try {
    const config = await fetchLoginConfig({ baseURL, signal: controller.signal });
    const redirect = callback?.redirect ?? "http://127.0.0.1:0/callback";
    const url = buildAuthorizeUrl(config.loginEntryUrl, { state, redirect, sid });
    const opened = openBrowser ? openInBrowser(url) : false;
    await onUrl?.(url, { sid, state, opened, loopback: callback !== null });

    const channels = [
      (async () => {
        for (;;) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const hit = await pollToken(sid, { baseURL, signal: controller.signal });
          if (hit) return hit;
          await new Promise((resolve, reject) => {
            const wait = setTimeout(resolve, POLL_INTERVAL_MS);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(wait);
                reject(controller.signal.reason);
              },
              { once: true },
            );
          });
        }
      })(),
    ];
    if (callback) {
      channels.push(
        callback.waitForToken().then(({ token, state: returned }) => {
          if (returned && returned !== state) throw new Error("回调 state 不匹配，可能存在 CSRF");
          return { token, channel: "loopback" };
        }),
      );
    }

    const hit = await Promise.race(channels);
    const account = (await whoami(hit.token, { baseURL, signal: controller.signal })) ?? {};
    const saved = authPath ? saveAuth(authPath, { accessToken: hit.token, account }) : null;
    return { accessToken: hit.token, account, channel: hit.channel ?? "poll", authPath, record: saved };
  } finally {
    clearTimeout(timer);
    callback?.close();
    controller.signal.removeEventListener("abort", relay);
    if (!controller.signal.aborted) controller.abort(new Error("登录已结束"));
  }
}

/**
 * The catalogue 妙手 itself shows: the twelve real modelTypes and the
 * parameters each one accepts. Used by `catpaw_doctor` to tell a user whose
 * account gained or lost a model that their row config is stale.
 */
export async function fetchModelTypes(token, { baseURL = "https://ai.catpaw.meituan.com", signal } = {}) {
  const timer = AbortSignal.timeout(12000);
  const composite = signal ? AbortSignal.any([signal, timer]) : timer;
  const response = await fetch(`${baseURL}/api/agent/maas/model-types`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Access-Token": token,
      "x-passport-token": token,
    },
    body: JSON.stringify({ tenant: "CatDesk", scene: "CATX_APP", env: "EXTERNAL" }),
    signal: composite,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`model-types HTTP ${response.status}: ${text.slice(0, 200)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("model-types returned non-JSON");
  }
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.data?.modelTypes) ? payload.data.modelTypes : [];
  return list
    .map((item) => ({
      id: String(item?.modelTypeId ?? item?.id ?? ""),
      name: String(item?.modelTypeName ?? item?.name ?? ""),
      params: (item?.parameterDefinitions ?? []).map((param) => String(param?.id ?? "")).filter(Boolean),
    }))
    .filter((model) => model.id.length > 0);
}
