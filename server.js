"use strict";
// Booking server for Render: serves the site, stores bookings in Turso (libSQL), enforces slot capacity.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createClient } = require("@libsql/client");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_CAPACITY = Number(process.env.SLOT_CAPACITY) || 3;
const TIME_ZONE = process.env.TIME_ZONE || "America/New_York";
const SLOTS = ["morning", "afternoon", "evening"];
const RATES = { "20": 30, "45": 47 };
const ACTIVE = "('pending','confirmed')";
const STATUSES = ["pending", "confirmed", "declined", "cancelled"];
const IS_PROD = !!process.env.RENDER || process.env.NODE_ENV === "production";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_PASSWORD) console.error("ADMIN_PASSWORD is not set — /admin and the admin API are disabled until it is.");

let DB_URL = process.env.TURSO_DATABASE_URL;
if (!DB_URL) {
  if (IS_PROD) { console.error("TURSO_DATABASE_URL is required in production."); process.exit(1); }
  DB_URL = "file:bookings.db";
  console.warn("TURSO_DATABASE_URL not set — using local file bookings.db (development only).");
}
const client = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });

async function initSchema() {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      name TEXT NOT NULL, contact TEXT NOT NULL, address TEXT NOT NULL, area TEXT,
      cats TEXT NOT NULL, meds TEXT, notes TEXT, total INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      date TEXT NOT NULL, slot TEXT NOT NULL, len TEXT NOT NULL, price INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_visits_date_slot ON visits(date, slot)",
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      UNIQUE(date, slot)
    )`,
  ], "write");
}

// `ex` is either the client or an open transaction; both expose execute().
const run = async (ex, sql, args = []) => (await ex.execute({ sql, args })).rows;
const one = async (ex, sql, args = []) => (await run(ex, sql, args))[0];

async function getCapacity() {
  const r = await one(client, "SELECT value FROM settings WHERE key = 'capacity'");
  const n = r ? Number(r.value) : DEFAULT_CAPACITY;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAPACITY;
}
async function slotCount(ex, date, slot, excludeId) {
  const r = await one(ex, `
    SELECT COUNT(DISTINCT v.booking_id) AS c
    FROM visits v JOIN bookings b ON b.id = v.booking_id
    WHERE b.status IN ${ACTIVE} AND v.date = ? AND v.slot = ? AND b.id != ?`, [date, slot, excludeId]);
  return Number(r.c);
}
const isBlocked = async (ex, date, slot) => !!(await one(ex, "SELECT 1 AS x FROM blocks WHERE date = ? AND (slot = '' OR slot = ?)", [date, slot]));
const visitsFor = (ex, id) => run(ex, "SELECT date, slot, len, price FROM visits WHERE booking_id = ? ORDER BY date, slot", [id]);

async function withTx(fn) {
  const tx = await client.transaction("write");
  try { return await fn(tx); }
  catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
  finally { tx.close(); }
}

function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function fullSlots(from, to) {
  const full = {};
  const add = (date, slot) => {
    const list = (full[date] = full[date] || []);
    if (!list.includes(slot)) list.push(slot);
  };
  const cap = await getCapacity();
  const counts = await run(client, `
    SELECT v.date AS date, v.slot AS slot, COUNT(DISTINCT v.booking_id) AS c
    FROM visits v JOIN bookings b ON b.id = v.booking_id
    WHERE b.status IN ${ACTIVE} AND v.date BETWEEN ? AND ?
    GROUP BY v.date, v.slot`, [from, to]);
  for (const r of counts) if (Number(r.c) >= cap) add(r.date, r.slot);
  for (const b of await run(client, "SELECT date, slot FROM blocks WHERE date BETWEEN ? AND ?", [from, to])) {
    if (b.slot) add(b.date, b.slot);
    else SLOTS.forEach((sl) => add(b.date, sl));
  }
  return full;
}

function parseBooking(body) {
  const name = str(body.name, 120), contact = str(body.contact, 160), address = str(body.address, 240);
  const area = str(body.area, 80), meds = str(body.meds, 2000), notes = str(body.notes, 2000);
  const cats = Array.isArray(body.cats) ? body.cats.map((c) => str(c, 60)).filter(Boolean).slice(0, 10) : [];
  if (!name || !contact || !address || !cats.length) return { status: 400, error: "Missing required details." };
  if (!Array.isArray(body.visits) || !body.visits.length || body.visits.length > 120)
    return { status: 400, error: "Pick at least one date." };

  const seen = new Set();
  const visits = [];
  for (const v of body.visits) {
    if (!v || !validDate(v.date) || !SLOTS.includes(v.slot) || !RATES[v.len])
      return { status: 400, error: "Invalid visit details." };
    visits.push({ date: v.date, slot: v.slot, len: String(v.len), price: RATES[v.len] });
    seen.add(v.date);
  }
  if (seen.size > 60) return { status: 400, error: "Too many dates in one request." };
  const total = visits.reduce((s, v) => s + v.price, 0);
  return { ok: { name, contact, address, area, meds, notes, cats, visits, total } };
}

async function createBooking(body) {
  const p = parseBooking(body);
  if (!p.ok) return p;
  const { name, contact, address, area, meds, notes, cats, visits, total } = p.ok;
  const today = todayLocal();
  if (visits.some((v) => v.date < today)) return { status: 400, error: "Invalid visit details." };

  const result = await withTx(async (tx) => {
    const cap = await getCapacity();
    const conflicts = [];
    for (const k of new Set(visits.map((v) => v.date + "|" + v.slot))) {
      const [date, slot] = k.split("|");
      if ((await isBlocked(tx, date, slot)) || (await slotCount(tx, date, slot, 0)) >= cap) conflicts.push({ date, slot });
    }
    if (conflicts.length) { await tx.rollback(); return { status: 409, error: "Some of those times just filled up.", conflicts }; }
    const r = await tx.execute({
      sql: "INSERT INTO bookings (name, contact, address, area, cats, meds, notes, total) VALUES (?,?,?,?,?,?,?,?)",
      args: [name, contact, address, area, cats.join(", "), meds, notes, total],
    });
    const id = Number(r.lastInsertRowid);
    for (const v of visits) await tx.execute({ sql: "INSERT INTO visits (booking_id, date, slot, len, price) VALUES (?,?,?,?,?)", args: [id, v.date, v.slot, v.len, v.price] });
    await tx.commit();
    return { status: 201, body: { id, status: "pending", total }, notify: { id, name, cats, visits, total } };
  });
  if (result.notify) notifyNew(result.notify);
  return result;
}

async function updateBooking(id, body) {
  const b = await one(client, "SELECT status FROM bookings WHERE id = ?", [id]);
  if (!b) return { status: 404, error: "Not found." };
  const p = parseBooking(body);
  if (!p.ok) return p;
  const { name, contact, address, area, meds, notes, cats, visits, total } = p.ok;
  return withTx(async (tx) => {
    if (b.status === "pending" || b.status === "confirmed") {
      const cap = await getCapacity();
      for (const k of new Set(visits.map((v) => v.date + "|" + v.slot))) {
        const [date, slot] = k.split("|");
        if ((await slotCount(tx, date, slot, id)) >= cap) { await tx.rollback(); return { status: 409, error: date + " " + slot + " is already full." }; }
      }
    }
    await tx.execute({ sql: "UPDATE bookings SET name=?, contact=?, address=?, area=?, cats=?, meds=?, notes=?, total=? WHERE id=?", args: [name, contact, address, area, cats.join(", "), meds, notes, total, id] });
    await tx.execute({ sql: "DELETE FROM visits WHERE booking_id = ?", args: [id] });
    for (const v of visits) await tx.execute({ sql: "INSERT INTO visits (booking_id, date, slot, len, price) VALUES (?,?,?,?,?)", args: [id, v.date, v.slot, v.len, v.price] });
    await tx.commit();
    return { status: 200, body: { id } };
  });
}

async function changeStatus(id, status) {
  const b = await one(client, "SELECT status FROM bookings WHERE id = ?", [id]);
  if (!b) return { status: 404, error: "Not found." };
  if (!STATUSES.includes(status)) return { status: 400, error: "Bad status." };
  const reactivating = (status === "pending" || status === "confirmed") && !["pending", "confirmed"].includes(b.status);
  return withTx(async (tx) => {
    if (reactivating) {
      const cap = await getCapacity();
      for (const v of await visitsFor(tx, id)) {
        if ((await isBlocked(tx, v.date, v.slot)) || (await slotCount(tx, v.date, v.slot, id)) >= cap) {
          await tx.rollback();
          return { status: 409, error: v.date + " " + v.slot + " is already full or blocked." };
        }
      }
    }
    await tx.execute({ sql: "UPDATE bookings SET status = ? WHERE id = ?", args: [status, id] });
    await tx.commit();
    return { status: 200, body: { id, status } };
  });
}

async function addBlock(body) {
  const slot = body.slot ? String(body.slot) : "";
  if (!validDate(body.date) || (slot && !SLOTS.includes(slot))) return { status: 400, error: "Bad date or slot." };
  await client.execute({ sql: "INSERT OR IGNORE INTO blocks (date, slot, reason) VALUES (?,?,?)", args: [body.date, slot, str(body.reason, 120)] });
  return { status: 201, body: { ok: true } };
}

async function setCapacity(body) {
  const n = Number(body.capacity);
  if (!Number.isInteger(n) || n < 1 || n > 20) return { status: 400, error: "Capacity must be a whole number from 1 to 20." };
  await client.execute({ sql: "INSERT INTO settings (key, value) VALUES ('capacity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [String(n)] });
  return { status: 200, body: { capacity: n } };
}

async function allBookings() {
  const rows = await run(client, "SELECT * FROM bookings ORDER BY id DESC LIMIT 500");
  const visits = rows.length
    ? await run(client, `SELECT booking_id, date, slot, len, price FROM visits WHERE booking_id IN (${rows.map(() => "?").join(",")}) ORDER BY date, slot`, rows.map((r) => r.id))
    : [];
  return rows.map((b) => ({
    ...b,
    id: Number(b.id),
    total: Number(b.total),
    visits: visits.filter((v) => Number(v.booking_id) === Number(b.id)).map((v) => ({ date: v.date, slot: v.slot, len: v.len, price: Number(v.price) })),
  }));
}

function csvCell(v) {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}
async function exportCsv() {
  const head = ["Booking", "Submitted (UTC)", "Status", "Name", "Contact", "Address", "Area", "Cats", "Visit date", "Slot", "Minutes", "Price", "Booking total", "Medication", "Notes"];
  const lines = [head.map(csvCell).join(",")];
  for (const b of await allBookings()) {
    for (const v of b.visits) {
      lines.push([b.id, b.created_at, b.status, b.name, b.contact, b.address, b.area, b.cats, v.date, v.slot, v.len, v.price, b.total, b.meds, b.notes].map(csvCell).join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

function notifyNew(b) {
  const days = [...new Set(b.visits.map((v) => v.date))].sort();
  const text = b.name + " — " + b.cats.join(", ") + "\n" + days.length + " day(s): " + days.join(", ") + "\nTotal $" + b.total;
  const ntfy = process.env.NTFY_TOPIC;
  if (ntfy) {
    const headers = { Title: "New booking request #" + b.id, Tags: "cat" };
    if (process.env.NOTIFY_EMAIL) headers.Email = process.env.NOTIFY_EMAIL;
    fetch((process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "") + "/" + encodeURIComponent(ntfy), {
      method: "POST", headers, body: text, signal: AbortSignal.timeout(5000),
    }).catch((e) => console.error("ntfy failed:", e.message));
  }
  if (process.env.NOTIFY_WEBHOOK_URL) {
    fetch(process.env.NOTIFY_WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ id: b.id, name: b.name, cats: b.cats, dates: days, total: b.total, text }),
    }).catch((e) => console.error("webhook failed:", e.message));
  }
}

// ---- admin auth (HTTP Basic, user "admin") with a simple failed-attempt limiter ----
const fails = new Map();
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}
function authState(req) {
  if (!ADMIN_PASSWORD) return "disabled";
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 15 * 60 * 1000) return "locked";
  const h = req.headers.authorization || "";
  let ok = false;
  if (h.startsWith("Basic ")) {
    const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString().split(":");
    const a = crypto.createHash("sha256").update(rest.join(":")).digest();
    const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
    ok = user === "admin" && crypto.timingSafeEqual(a, b);
  }
  if (ok) { fails.delete(ip); return "ok"; }
  if (h) fails.set(ip, { n: (f && Date.now() - f.t < 15 * 60 * 1000 ? f.n : 0) + 1, t: Date.now() });
  return "denied";
}

function send(res, status, body, type) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": type || (isObj ? "application/json" : "text/plain; charset=utf-8"),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return reject(new Error("type"));
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 100000) { reject(new Error("size")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); } });
  });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const ok = rel === "/index.html" || rel.startsWith("/cat-frames/") || rel.startsWith("/images/");
  let file;
  try { file = path.normalize(path.join(ROOT, decodeURIComponent(rel))); } catch (_) { return send(res, 404, "Not found"); }
  if (!ok || !file.startsWith(ROOT + path.sep) || !TYPES[path.extname(file)]) return send(res, 404, "Not found");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": rel === "/index.html" ? "no-cache" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
}

const reply = (res, r) => send(res, r.status, r.body || { error: r.error, conflicts: r.conflicts });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/healthz") return send(res, 200, "ok");
    if (p === "/api/availability" && req.method === "GET") {
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      if (!validDate(from) || !validDate(to)) return send(res, 400, { error: "Bad range." });
      return send(res, 200, { capacity: await getCapacity(), full: await fullSlots(from, to) });
    }
    if (p === "/api/bookings" && req.method === "POST") return reply(res, await createBooking(await readJson(req)));

    if (p === "/admin" || p.startsWith("/api/admin/")) {
      const a = authState(req);
      if (a === "disabled") return send(res, 503, "Admin is disabled: ADMIN_PASSWORD is not set.");
      if (a === "locked") return send(res, 429, "Too many failed attempts. Try again in 15 minutes.");
      if (a !== "ok") {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Kelly admin"', "Cache-Control": "no-store" });
        return res.end("Authentication required");
      }
      if (p === "/admin" && req.method === "GET")
        return fs.readFile(path.join(ROOT, "admin.html"), (e, d) => (e ? send(res, 500, "Missing admin page") : send(res, 200, d, "text/html; charset=utf-8")));
      if (p === "/api/admin/bookings" && req.method === "GET") return send(res, 200, { capacity: await getCapacity(), bookings: await allBookings() });
      if (p === "/api/admin/blocks" && req.method === "GET")
        return send(res, 200, { blocks: (await run(client, "SELECT id, date, slot, reason FROM blocks WHERE date >= ? ORDER BY date, slot", [todayLocal()])).map((b) => ({ ...b, id: Number(b.id) })) });
      if (p === "/api/admin/blocks" && req.method === "POST") return reply(res, await addBlock(await readJson(req)));
      const bm = p.match(/^\/api\/admin\/blocks\/(\d+)$/);
      if (bm && req.method === "DELETE") { await client.execute({ sql: "DELETE FROM blocks WHERE id = ?", args: [Number(bm[1])] }); return send(res, 200, { ok: true }); }
      if (p === "/api/admin/settings" && req.method === "GET")
        return send(res, 200, { capacity: await getCapacity(), notify: { push: !!process.env.NTFY_TOPIC, email: !!(process.env.NTFY_TOPIC && process.env.NOTIFY_EMAIL), webhook: !!process.env.NOTIFY_WEBHOOK_URL } });
      if (p === "/api/admin/settings" && req.method === "POST") return reply(res, await setCapacity(await readJson(req)));
      if (p === "/api/admin/export.csv" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bookings-' + todayLocal() + '.csv"', "Cache-Control": "no-store" });
        return res.end("\ufeff" + (await exportCsv()));
      }
      const um = p.match(/^\/api\/admin\/bookings\/(\d+)$/);
      if (um && req.method === "POST") return reply(res, await updateBooking(Number(um[1]), await readJson(req)));
      const sm = p.match(/^\/api\/admin\/bookings\/(\d+)\/status$/);
      if (sm && req.method === "POST") return reply(res, await changeStatus(Number(sm[1]), (await readJson(req)).status));
      return send(res, 404, { error: "Not found" });
    }

    if (req.method === "GET") return serveStatic(res, p);
    send(res, 405, "Method not allowed");
  } catch (e) {
    if (e && (e.message === "type" || e.message === "size" || e instanceof SyntaxError)) return send(res, 400, { error: "Bad request." });
    console.error(e);
    send(res, 500, { error: "Server error." });
  }
});

initSchema()
  .then(() => server.listen(PORT, "0.0.0.0", () => console.log("Listening on port " + PORT)))
  .catch((e) => { console.error("Database setup failed:", e.message); process.exit(1); });
