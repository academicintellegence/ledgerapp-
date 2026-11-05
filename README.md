# Ledger Cloud

Your Ledger expense tracker with **Google sign-in** and **cloud sync**: the same app, but every person's
accounts, entries, receipt photos, categories and recurring items are stored under their own Google login.
Built for you plus a handful of friends, entirely on free tiers.

```
Phone / browser ──► Render (Node + Express, free web service)
                        │  serves the app and a small API
                        └─► MongoDB Atlas (free M0 cluster) — all the data
Google ──► only used to prove who you are at sign-in
```

## What was tested, and what wasn't

- **Tested automatically:** the API and report code (20 tests: login rules, per-user isolation, quotas, validation,
  import/export, cross-site protection, budget plans, the PDF endpoint and the budget maths) and the app in a real
  browser against the real server (including the budget screen, editing budgets, PDF downloads, and the Drive upload
  flow against a stand-in for Google).
- **Not tested, because it can't be done from where this was built:**
  1. the real **MongoDB Atlas** connection (tests use an in-memory stand-in with the same interface),
  2. real **Google sign-in** (tests use a fake verifier), especially the redirect flow inside an installed iPhone app,
  3. the real **Google Drive** upload (tests use a stand-in that checks the requests Ledger sends, not Google itself).

  Expect to spend a few minutes on the first real sign-in. If something fails, the Render log (Logs tab) says why.

---

## Do the steps in this order

### Step 1 — Save your current data (do this first)
Use the `old-site-update` folder. It adds a **Download backup** button to your current site. Your data lives in the
browser on your device, not on GitHub, so this file is the only way to carry it over. See `old-site-update/README.txt`.

### Step 2 — MongoDB Atlas (the database)
1. Sign up at mongodb.com/cloud/atlas and create a **free (M0)** cluster. Pick AWS and a region near Frankfurt
   (e.g. `eu-central-1`) to sit close to the server.
2. **Database Access** → add a database user (e.g. `ledger`) with a strong password → role *Read and write to any database*.
   Avoid special characters in the password (otherwise they must be URL-encoded in the connection string).
3. **Network Access** → *Add IP address* → *Allow access from anywhere* (`0.0.0.0/0`). Render's free plan has no fixed
   IP address, so it can't be narrowed down. Access is protected by the database password.
4. **Connect** → *Drivers* → copy the connection string, which looks like
   `mongodb+srv://ledger:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
   Replace `<password>` with your password. This is your `MONGODB_URI`.

The free cluster has **512 MB** of storage and **no automatic backups**, so use *Settings → Download backup* regularly.

### Step 3 — Put the code on GitHub
Create a **new** repository (private is fine) and push the contents of the `ledger-cloud` folder into it. Keep your
old repository as it is until the new site works.

```
cd ledger-cloud
git init && git add . && git commit -m "Ledger cloud"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/ledger-cloud.git
git push -u origin main
```
The `.gitignore` keeps `.env` and `node_modules` out of the repository. Never commit real secrets.

### Step 4 — Render (the server)
1. render.com → **New → Blueprint** → pick the repository. It reads `render.yaml` and proposes a free web service in Frankfurt.
   (Or create a *Web Service* by hand: build command `npm install`, start command `npm start`, plan *Free*.)
2. Fill in the environment variables:

| Variable | Value |
|---|---|
| `MONGODB_URI` | the connection string from Step 2 |
| `GOOGLE_CLIENT_ID` | type `pending` for now; you get the real one in Step 5 |
| `ALLOWED_EMAILS` | comma-separated Google emails allowed in, e.g. `you@gmail.com,friend@gmail.com` |
| `SESSION_SECRET` | generated for you by Render (needs 32+ characters) |
| `NODE_ENV` | `production` (already set) |
| `QUOTA_MB` *(optional)* | storage per person, default 40 |

3. After creating it, note the address Render gives you: `https://SOMETHING.onrender.com`.
   If the first deploy complains, that is expected until Step 5 is done.

`ALLOWED_EMAILS` is the invite list: only these Google accounts can sign in. Leave it empty to let anyone with a Google account in.
To add a friend later: edit this variable in Render (the service restarts) — no code change.

### Step 5 — Google sign-in
1. console.cloud.google.com → create a project (e.g. "Ledger").
2. Set up the **OAuth consent screen** (shown as *Google Auth Platform* in newer consoles): user type *External*,
   app name *Ledger*, your email as support and developer contact. Either keep it in *Testing* and add each friend's Google
   address under *Test users* (up to 100), or *publish* it. The app only asks for basic sign-in info
   (name, email, picture), which should not need Google's review.
3. **Credentials → Create credentials → OAuth client ID → Web application**, and add:
   - *Authorized JavaScript origins:* `https://SOMETHING.onrender.com`
   - *Authorized redirect URIs:* `https://SOMETHING.onrender.com/auth/google/callback`
4. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`; no secret is needed).
5. Back in Render, replace `GOOGLE_CLIENT_ID` with it and save. The service redeploys.

> Google's menus get renamed from time to time. I couldn't open Google's current documentation while building this, so the
> labels above may differ slightly. The settings that matter are the exact origin and the exact redirect URI.

### Step 6 — Sign in and import your old data
1. Open `https://SOMETHING.onrender.com`. **The first visit after idle takes up to a minute** because the free server sleeps
   after 15 minutes without traffic; the app says "Waking up the server…".
2. Sign in with Google.
3. **☰ → Settings → Import backup**, and choose the file from Step 1. Importing the same file twice never makes duplicates.
4. Check Overview and Receipts. The empty default "Debit card" account is removed automatically if your backup brought real accounts.
5. Settings → paste your Gemini API key again (it is deliberately kept on each device and never sent to the server).

### Step 7 — Put it on your phone
Open the Render address in Safari → Share → **Add to Home Screen**, then sign in inside the installed app.
The installed app uses Google's redirect sign-in (needed on iPhone). If sign-in misbehaves there, tell me exactly what happens;
as an experiment, `https://SOMETHING.onrender.com/?login=popup` switches to the pop-up style.

### Step 8 — Turn on Export to Google Drive (only needed for the Drive button; PDF download works without it)
Saving to Drive uses Google's narrowest Drive permission, `drive.file`: Ledger can only see files **it created itself**
(a folder called "Ledger" and the PDFs in it), never the rest of anyone's Drive. Google lists this permission as
non-sensitive, which should avoid the stricter app review.
1. console.cloud.google.com → your "Ledger" project → **APIs & Services → Library** → search **Google Drive API** → **Enable**.
2. **OAuth consent screen** (*Google Auth Platform → Data access*) → **Add or remove scopes** → add
   `https://www.googleapis.com/auth/drive.file` → Save.
3. Nothing else changes: the same Client ID and the same website address are used. If the app is still in *Testing*,
   each friend must be in the *Test users* list (same as for sign-in).
4. In the app: ☰ → **Export** → **Save to Google Drive**. The first time, Google opens a permission window; keep the
   Drive box ticked. If you see "Google Drive API isn't switched on", step 1 is missing.

If the permission window won't open (this can happen in an iPhone home-screen app), use **Download PDF** in the same
window: the iPhone share sheet lets you save the file to Files or the Drive app.

---

## How it behaves

- **Sync:** data is loaded from the server and refreshed whenever you return to the app, so a change made on your laptop
  shows up on your phone. A save that fails (no connection) shows a message instead of silently disappearing.
- **No offline logging:** the app shell opens offline, but entries need a connection to be saved.
- **Budgets:** ☰ → **Budget**. At the start of a month, press *Set up budget* and enter an amount per category
  (or *Copy* last month's). Pick **All accounts** for your overall budget, or choose one account to give it its own
  budget. The screen shows budgeted / spent / left for each category, turns amber at 85% and red when you go over, and
  keeps a list of the year's months. *Saved* = the budgeted amount minus what you spent in the budgeted categories
  (spending in categories without a budget is listed separately and doesn't change it). A finished month says
  "Saved", the current month says "Left". Spending only counts expenses; transfers between your accounts don't.
  The "All accounts" budget and each account's budget are separate on purpose, so they don't have to add up.
  Category limits from the old version are used to fill in a new month's form.
- **Export:** ☰ → **Export** (or the button on the Budget screen). Choose one month or a whole year, for all accounts
  or one account, then **Download PDF** or **Save to Google Drive**. The PDF has the totals, your budget and what you
  saved, spending by category and the transactions (a year shows month-by-month figures instead). Exporting the same
  period again replaces the file in Drive instead of making a copy. Receipt photos are not included in the PDF.
- **Receipt photos:** shrunk on the phone (about 150–300 KB each) before upload, saved in the database, and shown from
  the server on demand. Each person has a 40 MB allowance by default (about 150+ receipts).
- **Backup / restore:** Settings → Download backup / Import backup. Backups contain everything including receipt photos.
- **Delete my account:** Settings → removes the account and all its data from the database.
- **Per-device only (never on the server):** your Gemini API key, the 4/min and 40/day receipt-read counter, and "last used account".

## Free-tier limits to know about

- **Render free web service:** sleeps after 15 minutes idle (about a minute to wake); 750 free instance-hours per month
  (one always-awake service uses almost all of it, but a sleeping one doesn't count); no disk (everything is in Atlas); outbound
  bandwidth is limited, and receipt photos are cached by the browser to keep it low.
- **Atlas M0:** 512 MB, roughly 100 operations per second, no backups. Atlas may also pause an unused free cluster after a
  long period of inactivity, so check it isn't paused if the app suddenly can't connect.
- Limits and plans change; check render.com/docs/free and mongodb.com/pricing for the current numbers.

## Privacy and security — be upfront with your friends

- Sign-in is Google only. No passwords are stored. The server verifies Google's token and issues its own login cookie
  (httpOnly, secure, 30 days).
- Each person's data is isolated by their account in every query (tested), and storage is capped per person.
- **You, as the owner, can technically read everyone's data** in the Atlas dashboard. Anyone with access to the database can.
  Tell your friends this. Friends can delete their account and data themselves from Settings.
- Because friends' financial data is stored, EU privacy rules (GDPR) apply to some extent even for a small project. Keep it
  to people who knowingly agreed, and keep `ALLOWED_EMAILS` set.
- The page's Content-Security-Policy is switched off for now, because the app is one HTML file with inline scripts.
  Tightening this is a sensible hardening step later.
- The Gemini key is still used from the phone directly, as before.

## Running it on your own computer (optional)

```
npm install
cp .env.example .env     # fill it in
npm test                 # API tests, no database or Google needed
npm run dev              # in-memory database: data disappears when you stop it
```
For real sign-in on `http://localhost:3000`, add that origin to your Google client too.

## What is not built yet

- The currency symbol is still `$` everywhere (in the app and in the PDFs).
- PDFs show Latin letters only: emoji and non-Latin characters in notes are left out of the PDF (the app itself shows them).
- No CSV export, and no budget alerts or rollover of unspent money into the next month.

## Files

```
server/        the API (app.js), the database layer (store.js), PDF reports (report.js), startup (index.js)
public/        the app: index.html, sw.js, manifest.json, icons
test/          API, budget and report tests (npm test)
render.yaml    Render blueprint
.env.example   the settings the server needs
old-site-update/   Step 1: your current site plus a backup button
```
