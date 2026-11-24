// Shared helpers for all Pages Functions.
// D1 uses the standard sql-tagged API: db.prepare(sql).bind(...args).all() / .first() / .run()

export const SLOTS = ["morning", "afternoon", "evening"];
export const RATES = { "20": 30, "45": 47 };
export const ACTIVE = "('pending','confirmed')";
export const STATUSES = ["pending", "confirmed", "declined", "cancelled"];
export const DEFAULT_CAPACITY = 3;

// ---- D1 helpers ----

/** Run a SELECT and return all rows. */
export async function run(db, sql, args = []) {
  const stmt = db.prepare(sql);
  const bound = args.length ? stmt.bind(...args) : stmt;
  const { results } = await bound.all();
  return results ?? [];
}

/** Run a SELECT and return the first row (or undefined). */
export async function one(db, sql, args = []) {
  const stmt = db.prepare(sql);
  const bound = args.length ? stmt.bind(...args) : stmt;
  return bound.first();
}

/** Run an INSERT/UPDATE/DELETE. */
export async function exec(db, sql, args = []) {
  const stmt = db.prepare(sql);
  const bound = args.length ? stmt.bind(...args) : stmt;
  return bound.run();
}

// ---- Business logic helpers ----

export async function getCapacity(db) {
  const r = await one(db, "SELECT value FROM settings WHERE key = 'capacity'");
  const n = r ? Number(r.value) : DEFAULT_CAPACITY;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAPACITY;
}

export async function slotCount(db, date, slot, excludeId) {
  const r = await one(db,
    `SELECT COUNT(DISTINCT v.booking_id) AS c
     FROM visits v JOIN bookings b ON b.id = v.booking_id
     WHERE b.status IN ${ACTIVE} AND v.date = ? AND v.slot = ? AND b.id != ?`,
    [date, slot, excludeId]);
  return r ? Number(r.c) : 0;
}

export async function isBlocked(db, date, slot) {
  const r = await one(db,
    "SELECT 1 AS x FROM blocks WHERE date = ? AND (slot = '' OR slot = ?)",
    [date, slot]);
  return !!r;
}

export async function visitsFor(db, id) {
  return run(db,
    "SELECT date, slot, len, price FROM visits WHERE booking_id = ? ORDER BY date, slot",
    [id]);
}

export async function fullSlots(db, from, to) {
  const full = {};
  const add = (date, slot) => {
    const list = (full[date] = full[date] || []);
    if (!list.includes(slot)) list.push(slot);
  };
  const cap = await getCapacity(db);
  const counts = await run(db,
    `SELECT v.date AS date, v.slot AS slot, COUNT(DISTINCT v.booking_id) AS c
     FROM visits v JOIN bookings b ON b.id = v.booking_id
     WHERE b.status IN ${ACTIVE} AND v.date BETWEEN ? AND ?
     GROUP BY v.date, v.slot`,
    [from, to]);
  for (const r of counts) if (Number(r.c) >= cap) add(r.date, r.slot);
  for (const b of await run(db, "SELECT date, slot FROM blocks WHERE date BETWEEN ? AND ?", [from, to])) {
    if (b.slot) add(b.date, b.slot);
    else SLOTS.forEach((sl) => add(b.date, sl));
  }
  return full;
}

// ---- Input parsing / validation ----

export const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

const TIME_ZONE = "America/New_York";
export function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function parseBooking(body) {
  const name    = str(body.name,    120);
  const contact = str(body.contact, 160);
  const address = str(body.address, 240);
  const area    = str(body.area,     80);
  const meds    = str(body.meds,   2000);
  const notes   = str(body.notes,  2000);
  const cats    = Array.isArray(body.cats)
    ? body.cats.map((c) => str(c, 60)).filter(Boolean).slice(0, 10)
    : [];
  if (!name || !contact || !address || !cats.length)
    return { status: 400, error: "Missing required details." };
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

// ---- Response helpers ----

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function err(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

// ---- Notification (best-effort, fire-and-forget) ----

export function notifyNew(env, b) {
  const days = [...new Set(b.visits.map((v) => v.date))].sort();
  const text  = b.name + " — " + b.cats.join(", ") + "\n"
              + days.length + " day(s): " + days.join(", ")
              + "\nTotal $" + b.total;
  const ntfy  = env.NTFY_TOPIC;
  if (ntfy) {
    const headers = { Title: "New booking request #" + b.id, Tags: "cat" };
    if (env.NOTIFY_EMAIL) headers.Email = env.NOTIFY_EMAIL;
    fetch(
      (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "") + "/" + encodeURIComponent(ntfy),
      { method: "POST", headers, body: text, signal: AbortSignal.timeout(5000) },
    ).catch(() => {});
  }
  if (env.NOTIFY_WEBHOOK_URL) {
    fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.id, name: b.name, cats: b.cats, dates: days, total: b.total, text }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}
