"use strict";
const { createApp } = require("./app");
const { createMemoryStore, createMongoStore } = require("./store");

const env = process.env;
const production = env.NODE_ENV === "production";

function fail(msg) {
  console.error("Config error: " + msg);
  process.exit(1);
}

if (!env.GOOGLE_CLIENT_ID) fail("GOOGLE_CLIENT_ID is not set");
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail("SESSION_SECRET must be set and at least 32 characters long");

let store;
if (env.MEMORY_STORE === "1") {
  if (production) fail("MEMORY_STORE=1 would lose all data on restart; not allowed in production");
  console.warn("Using the in-memory store: data disappears when the server stops.");
  store = createMemoryStore();
} else {
  if (!env.MONGODB_URI) fail("MONGODB_URI is not set");
  store = createMongoStore(env.MONGODB_URI, env.DB_NAME || "ledger");
}

const { OAuth2Client } = require("google-auth-library");
const oauth = new OAuth2Client(env.GOOGLE_CLIENT_ID);
async function verifyGoogle(credential) {
  const ticket = await oauth.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  return { sub: p.sub, email: p.email, email_verified: p.email_verified, name: p.name, picture: p.picture };
}

const allowedEmails = env.ALLOWED_EMAILS
  ? new Set(env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))
  : null;

(async () => {
  await store.init();
  const app = createApp({
    store,
    verifyGoogle,
    config: {
      googleClientId: env.GOOGLE_CLIENT_ID,
      sessionSecret: env.SESSION_SECRET,
      allowedEmails,
      quotaBytes: (Number(env.QUOTA_MB) || 40) * 1024 * 1024,
      production,
    },
  });
  const port = Number(env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`Ledger listening on :${port} (${store.kind} store, ${allowedEmails ? allowedEmails.size + " invited emails" : "open to any Google account"})`);
  });
  const stop = async () => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})().catch((e) => {
  console.error("Failed to start:", e && e.message);
  process.exit(1);
});
