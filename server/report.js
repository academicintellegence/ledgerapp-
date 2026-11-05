"use strict";
/*
 * Reports: turns a user's entries / accounts / budget plans into a summary and renders it as a PDF.
 *
 *  buildReport(input)  pure function -> plain object (easy to test)
 *  renderPdf(report)   -> Promise<Buffer>
 *
 * Definitions (the app's Budget screen uses the same ones):
 *  - Spent    = expenses only. Transfers between your own accounts are never spending or income.
 *  - Budget   = a plan saved for one month and one scope (all accounts, or a single account).
 *  - Saved    = the budgeted amount minus what was spent in the budgeted categories.
 *               (Spending in categories with no budget is listed separately and does not change it.)
 */

const PDFDocument = require("pdfkit");

const BASE_CATEGORIES = {
  food: "Food",
  transport: "Transport",
  shopping: "Shopping",
  bills: "Bills",
  health: "Health",
  fun: "Entertainment",
  home: "Home",
  income: "Income",
  other: "Other",
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function monthName(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
function shortMonth(key) {
  const m = Number(key.split("-")[1]);
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
}

function categoryNames(customCategories) {
  const map = { ...BASE_CATEGORIES };
  for (const c of customCategories || []) if (c && c.id) map[c.id] = String(c.name || c.id);
  return map;
}

// Sums the limits of a plan (ignores junk values).
function planTotal(plan) {
  let t = 0;
  if (plan && plan.limits) for (const v of Object.values(plan.limits)) if (Number.isFinite(v) && v > 0) t += v;
  return round2(t);
}

/**
 * Budget figures for ONE month and ONE scope.
 * `spentByCat` is { categoryId: amount } for that month and scope.
 */
function budgetFor(plan, spentByCat, names) {
  const limits = (plan && plan.limits) || {};
  const rows = [];
  let totalLimit = 0;
  let spentInBudget = 0;
  let unbudgeted = 0;
  const ids = new Set([...Object.keys(spentByCat), ...Object.keys(limits).filter((k) => limits[k] > 0)]);
  for (const id of ids) {
    const limit = limits[id] > 0 ? limits[id] : 0;
    const spent = spentByCat[id] || 0;
    if (limit > 0) {
      totalLimit += limit;
      spentInBudget += spent;
      rows.push({ id, name: names[id] || "Other", limit: round2(limit), spent: round2(spent), left: round2(limit - spent) });
    } else if (spent > 0) {
      unbudgeted += spent;
    }
  }
  rows.sort((a, b) => b.limit - a.limit || a.name.localeCompare(b.name));
  return {
    hasPlan: !!plan && totalLimit > 0,
    rows,
    totalLimit: round2(totalLimit),
    spentInBudget: round2(spentInBudget),
    saved: round2(totalLimit - spentInBudget), // negative = over budget
    unbudgeted: round2(unbudgeted),
  };
}

function buildReport({ period, month, year, accountId, entries, accounts, plans, customCategories, now = new Date() }) {
  const names = categoryNames(customCategories);
  const acctById = new Map((accounts || []).map((a) => [a.id, a]));
  const scopeAll = !accountId || accountId === "all";
  if (!scopeAll && !acctById.has(accountId)) throw Object.assign(new Error("Unknown account"), { status: 404 });
  const scopeKey = scopeAll ? "all" : accountId;
  const scopeName = scopeAll ? "All accounts" : acctById.get(accountId).name;
  const planOf = (m) => (plans || []).find((p) => p.month === m && p.accountId === scopeKey) || null;

  // Entries that count towards this scope. Transfers are kept only for the transaction list.
  const inScope = (e) => (scopeAll ? true : e.accountId === accountId || e.toAccountId === accountId);
  const scoped = (entries || []).filter(inScope);
  const real = scoped.filter((e) => e.type === "income" || e.type === "expense");
  const matchesPeriod = (e, p) => String(e.date || "").slice(0, p.length) === p;
  const sum = (list, type) => round2(list.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0));
  const spentMap = (list) => {
    const m = {};
    for (const e of list) if (e.type === "expense") m[e.category] = (m[e.category] || 0) + e.amount;
    return m;
  };

  const out = {
    period,
    scopeName,
    accountId: scopeKey,
    generatedAt: now.toISOString().slice(0, 10),
    balance: null,
  };

  // Balance at the end of the period, for a single account.
  const endDate = period === "month" ? month + "-31" : year + "-12-31";
  if (!scopeAll) {
    const a = acctById.get(accountId);
    let net = 0;
    for (const e of scoped) {
      if (String(e.date || "") > endDate) continue;
      if (e.type === "transfer") {
        if (e.accountId === a.id) net -= e.amount;
        if (e.toAccountId === a.id) net += e.amount;
      } else net += e.type === "income" ? e.amount : -e.amount;
    }
    if (a.type === "credit") {
      const owed = (a.opening || 0) - net;
      out.balance = { label: "Owed at end", amount: round2(owed), sub: `limit ${round2(a.limit || 0)}` };
    } else {
      out.balance = { label: "Balance at end", amount: round2((a.opening || 0) + net), sub: "" };
    }
  }

  if (period === "month") {
    const list = real.filter((e) => matchesPeriod(e, month));
    out.label = monthName(month);
    out.totals = { in: sum(list, "income"), out: sum(list, "expense") };
    out.totals.net = round2(out.totals.in - out.totals.out);
    const spent = spentMap(list);
    out.budget = budgetFor(planOf(month), spent, names);
    out.categories = Object.keys(spent)
      .map((id) => ({ name: names[id] || "Other", spent: round2(spent[id]) }))
      .sort((a, b) => b.spent - a.spent);
    out.transactions = scoped
      .filter((e) => matchesPeriod(e, month))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0))
      .map((e) => ({
        date: e.date,
        type: e.type,
        category: e.type === "transfer" ? "Transfer" : names[e.category] || "Other",
        account:
          e.type === "transfer"
            ? `${(acctById.get(e.accountId) || {}).name || "?"} > ${(acctById.get(e.toAccountId) || {}).name || "?"}`
            : (acctById.get(e.accountId) || {}).name || "",
        note: e.note || "",
        amount: round2(e.amount),
      }));
    return out;
  }

  // Year
  const list = real.filter((e) => matchesPeriod(e, year));
  out.label = year;
  out.totals = { in: sum(list, "income"), out: sum(list, "expense") };
  out.totals.net = round2(out.totals.in - out.totals.out);
  out.months = [];
  const catYear = {}; // id -> {limit, spent} over months that have a plan
  let budgetedMonths = 0;
  let savedTotal = 0;
  for (let i = 1; i <= 12; i++) {
    const key = `${year}-${String(i).padStart(2, "0")}`;
    const ml = list.filter((e) => matchesPeriod(e, key));
    const b = budgetFor(planOf(key), spentMap(ml), names);
    const row = { label: shortMonth(key), in: sum(ml, "income"), out: sum(ml, "expense"), budget: null, saved: null };
    row.net = round2(row.in - row.out);
    if (b.hasPlan) {
      row.budget = b.totalLimit;
      row.saved = b.saved;
      budgetedMonths++;
      savedTotal += b.saved;
      for (const r of b.rows) {
        const c = (catYear[r.id] = catYear[r.id] || { name: r.name, limit: 0, spent: 0 });
        c.limit += r.limit;
        c.spent += r.spent;
      }
    }
    out.months.push(row);
  }
  out.budgetedMonths = budgetedMonths;
  out.saved = round2(savedTotal);
  out.budgetByCategory = Object.values(catYear)
    .map((c) => ({ name: c.name, limit: round2(c.limit), spent: round2(c.spent), left: round2(c.limit - c.spent) }))
    .sort((a, b) => b.limit - a.limit);
  const yearSpent = spentMap(list);
  out.categories = Object.keys(yearSpent)
    .map((id) => ({ name: names[id] || "Other", spent: round2(yearSpent[id]) }))
    .sort((a, b) => b.spent - a.spent);
  return out;
}

/* ------------------------------ PDF ------------------------------ */

// The built-in PDF fonts cover Latin text only. Anything else (emoji, CJK ...) is dropped instead of printing garbage.
const clean = (s) =>
  String(s == null ? "" : s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2192/g, ">")
    .replace(/[^\u0020-\u007E\u00A0-\u00FF\u20AC]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const money = (n) => {
  const v = round2(n);
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? "-" : "") + "$" + s;
};

const INK = "#181F1C";
const MUTED = "#6B6F63";
const RED = "#C1432E";
const GREEN = "#3F6B51";
const LINE = "#D9D4C2";
const BAND = "#F3EFE2";

function renderPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: { Title: clean(`Ledger - ${report.label} - ${report.scopeName}`), Author: "Ledger", Creator: "Ledger" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 14;

    const need = (h) => {
      if (doc.y + h > bottom()) doc.addPage();
    };
    const text = (s, x, y, opts = {}) => doc.text(clean(s), x, y, { lineBreak: false, ...opts });

    function section(title) {
      need(60);
      doc.moveDown(0.8);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
      const y = doc.y;
      text(title.toUpperCase(), L, y, { characterSpacing: 0.8 });
      doc.moveTo(L, y + 16).lineTo(L + W, y + 16).strokeColor(LINE).lineWidth(0.8).stroke();
      doc.y = y + 24;
    }

    // columns: [{label, w, align, key, color?(row), format?(v,row)}]  (w = share of the width)
    function table(columns, rows, opts = {}) {
      const total = columns.reduce((s, c) => s + c.w, 0);
      const widths = columns.map((c) => (c.w / total) * W);
      const rowH = opts.rowH || 19;
      const header = () => {
        need(rowH * 2);
        const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
        let x = L;
        columns.forEach((c, i) => {
          text(c.label.toUpperCase(), x + 4, y + 4, { width: widths[i] - 8, align: c.align || "left", characterSpacing: 0.4 });
          x += widths[i];
        });
        doc.y = y + rowH - 2;
      };
      header();
      rows.forEach((row, idx) => {
        if (doc.y + rowH > bottom()) {
          doc.addPage();
          header();
        }
        const y = doc.y;
        if (row.__total) doc.rect(L, y, W, rowH).fill(BAND);
        else if (idx % 2 === 1 && !opts.noZebra) doc.rect(L, y, W, rowH).fill("#FAF8F1");
        doc.font(row.__total ? "Helvetica-Bold" : "Helvetica").fontSize(9);
        let x = L;
        columns.forEach((c, i) => {
          const raw = row[c.key];
          const val = c.format ? c.format(raw, row) : raw;
          doc.fillColor((c.color && c.color(raw, row)) || INK);
          text(val == null ? "" : val, x + 4, y + 5, { width: widths[i] - 8, align: c.align || "left", ellipsis: true, height: 11 });
          x += widths[i];
        });
        doc.y = y + rowH;
      });
      doc.y += 2;
    }

    function cards(items) {
      need(60);
      const gap = 10;
      const w = (W - gap * (items.length - 1)) / items.length;
      const y = doc.y;
      items.forEach((it, i) => {
        const x = L + i * (w + gap);
        doc.roundedRect(x, y, w, 46, 6).fill(BAND);
        doc.font("Helvetica").fontSize(8).fillColor(MUTED);
        text(it.label.toUpperCase(), x + 10, y + 9, { width: w - 20, characterSpacing: 0.5 });
        doc.font("Helvetica-Bold").fontSize(14).fillColor(it.color || INK);
        text(it.value, x + 10, y + 24, { width: w - 20 });
      });
      doc.y = y + 56;
    }

    // ---- header
    doc.rect(0, 0, doc.page.width, 78).fill(INK);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#F7F3E8");
    text("LEDGER", L, 22, { characterSpacing: 2 });
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#F7F3E8");
    text(`${report.period === "month" ? "Monthly" : "Yearly"} overview  -  ${report.label}`, L, 38);
    doc.font("Helvetica").fontSize(9).fillColor("#B9BCAE");
    text(`${report.scopeName}   |   generated ${report.generatedAt}`, L, 62);
    doc.y = 96;

    const t = report.totals;
    const summary = [
      { label: "In", value: money(t.in), color: GREEN },
      { label: "Out", value: money(t.out), color: RED },
      { label: "Net", value: money(t.net), color: t.net >= 0 ? GREEN : RED },
    ];
    if (report.balance) summary.push({ label: report.balance.label, value: money(report.balance.amount) });
    cards(summary);

    if (report.period === "month") {
      const b = report.budget;
      section("Budget");
      if (!b.hasPlan) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED);
        text("No budget was set for this month.", L, doc.y);
        doc.y += 16;
      } else {
        cards([
          { label: "Budgeted", value: money(b.totalLimit) },
          { label: "Spent", value: money(b.spentInBudget) },
          { label: b.saved >= 0 ? "Saved" : "Over budget by", value: money(Math.abs(b.saved)), color: b.saved >= 0 ? GREEN : RED },
        ]);
        table(
          [
            { label: "Category", key: "name", w: 3 },
            { label: "Budget", key: "limit", w: 2, align: "right", format: money },
            { label: "Spent", key: "spent", w: 2, align: "right", format: money },
            { label: "Left", key: "left", w: 2, align: "right", format: (v) => (v < 0 ? "over " + money(-v) : money(v)), color: (v) => (v < 0 ? RED : GREEN) },
          ],
          b.rows
        );
        if (b.unbudgeted > 0) {
          doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
          text(`Also spent ${money(b.unbudgeted)} in categories without a budget (not counted above).`, L, doc.y);
          doc.y += 14;
        }
      }

      section("Spending by category");
      if (!report.categories.length) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED);
        text("No expenses this month.", L, doc.y);
        doc.y += 16;
      } else {
        const max = report.categories[0].spent || 1;
        report.categories.forEach((c) => {
          need(22);
          const y = doc.y;
          doc.font("Helvetica").fontSize(9).fillColor(INK);
          text(c.name, L, y + 2, { width: 120, ellipsis: true, height: 11 });
          doc.rect(L + 128, y + 3, W - 128 - 80, 7).fill(BAND);
          doc.rect(L + 128, y + 3, Math.max(1, (W - 128 - 80) * (c.spent / max)), 7).fill(RED);
          text(money(c.spent), L + W - 74, y + 2, { width: 74, align: "right" });
          doc.y = y + 18;
        });
      }

      section("Transactions");
      if (!report.transactions.length) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED);
        text("Nothing logged this month.", L, doc.y);
      } else {
        table(
          [
            { label: "Date", key: "date", w: 2.2 },
            { label: "Category", key: "category", w: 2.6 },
            { label: "Account", key: "account", w: 2.6 },
            { label: "Note", key: "note", w: 3.4 },
            {
              label: "Amount",
              key: "amount",
              w: 2.2,
              align: "right",
              format: (v, r) => (r.type === "income" ? "+" : r.type === "expense" ? "-" : "") + money(v),
              color: (v, r) => (r.type === "income" ? GREEN : r.type === "expense" ? RED : MUTED),
            },
          ],
          report.transactions,
          { rowH: 17 }
        );
      }
    } else {
      section("Month by month");
      const rows = report.months.map((m) => ({ ...m }));
      rows.push({
        label: "Year",
        in: t.in,
        out: t.out,
        net: t.net,
        budget: report.budgetedMonths ? rows.reduce((s, r) => s + (r.budget || 0), 0) : null,
        saved: report.budgetedMonths ? report.saved : null,
        __total: true,
      });
      table(
        [
          { label: "Month", key: "label", w: 1.6 },
          { label: "In", key: "in", w: 2, align: "right", format: money },
          { label: "Out", key: "out", w: 2, align: "right", format: money },
          { label: "Net", key: "net", w: 2, align: "right", format: money, color: (v) => (v < 0 ? RED : INK) },
          { label: "Budget", key: "budget", w: 2, align: "right", format: (v) => (v == null ? "-" : money(v)) },
          {
            label: "Saved",
            key: "saved",
            w: 2,
            align: "right",
            format: (v) => (v == null ? "-" : money(v)),
            color: (v) => (v == null ? MUTED : v < 0 ? RED : GREEN),
          },
        ],
        rows
      );
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      text("Saved = budgeted minus spent in the budgeted categories, for months that have a budget.", L, doc.y);
      doc.y += 12;

      if (report.budgetByCategory.length) {
        section(`Budget by category (${report.budgetedMonths} month${report.budgetedMonths === 1 ? "" : "s"} with a budget)`);
        table(
          [
            { label: "Category", key: "name", w: 3 },
            { label: "Budget", key: "limit", w: 2, align: "right", format: money },
            { label: "Spent", key: "spent", w: 2, align: "right", format: money },
            { label: "Left", key: "left", w: 2, align: "right", format: (v) => (v < 0 ? "over " + money(-v) : money(v)), color: (v) => (v < 0 ? RED : GREEN) },
          ],
          report.budgetByCategory
        );
      }

      section("Spending by category");
      if (!report.categories.length) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED);
        text("No expenses this year.", L, doc.y);
      } else {
        table(
          [
            { label: "Category", key: "name", w: 4 },
            { label: "Spent", key: "spent", w: 2, align: "right", format: money },
          ],
          report.categories
        );
      }
    }

    // ---- footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      const y = doc.page.height - 30;
      doc.page.margins.bottom = 0; // allow writing in the footer area without adding a page
      text("Ledger", L, y);
      text(`Page ${i + 1} of ${range.count}`, L, y, { width: W, align: "right" });
    }
    doc.end();
  });
}

module.exports = { buildReport, renderPdf, budgetFor, planTotal, MONTH_RE, YEAR_RE, monthName };
