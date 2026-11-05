"use strict";
/*
 * Ledger API.
 *
 *  Auth      Google sign-in -> server verifies the Google ID token -> sets an httpOnly
 *            session cookie (signed JWT). No passwords are ever handled here.
 *  Data      One generic per-user document API (/api/data/:store/:id). Every query is
 *            scoped by the signed-in user's id, so users cannot see each other's data.
 *  Receipts  Photos are saved with the receipt record but never sent back inline;
 *            the app loads them from /api/receipts/:id/image (cacheable, lazy-loaded).
 *  Backup    GET /api/export and POST /api/import (used to move data in from the old
 *            on-device version, and as a safety net: the free database has no backups).
 */

const path = require("path");
const { buildReport, renderPdf, MONTH_RE, YEAR_RE } = require("./report");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const STORES = ["entries", "receipts", "recurring", "budgets", "settings", "accounts", "plans"];
// Secrets / per-device values must never be stored on the server, even if a client tries.
const BLOCKED_SETTINGS = new Set(["apiKey", "requestLog"]);
const ID_RE = /^[A-Za-z0-9_\-:.]{1,100}$/;
const IMG_PREFIX_RE = /^data:image\/(jpeg|png|webp|gif|heic|heif);base64,/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ITEMS = 5000;
const COOKIE = "ledger_session";
const SESSION_DAYS = 30;

const byteLen = (v) => Buffer.byteLength(JSON.stringify(v));
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Which field of a record is its primary key (matches the app's IndexedDB keyPaths).
function keyOf(store, data) {
  if (store === "budgets") return data.category;
  if (store === "settings") return data.key;
  return data.id;
}

function validateDoc(store, id, data) {
  if (!STORES.includes(store)) return "Unknown collection";
  if (typeof id !== "string" || !ID_RE.test(id)) return "Invalid id";
  if (!isPlainObject(data)) return "Body must be a JSON object";
  if (keyOf(store, data) !== id) return "Id in body does not match the URL";
  if (store === "settings" && BLOCKED_SETTINGS.has(id)) return "That setting is device-only and is not stored on the server";
  if (store === "receipts" && data.imageDataUrl !== undefined) {
    const u = data.imageDataUrl;
    if (typeof u !== "string") return "Invalid image";
    const m = IMG_PREFIX_RE.exec(u);
    if (!m || !B64_RE.test(u.slice(m[0].length))) return "Receipt image must be a base64 jpeg/png/webp/gif/heic data URL";
  }
  if (store === "plans") {
    // A budget plan: one month, one scope ("all" or an account id), a limit per category.
    if (typeof data.month !== "string" || !MONTH_RE.test(data.month)) return "Plan needs a month like 2026-11";
    if (typeof data.accountId !== "string" || !/^[A-Za-z0-9_\-.]{1,60}$/.test(data.accountId)) return "Plan needs an account (or \"all\")";
    if (id !== `${data.month}:${data.accountId}`) return "Plan id must be month:account";
    if (!isPlainObject(data.limits)) return "Plan needs a limits object";
    const keys = Object.keys(data.limits);
    if (keys.length > 100) return "Too many categories in one plan";
    for (const k of keys) {
      const v = data.limits[k];
      if (!ID_RE.test(k)) return "Invalid category in plan";
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e9) return "Budget amounts must be numbers of 0 or more";
    }
  }
  if (byteLen(data) > MAX_DOC_BYTES) return "Item is too large (max 2 MB). Photos are shrunk automatically by the app.";
  return null;
}

// Receipt photos are not returned inline: the list stays small and fast.
function publicData(store, data) {
  if (store === "receipts" && data && data.imageDataUrl) {
    const { imageDataUrl, ...rest } = data;
    return { ...rest, hasImage: true };
  }
  return data;
}

function createApp({ store, verifyGoogle, config }) {
  const {
    googleClientId,
    sessionSecret,
    allowedEmails = null, // Set of lowercase emails, or null = anyone with a Google account
    quotaBytes = 40 * 1024 * 1024,
    production = false,
    publicDir = path.join(__dirname, "..", "public"),
    rateLimitPerMinute = 600,
  } = config;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render sits behind a proxy

  app.use(
    helmet({
      // Off for now: the app is one HTML file with inline script/style. See README for hardening.
      contentSecurityPolicy: false,
      // Google's sign-in popup needs this value; harmless otherwise.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    })
  );
  app.use(cookieParser());

  app.get("/healthz", (req, res) => res.type("text").send("ok"));

  const limiterOpts = { standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests, slow down." } };
  app.use("/api", rateLimit({ ...limiterOpts, windowMs: 60_000, limit: rateLimitPerMinute }));
  app.use(["/api/auth", "/auth"], rateLimit({ ...limiterOpts, windowMs: 10 * 60_000, limit: 60 }));

  // The import route accepts a bigger body than everything else, so it is mounted first.
  app.use("/api/import", express.json({ limit: "12mb" }));
  app.use(express.json({ limit: "3mb" }));
  app.use(express.urlencoded({ extended: false, limit: "20kb" }));

  /* ---------------- sessions ---------------- */
  const isAllowed = (email) => !allowedEmails || allowedEmails.has(String(email || "").toLowerCase());

  function issueSession(res, user) {
    const token = jwt.sign({ sub: user._id, email: user.email }, sessionSecret, { expiresIn: `${SESSION_DAYS}d` });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      maxAge: SESSION_DAYS * 24 * 3600 * 1000,
      path: "/",
    });
  }
  const clearSession = (res) => res.clearCookie(COOKIE, { path: "/", httpOnly: true, secure: production, sameSite: "lax" });

  async function signIn(credential) {
    if (typeof credential !== "string" || !credential) throw Object.assign(new Error("Missing credential"), { code: "invalid" });
    let profile;
    try {
      profile = await verifyGoogle(credential);
    } catch {
      throw Object.assign(new Error("Google sign-in could not be verified"), { code: "invalid" });
    }
    if (!profile || !profile.sub || !profile.email || profile.email_verified === false) {
      throw Object.assign(new Error("Google account has no verified email"), { code: "invalid" });
    }
    if (!isAllowed(profile.email)) throw Object.assign(new Error("This account is not on the invite list"), { code: "not_allowed" });
    return store.upsertUser(profile);
  }

  function requireAuth(req, res, next) {
    const token = req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: "Not signed in" });
    try {
      const p = jwt.verify(token, sessionSecret);
      if (!isAllowed(p.email)) return res.status(403).json({ error: "This account is not on the invite list" });
      req.uid = p.sub;
      req.email = p.email;
      next();
    } catch {
      res.status(401).json({ error: "Session expired, please sign in again" });
    }
  }

  // Browser sign-in via redirect: Google POSTs the credential to this URL (works in iOS home-screen apps).
  app.post("/auth/google/callback", async (req, res) => {
    const bodyToken = req.body && req.body.g_csrf_token;
    const cookieToken = req.cookies && req.cookies.g_csrf_token;
    if (!bodyToken || !cookieToken || bodyToken !== cookieToken) return res.redirect(303, "/?login_error=csrf");
    try {
      const user = await signIn(req.body.credential);
      issueSession(res, user);
      res.redirect(303, "/");
    } catch (e) {
      res.redirect(303, "/?login_error=" + (e.code || "invalid"));
    }
  });

  /* ---------------- API ---------------- */
  const api = express.Router();

  // Cross-site request protection for anything that changes data (on top of SameSite=Lax cookies).
  api.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    const origin = req.get("origin");
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== req.get("host")) return res.status(403).json({ error: "Cross-site request blocked" });
    }
    next();
  });

  api.get("/config", (req, res) => res.json({ googleClientId }));

  api.post("/auth/google", async (req, res) => {
    try {
      const user = await signIn(req.body && req.body.credential);
      issueSession(res, user);
      res.json({ user: { id: user._id, email: user.email, name: user.name, picture: user.picture } });
    } catch (e) {
      res.status(e.code === "not_allowed" ? 403 : 401).json({ error: e.message, code: e.code || "invalid" });
    }
  });

  api.post("/auth/logout", (req, res) => {
    clearSession(res);
    res.status(204).end();
  });

  api.use(requireAuth);

  api.get("/me", async (req, res) => {
    const user = await store.getUser(req.uid);
    if (!user) {
      clearSession(res);
      return res.status(401).json({ error: "Account no longer exists" });
    }
    res.json({
      user: { id: user._id, email: user.email, name: user.name, picture: user.picture },
      usedBytes: await store.usage(req.uid),
      quotaBytes,
    });
  });

  // Delete the account and everything stored for it.
  api.delete("/me", async (req, res) => {
    await store.deleteUser(req.uid);
    clearSession(res);
    res.status(204).end();
  });

  function checkStore(req, res, next) {
    if (!STORES.includes(req.params.store)) return res.status(404).json({ error: "Unknown collection" });
    next();
  }

  api.get("/data/:store", checkStore, async (req, res) => {
    const docs = await store.listDocs(req.uid, req.params.store);
    res.json(docs.map((d) => publicData(req.params.store, d.data)));
  });

  api.get("/data/:store/:id", checkStore, async (req, res) => {
    const d = await store.getDoc(req.uid, req.params.store, req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json(publicData(req.params.store, d.data));
  });

  api.put("/data/:store/:id", checkStore, async (req, res) => {
    const { store: name, id } = req.params;
    const data = req.body;
    const problem = validateDoc(name, id, data);
    if (problem) return res.status(400).json({ error: problem });
    const size = byteLen(data);
    const [used, prior] = await Promise.all([store.usage(req.uid), store.docSize(req.uid, name, id)]);
    if (used - prior + size > quotaBytes) {
      return res.status(413).json({ error: "Your storage is full. Delete some receipt photos or old data to free space." });
    }
    await store.putDoc(req.uid, name, id, data, size);
    res.json({ ok: true });
  });

  api.delete("/data/:store/:id", checkStore, async (req, res) => {
    await store.deleteDoc(req.uid, req.params.store, req.params.id);
    res.status(204).end();
  });

  api.get("/receipts/:id/image", async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).end();
    const d = await store.getDoc(req.uid, "receipts", req.params.id);
    const url = d && d.data && d.data.imageDataUrl;
    const m = typeof url === "string" ? IMG_PREFIX_RE.exec(url) : null;
    if (!m) return res.status(404).end();
    res.set({
      "Content-Type": "image/" + m[1],
      // Receipt ids are unique and photos never change, so the browser can keep them.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(Buffer.from(url.slice(m[0].length), "base64"));
  });

  // PDF overview for one month or one year, for all accounts or a single account.
  const reportLimiter = rateLimit({ ...limiterOpts, windowMs: 60_000, limit: 20 });
  api.get("/report.pdf", reportLimiter, async (req, res) => {
    const { period, month, year, account } = req.query;
    if (period !== "month" && period !== "year") return res.status(400).json({ error: "period must be month or year" });
    if (period === "month" && !(typeof month === "string" && MONTH_RE.test(month))) return res.status(400).json({ error: "month must look like 2026-11" });
    if (period === "year" && !(typeof year === "string" && YEAR_RE.test(year))) return res.status(400).json({ error: "year must look like 2026" });
    const accountId = typeof account === "string" && account ? account : "all";
    if (accountId !== "all" && !ID_RE.test(accountId)) return res.status(400).json({ error: "Invalid account" });

    const list = async (name) => (await store.listDocs(req.uid, name)).map((d) => d.data);
    const [entries, accounts, plans, settings] = await Promise.all([list("entries"), list("accounts"), list("plans"), list("settings")]);
    const custom = settings.find((s) => s.key === "customCategories");
    let report;
    try {
      report = buildReport({ period, month, year, accountId, entries, accounts, plans, customCategories: custom ? custom.value : [] });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    const pdf = await renderPdf(report);
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "all";
    const filename = `ledger-${period === "month" ? month : year}-${safe(report.scopeName)}.pdf`;
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // The browser reads this to name the file when saving to Drive.
      "Access-Control-Expose-Headers": "Content-Disposition",
    });
    res.send(pdf);
  });

  api.get("/export", async (req, res) => {
    const stores = {};
    for (const name of STORES) {
      stores[name] = (await store.listDocs(req.uid, name)).map((d) => d.data);
    }
    const day = new Date().toISOString().slice(0, 10);
    res.set("Content-Disposition", `attachment; filename="ledger-backup-${day}.json"`);
    res.json({ app: "ledger", version: 2, exportedAt: new Date().toISOString(), stores });
  });

  api.post("/import", async (req, res) => {
    const incoming = req.body && req.body.stores;
    if (!isPlainObject(incoming)) return res.status(400).json({ error: "Expected { stores: { ... } }" });

    const items = [];
    let skipped = 0;
    for (const [name, list] of Object.entries(incoming)) {
      if (!STORES.includes(name)) continue;
      if (!Array.isArray(list)) return res.status(400).json({ error: `"${name}" must be a list` });
      for (const data of list) {
        if (!isPlainObject(data)) return res.status(400).json({ error: `Bad item in "${name}"` });
        const id = keyOf(name, data);
        if (name === "settings" && BLOCKED_SETTINGS.has(id)) {
          skipped++;
          continue;
        }
        const problem = validateDoc(name, id, data);
        if (problem) return res.status(400).json({ error: `${name}: ${problem}` });
        items.push({ store: name, id, data, size: byteLen(data) });
      }
    }
    if (items.length > MAX_IMPORT_ITEMS) return res.status(400).json({ error: `Too many items in one request (max ${MAX_IMPORT_ITEMS})` });

    // Quota check that accounts for items being replaced.
    const existing = await store.sizes(req.uid);
    let projected = 0;
    for (const v of existing.values()) projected += v;
    for (const it of items) {
      projected += it.size - (existing.get(`${it.store}|${it.id}`) || 0);
    }
    if (projected > quotaBytes) return res.status(413).json({ error: "This import would exceed your storage limit." });

    for (let i = 0; i < items.length; i += 200) await store.putDocs(req.uid, items.slice(i, i + 200));
    const imported = {};
    for (const it of items) imported[it.store] = (imported[it.store] || 0) + 1;
    res.json({ imported, skipped });
  });

  api.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use("/api", api);

  /* ---------------- static app ---------------- */
  app.use(
    express.static(publicDir, {
      index: "index.html",
      setHeaders(res, filePath) {
        if (/(^|[\\/])sw\.js$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );

  // Errors: always JSON for the API; never leak internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error("Unhandled error:", err && err.message);
    const message = status === 413 ? "That upload is too large." : status >= 500 ? "Server error" : err.message || "Bad request";
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp, STORES, BLOCKED_SETTINGS };
