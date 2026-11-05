"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server/app");
const { createMemoryStore } = require("../server/store");
const { buildReport, renderPdf } = require("../server/report");

/* ---------- report maths (pure) ---------- */

const accounts = [
  { id: "a1", name: "Checking", type: "bank", opening: 1000, limit: 0 },
  { id: "a2", name: "Visa", type: "credit", opening: 0, limit: 2000 },
];
let n = 0;
const E = (date, type, amount, category, accountId, note = "") => ({ id: "e" + n++, date, type, amount, category, accountId, note, createdAt: n });
const entries = [
  E("2026-11-01", "income", 2500, "income", "a1"),
  E("2026-11-02", "expense", 850, "home", "a1"),
  E("2026-11-03", "expense", 42.5, "food", "a2"),
  E("2026-11-04", "expense", 18.9, "food", "a1"),
  E("2026-11-05", "expense", 60, "c_pets", "a1"),
  E("2026-11-06", "expense", 120, "shopping", "a2"),
  { id: "t1", type: "transfer", amount: 200, accountId: "a1", toAccountId: "a2", date: "2026-11-07", createdAt: 99, category: "transfer" },
  E("2026-10-10", "expense", 300, "food", "a1"),
  E("2026-10-15", "expense", 90, "fun", "a1"),
];
const plans = [
  { id: "2026-11:all", month: "2026-11", accountId: "all", limits: { food: 300, home: 900, shopping: 100, fun: 50 } },
  { id: "2026-10:all", month: "2026-10", accountId: "all", limits: { food: 250, fun: 100 } },
  { id: "2026-11:a1", month: "2026-11", accountId: "a1", limits: { food: 100 } },
];
const custom = [{ id: "c_pets", name: "Pets", emoji: "🐶" }];
const base = { entries, accounts, plans, customCategories: custom, now: new Date("2026-11-05") };

test("month report: spent excludes transfers; saved = budget minus spent in budgeted categories", () => {
  const r = buildReport({ ...base, period: "month", month: "2026-11", accountId: "all" });
  assert.deepEqual(r.totals, { in: 2500, out: 1091.4, net: 1408.6 });
  assert.equal(r.budget.totalLimit, 1350);
  assert.equal(r.budget.spentInBudget, 1031.4); // 850 + 61.4 + 120 + 0
  assert.equal(r.budget.saved, 318.6);
  assert.equal(r.budget.unbudgeted, 60); // Pets has no limit
  const shopping = r.budget.rows.find((x) => x.name === "Shopping");
  assert.equal(shopping.left, -20); // overspent category is negative, not hidden
  assert.ok(r.categories.some((c) => c.name === "Pets")); // custom category names are used
});

test("account scope only counts that account, uses that account's own plan, and shows its balance", () => {
  const r = buildReport({ ...base, period: "month", month: "2026-11", accountId: "a1" });
  assert.equal(r.totals.out, 928.9);
  assert.equal(r.budget.totalLimit, 100);
  assert.equal(r.budget.spentInBudget, 18.9);
  // opening 1000 + Oct (-390) + Nov (+2500 -850 -18.9 -60) - 200 transfer out
  assert.equal(r.balance.amount, 1000 - 390 + 2500 - 850 - 18.9 - 60 - 200);
  const visa = buildReport({ ...base, period: "month", month: "2026-11", accountId: "a2" });
  assert.equal(visa.balance.amount, 42.5 + 120 - 200); // owed: charges minus the payment
  assert.equal(visa.budget.hasPlan, false);
});

test("year report: saved adds up only months that have a budget", () => {
  const r = buildReport({ ...base, period: "year", year: "2026", accountId: "all" });
  assert.equal(r.budgetedMonths, 2);
  assert.equal(r.saved, 278.6); // Oct: 350-390 = -40, Nov: +318.6
  assert.equal(r.months.find((m) => m.label === "Oct").saved, -40);
  assert.equal(r.months.find((m) => m.label === "Jan").budget, null);
  assert.equal(r.totals.out, 1481.4);
});

test("unknown account is rejected; PDFs render for every shape of report", async () => {
  assert.throws(() => buildReport({ ...base, period: "month", month: "2026-11", accountId: "nope" }), /Unknown account/);
  for (const args of [
    { period: "month", month: "2026-11", accountId: "all" },
    { period: "month", month: "2026-09", accountId: "a2" }, // nothing logged, no budget
    { period: "year", year: "2026", accountId: "a1" },
    { period: "year", year: "2031", accountId: "all" }, // empty year
  ]) {
    const pdf = await renderPdf(buildReport({ ...base, ...args }));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 1500);
  }
});

test("a long month paginates and non-Latin text does not break the PDF", async () => {
  const many = [];
  for (let i = 0; i < 150; i++) many.push(E("2026-11-" + String(1 + (i % 28)).padStart(2, "0"), "expense", 5 + i, "food", "a1", "Item 日本語 🍕 " + i));
  const r = buildReport({ ...base, entries: many, period: "month", month: "2026-11", accountId: "all" });
  const pdf = await renderPdf(r);
  assert.ok((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length >= 3);
});

/* ---------- API ---------- */

const PROFILES = {
  "tok-alice": { sub: "g-alice", email: "alice@example.com", email_verified: true, name: "Alice" },
  "tok-bob": { sub: "g-bob", email: "bob@example.com", email_verified: true, name: "Bob" },
};
let tmpPublic;
before(() => {
  tmpPublic = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-public-"));
  fs.writeFileSync(path.join(tmpPublic, "index.html"), "<h1>app</h1>");
});
after(() => fs.rmSync(tmpPublic, { recursive: true, force: true }));

async function boot() {
  const store = createMemoryStore();
  const app = createApp({
    store,
    verifyGoogle: async (c) => {
      if (!PROFILES[c]) throw new Error("bad");
      return PROFILES[c];
    },
    config: { googleClientId: "cid", sessionSecret: "x".repeat(40), publicDir: tmpPublic, rateLimitPerMinute: 100000 },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
async function login(base, token) {
  const r = await fetch(base + "/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: token }) });
  return r.headers.getSetCookie()[0].split(";")[0];
}
const call = (base, cookie, method, url, body) =>
  fetch(base + url, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

test("plans: validated, stored per user, and included in backups", async () => {
  const { server, base } = await boot();
  try {
    const alice = await login(base, "tok-alice");
    const bob = await login(base, "tok-bob");
    const good = { id: "2026-11:all", month: "2026-11", accountId: "all", limits: { food: 300, c_pets: 25.5 } };
    assert.equal((await call(base, alice, "PUT", "/api/data/plans/2026-11:all", good)).status, 200);

    const bad = [
      { ...good, id: "2026-11:a1" }, // id doesn't match the account
      { ...good, month: "2026-13", id: "2026-13:all" },
      { ...good, month: "November" },
      { ...good, limits: { food: -5 } },
      { ...good, limits: { food: "300" } },
      { ...good, limits: { food: 1e12 } },
      { ...good, limits: { "bad key!": 5 } },
      { ...good, limits: [300] },
      { ...good, accountId: "x/y", id: "2026-11:x/y" },
    ];
    for (const b of bad) {
      const r = await call(base, alice, "PUT", "/api/data/plans/" + encodeURIComponent(b.id), b);
      assert.equal(r.status, 400, JSON.stringify(b));
    }

    // Bob can't see Alice's plan, and has his own namespace for the same id.
    assert.equal((await call(base, bob, "GET", "/api/data/plans/2026-11:all")).status, 404);
    assert.equal((await call(base, bob, "PUT", "/api/data/plans/2026-11:all", { ...good, limits: { food: 1 } })).status, 200);
    assert.equal((await (await call(base, alice, "GET", "/api/data/plans/2026-11:all")).json()).limits.food, 300);

    const backup = await (await call(base, alice, "GET", "/api/export")).json();
    assert.equal(backup.stores.plans.length, 1);
    const imp = await call(base, alice, "POST", "/api/import", { stores: { plans: [{ ...good, limits: { food: 310 } }] } });
    assert.deepEqual((await imp.json()).imported, { plans: 1 });
    assert.equal((await (await call(base, alice, "GET", "/api/data/plans/2026-11:all")).json()).limits.food, 310);
  } finally {
    server.close();
  }
});

test("PDF endpoint: needs login, validates input, returns a PDF built only from the caller's data", async () => {
  const { server, base } = await boot();
  try {
    assert.equal((await fetch(base + "/api/report.pdf?period=month&month=2026-11")).status, 401);
    const alice = await login(base, "tok-alice");
    const bob = await login(base, "tok-bob");
    await call(base, alice, "PUT", "/api/data/accounts/a1", { id: "a1", name: "Alice Secret Bank", type: "bank", opening: 0, limit: 0 });
    await call(base, alice, "PUT", "/api/data/entries/e1", { id: "e1", type: "expense", amount: 12.34, category: "food", date: "2026-11-02", accountId: "a1", note: "Alice lunch" });

    for (const q of ["", "period=week", "period=month", "period=month&month=2026-1", "period=year&year=26", "period=month&month=2026-11&account=../x"]) {
      assert.equal((await call(base, alice, "GET", "/api/report.pdf?" + q)).status, 400, q);
    }
    assert.equal((await call(base, alice, "GET", "/api/report.pdf?period=month&month=2026-11&account=missing")).status, 404);

    const ok = await call(base, alice, "GET", "/api/report.pdf?period=month&month=2026-11&account=a1");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/pdf");
    assert.match(ok.headers.get("content-disposition"), /ledger-2026-11-Alice-Secret-Bank\.pdf/);
    assert.match(ok.headers.get("cache-control"), /no-store/);
    const bytes = Buffer.from(await ok.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");

    // Bob asking for Alice's account id gets nothing of hers.
    assert.equal((await call(base, bob, "GET", "/api/report.pdf?period=month&month=2026-11&account=a1")).status, 404);
    const bobAll = await call(base, bob, "GET", "/api/report.pdf?period=year&year=2026");
    assert.equal(bobAll.status, 200);
  } finally {
    server.close();
  }
});
