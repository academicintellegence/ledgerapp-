"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server/app");
const { createMemoryStore } = require("../server/store");

// Fake Google: maps a token string to a verified profile (or throws).
const PROFILES = {
  "tok-alice": { sub: "g-alice", email: "alice@example.com", email_verified: true, name: "Alice" },
  "tok-bob": { sub: "g-bob", email: "Bob@Example.com", email_verified: true, name: "Bob" },
  "tok-eve": { sub: "g-eve", email: "eve@example.com", email_verified: true, name: "Eve" },
  "tok-unverified": { sub: "g-u", email: "u@example.com", email_verified: false },
};
async function verifyGoogle(credential) {
  if (!PROFILES[credential]) throw new Error("bad token");
  return PROFILES[credential];
}

const PIXEL = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");

let tmpPublic;
function boot(configOverrides = {}) {
  const store = createMemoryStore();
  const app = createApp({
    store,
    verifyGoogle,
    config: {
      googleClientId: "client-id",
      sessionSecret: "x".repeat(40),
      publicDir: tmpPublic,
      rateLimitPerMinute: 100000,
      ...configOverrides,
    },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, store, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function client(base) {
  let cookie = "";
  async function call(method, url, body, headers = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: "manual" });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (name === "ledger_session") cookie = value ? `${name}=${value}` : "";
    }
    return res;
  }
  return {
    call,
    get: (u, h) => call("GET", u, undefined, h),
    put: (u, b, h) => call("PUT", u, b, h),
    post: (u, b, h) => call("POST", u, b, h),
    del: (u, h) => call("DELETE", u, undefined, h),
    async login(token) {
      const r = await call("POST", "/api/auth/google", { credential: token });
      return r;
    },
    get hasCookie() {
      return cookie !== "";
    },
  };
}

let ctx;
before(() => {
  tmpPublic = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-public-"));
  fs.writeFileSync(path.join(tmpPublic, "index.html"), "<h1>app</h1>");
  fs.writeFileSync(path.join(tmpPublic, "sw.js"), "// sw");
});
after(() => fs.rmSync(tmpPublic, { recursive: true, force: true }));

test("health check, static app and service-worker caching header", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    assert.equal(await (await c.get("/healthz")).text(), "ok");
    assert.match(await (await c.get("/")).text(), /<h1>app<\/h1>/);
    assert.equal((await c.get("/sw.js")).headers.get("cache-control"), "no-cache");
    assert.equal((await c.get("/api/config")).status, 200);
  } finally {
    ctx.server.close();
  }
});

test("auth: requires login, rejects bad/unverified tokens, honours the invite list", async () => {
  ctx = await boot({ allowedEmails: new Set(["alice@example.com", "bob@example.com"]) });
  try {
    const c = client(ctx.base);
    assert.equal((await c.get("/api/me")).status, 401);
    assert.equal((await c.get("/api/data/entries")).status, 401);
    assert.equal((await c.login("nope")).status, 401);
    assert.equal((await c.login("tok-unverified")).status, 401);
    assert.equal((await c.login("tok-eve")).status, 403); // not invited
    assert.equal(c.hasCookie, false);
    assert.equal((await c.login("tok-bob")).status, 200); // case-insensitive email match
    const me = await (await c.get("/api/me")).json();
    assert.equal(me.user.email, "Bob@Example.com");
    assert.ok(me.quotaBytes > 0);
  } finally {
    ctx.server.close();
  }
});

test("data: create, read, update, delete; keys follow the app's keyPaths", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    const entry = { id: "e1", type: "expense", amount: 12.5, category: "food", date: "2026-11-01", accountId: "a1" };
    assert.equal((await c.put("/api/data/entries/e1", entry)).status, 200);
    assert.equal((await c.put("/api/data/budgets/food", { category: "food", amount: 300 })).status, 200);
    assert.equal((await c.put("/api/data/settings/customCategories", { key: "customCategories", value: [{ id: "c_1", name: "Pets", emoji: "🐶" }] })).status, 200);

    assert.deepEqual(await (await c.get("/api/data/entries")).json(), [entry]);
    assert.deepEqual(await (await c.get("/api/data/entries/e1")).json(), entry);
    assert.equal((await c.get("/api/data/entries/missing")).status, 404);

    await c.put("/api/data/entries/e1", { ...entry, amount: 20 });
    assert.equal((await (await c.get("/api/data/entries/e1")).json()).amount, 20);

    assert.equal((await c.del("/api/data/entries/e1")).status, 204);
    assert.deepEqual(await (await c.get("/api/data/entries")).json(), []);
  } finally {
    ctx.server.close();
  }
});

test("validation: bad ids, mismatched keys, unknown stores, device-only settings", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    assert.equal((await c.put("/api/data/entries/e1", { id: "other" })).status, 400);
    assert.equal((await c.put("/api/data/entries/e1", [1, 2])).status, 400);
    assert.equal((await c.put("/api/data/nothing/e1", { id: "e1" })).status, 404);
    assert.equal((await c.get("/api/data/nothing")).status, 404);
    assert.equal((await c.put("/api/data/entries/bad%20id", { id: "bad id" })).status, 400);
    assert.equal((await c.put("/api/data/settings/apiKey", { key: "apiKey", value: "AIza-secret" })).status, 400);
    assert.equal((await c.put("/api/data/settings/requestLog", { key: "requestLog", value: [] })).status, 400);
    assert.equal((await c.put("/api/data/receipts/r1", { id: "r1", imageDataUrl: "data:text/html;base64,PHNjcmlwdD4=" })).status, 400);
    assert.equal((await c.put("/api/data/receipts/r1", { id: "r1", imageDataUrl: "javascript:alert(1)" })).status, 400);
    const big = { id: "big", note: "x".repeat(2.2 * 1024 * 1024) };
    assert.equal((await c.put("/api/data/entries/big", big)).status, 400);
  } finally {
    ctx.server.close();
  }
});

test("users are isolated from each other", async () => {
  ctx = await boot();
  try {
    const a = client(ctx.base);
    const b = client(ctx.base);
    await a.login("tok-alice");
    await b.login("tok-bob");
    await a.put("/api/data/entries/same-id", { id: "same-id", amount: 1 });
    await b.put("/api/data/entries/same-id", { id: "same-id", amount: 999 });
    await a.put("/api/data/receipts/r1", { id: "r1", imageDataUrl: PIXEL });

    assert.equal((await (await a.get("/api/data/entries/same-id")).json()).amount, 1);
    assert.equal((await (await b.get("/api/data/entries/same-id")).json()).amount, 999);
    assert.equal((await b.get("/api/data/receipts/r1")).status, 404);
    assert.equal((await b.get("/api/receipts/r1/image")).status, 404);
    assert.deepEqual(await (await b.get("/api/data/receipts")).json(), []);
    // Bob deleting "same-id" must not touch Alice's.
    await b.del("/api/data/entries/same-id");
    assert.equal((await (await a.get("/api/data/entries/same-id")).json()).amount, 1);
  } finally {
    ctx.server.close();
  }
});

test("receipt photos: not returned inline, served as cacheable images", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    await c.put("/api/data/receipts/r1", { id: "r1", entryId: "e1", month: "2026-11", imageDataUrl: PIXEL, createdAt: 1 });
    const list = await (await c.get("/api/data/receipts")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].imageDataUrl, undefined);
    assert.equal(list[0].hasImage, true);
    assert.equal(list[0].entryId, "e1");

    const img = await c.get("/api/receipts/r1/image");
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.match(img.headers.get("cache-control"), /immutable/);
    assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await img.arrayBuffer()).toString(), "fake-jpeg-bytes");
  } finally {
    ctx.server.close();
  }
});

test("storage quota is enforced per user", async () => {
  ctx = await boot({ quotaBytes: 5000 });
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    assert.equal((await c.put("/api/data/entries/a", { id: "a", note: "x".repeat(3000) })).status, 200);
    assert.equal((await c.put("/api/data/entries/b", { id: "b", note: "x".repeat(3000) })).status, 413);
    // Replacing an item only counts the difference.
    assert.equal((await c.put("/api/data/entries/a", { id: "a", note: "y".repeat(3500) })).status, 200);
    // Another user has their own allowance.
    const other = client(ctx.base);
    await other.login("tok-bob");
    assert.equal((await other.put("/api/data/entries/a", { id: "a", note: "x".repeat(3000) })).status, 200);
  } finally {
    ctx.server.close();
  }
});

test("import/export: round trip, idempotent, secrets never stored", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    const backup = {
      stores: {
        accounts: [{ id: "acc1", name: "ABN AMRO", type: "bank", opening: 100, limit: 0, createdAt: 1 }],
        entries: [
          { id: "e1", type: "expense", amount: 5, category: "food", date: "2026-10-01", accountId: "acc1" },
          { id: "e2", type: "income", amount: 50, category: "income", date: "2026-10-02", accountId: "acc1" },
        ],
        budgets: [{ category: "food", amount: 200 }],
        receipts: [{ id: "r1", entryId: "e1", month: "2026-10", imageDataUrl: PIXEL, createdAt: 2 }],
        recurring: [{ id: "rec1", name: "Rent", amount: 900, day: 1, category: "home", accountId: "acc1" }],
        settings: [
          { key: "customCategories", value: [] },
          { key: "apiKey", value: "AIza-should-be-dropped" },
          { key: "requestLog", value: [1, 2, 3] },
        ],
        notAStore: [{ id: "x" }],
      },
    };
    const r1 = await c.post("/api/import", backup);
    assert.equal(r1.status, 200);
    const body = await r1.json();
    assert.deepEqual(body.imported, { accounts: 1, entries: 2, budgets: 1, receipts: 1, recurring: 1, settings: 1 });
    assert.equal(body.skipped, 2);

    // Importing the same backup again changes nothing (upsert by id).
    assert.equal((await c.post("/api/import", backup)).status, 200);
    assert.equal((await (await c.get("/api/data/entries")).json()).length, 2);

    const settings = await (await c.get("/api/data/settings")).json();
    assert.deepEqual(settings.map((s) => s.key), ["customCategories"]);

    const exp = await c.get("/api/export");
    assert.match(exp.headers.get("content-disposition"), /ledger-backup-\d{4}-\d{2}-\d{2}\.json/);
    const out = await exp.json();
    assert.equal(out.stores.entries.length, 2);
    assert.equal(out.stores.receipts[0].imageDataUrl, PIXEL); // exports keep the photo
    assert.equal(out.stores.budgets[0].category, "food");

    // Bad payloads are rejected cleanly and nothing is half-imported.
    assert.equal((await c.post("/api/import", { stores: { entries: [{ id: "ok" }, { id: "bad id" }] } })).status, 400);
    assert.equal((await c.post("/api/import", { stores: { entries: "nope" } })).status, 400);
    assert.equal((await c.post("/api/import", {})).status, 400);
    assert.equal((await (await c.get("/api/data/entries/ok")).status), 404);
  } finally {
    ctx.server.close();
  }
});

test("cross-site writes are blocked, same-site writes work", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    const host = new URL(ctx.base).host;
    const evil = await c.put("/api/data/entries/e1", { id: "e1" }, { Origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    const ok = await c.put("/api/data/entries/e1", { id: "e1" }, { Origin: "http://" + host });
    assert.equal(ok.status, 200);
    assert.equal((await c.del("/api/data/entries/e1", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await c.del("/api/me", { Origin: "https://evil.example" })).status, 403);
  } finally {
    ctx.server.close();
  }
});

test("redirect sign-in callback (used by the installed phone app)", async () => {
  ctx = await boot({ allowedEmails: new Set(["alice@example.com"]) });
  try {
    const form = (fields) => new URLSearchParams(fields).toString();
    const post = (fields, cookie) =>
      fetch(ctx.base + "/auth/google/callback", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
        body: form(fields),
      });

    let r = await post({ credential: "tok-alice", g_csrf_token: "abc" }, "g_csrf_token=abc");
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/");
    const session = r.headers.getSetCookie().find((c) => c.startsWith("ledger_session="));
    assert.ok(session, "session cookie set");
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    const me = await fetch(ctx.base + "/api/me", { headers: { Cookie: session.split(";")[0] } });
    assert.equal(me.status, 200);

    r = await post({ credential: "tok-alice", g_csrf_token: "abc" }, "g_csrf_token=different");
    assert.equal(r.headers.get("location"), "/?login_error=csrf");
    r = await post({ credential: "tok-alice", g_csrf_token: "abc" });
    assert.equal(r.headers.get("location"), "/?login_error=csrf");
    r = await post({ credential: "tok-eve", g_csrf_token: "abc" }, "g_csrf_token=abc");
    assert.equal(r.headers.get("location"), "/?login_error=not_allowed");
    r = await post({ credential: "garbage", g_csrf_token: "abc" }, "g_csrf_token=abc");
    assert.equal(r.headers.get("location"), "/?login_error=invalid");
  } finally {
    ctx.server.close();
  }
});

test("forged or tampered session cookies are rejected", async () => {
  ctx = await boot();
  try {
    const jwt = require("jsonwebtoken");
    const forged = jwt.sign({ sub: "g-alice", email: "alice@example.com" }, "wrong-secret-wrong-secret-wrong-secret!");
    const r = await fetch(ctx.base + "/api/data/entries", { headers: { Cookie: "ledger_session=" + forged } });
    assert.equal(r.status, 401);
    const none = jwt.sign({ sub: "g-alice", email: "a@b.c" }, "", { algorithm: "none" });
    const r2 = await fetch(ctx.base + "/api/data/entries", { headers: { Cookie: "ledger_session=" + none } });
    assert.equal(r2.status, 401);
  } finally {
    ctx.server.close();
  }
});

test("sign out and delete-my-account", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    await c.put("/api/data/entries/e1", { id: "e1", amount: 1 });
    assert.equal((await c.post("/api/auth/logout", {})).status, 204);
    assert.equal(c.hasCookie, false);
    assert.equal((await c.get("/api/me")).status, 401);

    await c.login("tok-alice");
    assert.equal((await (await c.get("/api/data/entries")).json()).length, 1); // data survives sign-out
    assert.equal((await c.del("/api/me")).status, 204);
    await c.login("tok-alice");
    assert.deepEqual(await (await c.get("/api/data/entries")).json(), []); // gone after deletion
  } finally {
    ctx.server.close();
  }
});

test("oversized bodies get a clean JSON error", async () => {
  ctx = await boot();
  try {
    const c = client(ctx.base);
    await c.login("tok-alice");
    const r = await c.put("/api/data/entries/e1", { id: "e1", note: "x".repeat(4 * 1024 * 1024) });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /too large/i);
  } finally {
    ctx.server.close();
  }
});
