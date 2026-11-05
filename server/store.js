"use strict";
/*
 * Storage layer. Two implementations with the same interface:
 *  - createMongoStore(uri, dbName): the real thing (MongoDB Atlas)
 *  - createMemoryStore(): in-memory, for tests and local dev without a database
 *
 * Everything a user owns is a "doc": { uid, store, id, data, size, updatedAt }.
 * `store` is one of the app's collections (entries, receipts, ...); `data` is
 * whatever the app saved. Docs are always scoped by uid, so one user can never
 * reach another user's rows.
 */

const docKey = (uid, store, id) => `${uid}|${store}|${id}`;

function createMemoryStore() {
  const users = new Map();
  const docs = new Map();
  return {
    kind: "memory",
    async init() {},
    async close() {},
    async upsertUser(profile) {
      const now = Date.now();
      const existing = users.get(profile.sub);
      const user = {
        _id: profile.sub,
        email: profile.email,
        name: profile.name || "",
        picture: profile.picture || "",
        createdAt: existing ? existing.createdAt : now,
        lastLoginAt: now,
      };
      users.set(profile.sub, user);
      return user;
    },
    async getUser(sub) {
      return users.get(sub) || null;
    },
    async deleteUser(uid) {
      users.delete(uid);
      for (const k of [...docs.keys()]) if (docs.get(k).uid === uid) docs.delete(k);
    },
    async getDoc(uid, store, id) {
      const d = docs.get(docKey(uid, store, id));
      return d ? structuredClone(d) : null;
    },
    async listDocs(uid, store) {
      const out = [];
      for (const d of docs.values()) if (d.uid === uid && d.store === store) out.push(structuredClone(d));
      return out;
    },
    async putDoc(uid, store, id, data, size) {
      docs.set(docKey(uid, store, id), { uid, store, id, data: structuredClone(data), size, updatedAt: Date.now() });
    },
    async putDocs(uid, items) {
      for (const it of items) await this.putDoc(uid, it.store, it.id, it.data, it.size);
    },
    async deleteDoc(uid, store, id) {
      return docs.delete(docKey(uid, store, id));
    },
    async usage(uid) {
      let total = 0;
      for (const d of docs.values()) if (d.uid === uid) total += d.size;
      return total;
    },
    async docSize(uid, store, id) {
      const d = docs.get(docKey(uid, store, id));
      return d ? d.size : 0;
    },
    async sizes(uid) {
      const m = new Map();
      for (const d of docs.values()) if (d.uid === uid) m.set(`${d.store}|${d.id}`, d.size);
      return m;
    },
  };
}

function createMongoStore(uri, dbName) {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  let users, docs;
  return {
    kind: "mongo",
    async init() {
      await client.connect();
      const db = client.db(dbName);
      users = db.collection("users");
      docs = db.collection("docs");
      await docs.createIndex({ uid: 1, store: 1 });
    },
    async close() {
      await client.close();
    },
    async upsertUser(profile) {
      const now = Date.now();
      await users.updateOne(
        { _id: profile.sub },
        {
          $set: { email: profile.email, name: profile.name || "", picture: profile.picture || "", lastLoginAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      return users.findOne({ _id: profile.sub });
    },
    async getUser(sub) {
      return users.findOne({ _id: sub });
    },
    async deleteUser(uid) {
      await docs.deleteMany({ uid });
      await users.deleteOne({ _id: uid });
    },
    async getDoc(uid, store, id) {
      return docs.findOne({ _id: docKey(uid, store, id) });
    },
    async listDocs(uid, store) {
      return docs.find({ uid, store }).toArray();
    },
    async putDoc(uid, store, id, data, size) {
      await docs.replaceOne(
        { _id: docKey(uid, store, id) },
        { uid, store, id, data, size, updatedAt: Date.now() },
        { upsert: true }
      );
    },
    async putDocs(uid, items) {
      if (!items.length) return;
      const now = Date.now();
      await docs.bulkWrite(
        items.map((it) => ({
          replaceOne: {
            filter: { _id: docKey(uid, it.store, it.id) },
            replacement: { uid, store: it.store, id: it.id, data: it.data, size: it.size, updatedAt: now },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    },
    async deleteDoc(uid, store, id) {
      const r = await docs.deleteOne({ _id: docKey(uid, store, id) });
      return r.deletedCount > 0;
    },
    async usage(uid) {
      const r = await docs.aggregate([{ $match: { uid } }, { $group: { _id: null, total: { $sum: "$size" } } }]).toArray();
      return r.length ? r[0].total : 0;
    },
    async docSize(uid, store, id) {
      const d = await docs.findOne({ _id: docKey(uid, store, id) }, { projection: { size: 1 } });
      return d ? d.size : 0;
    },
    async sizes(uid) {
      const m = new Map();
      const cursor = docs.find({ uid }, { projection: { store: 1, id: 1, size: 1 } });
      for await (const d of cursor) m.set(`${d.store}|${d.id}`, d.size);
      return m;
    },
  };
}

module.exports = { createMemoryStore, createMongoStore };
