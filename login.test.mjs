import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAuthorizeUrl, saveAuth } from "./login.mjs";

test("the authorize URL carries the three parameters the login page expects", () => {
  const url = new URL(
    buildAuthorizeUrl("https://catpaw.meituan.com/login?from=catpaw", {
      state: "s".repeat(32),
      redirect: "http://127.0.0.1:12345/callback",
      sid: "i".repeat(32),
    }),
  );
  assert.equal(url.host, "catpaw.meituan.com");
  assert.equal(url.searchParams.get("from"), "catpaw", "existing query is preserved");
  assert.equal(url.searchParams.get("state"), "s".repeat(32));
  assert.equal(url.searchParams.get("redirect"), "http://127.0.0.1:12345/callback");
  assert.equal(url.searchParams.get("sid"), "i".repeat(32));
});

test("a re-used entry URL gets its parameters replaced, not duplicated", () => {
  const entry = "https://catpaw.meituan.com/login?state=old&redirect=old&sid=old";
  const url = new URL(buildAuthorizeUrl(entry, { state: "new", redirect: "http://x/cb", sid: "sid" }));
  assert.equal(url.searchParams.get("state"), "new");
  assert.equal(url.searchParams.get("redirect"), "http://x/cb");
  assert.equal(url.searchParams.getAll("sid").length, 1);
});

test("the credential file has the shape the reader expects, and is private", () => {
  const dir = mkdtempSync(join(tmpdir(), "catpaw-auth-"));
  const authPath = join(dir, "nested", "auth.json");
  const record = saveAuth(authPath, {
    accessToken: "tok",
    account: { uid: 42, name: "mt测试", loginName: "mt测试" },
  });

  const written = JSON.parse(readFileSync(authPath, "utf8"));
  assert.deepEqual(written.auth, { loginType: "passport", accessToken: "tok", tokenType: "Bearer" });
  assert.equal(written.account.uid, "42", "uid is stored as a string");
  assert.equal(written.account.name, "mt测试");
  assert.equal(written.scopeSuffix, "-42");
  assert.equal(typeof written.updatedAt, "number");
  assert.deepEqual(written, record);

  // the harness re-reads this file on every call; it must not be world readable
  assert.equal(statSync(authPath).mode & 0o077, 0, "credential file should be private");
});

test("an account without uid still produces a usable record", () => {
  const dir = mkdtempSync(join(tmpdir(), "catpaw-auth-"));
  const authPath = join(dir, "auth.json");
  const record = saveAuth(authPath, { accessToken: "tok", account: {} });
  assert.equal(record.scopeSuffix, "");
  assert.equal(record.account.uid, "");
});
