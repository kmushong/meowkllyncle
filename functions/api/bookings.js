// POST /api/bookings  — create a new booking
import {
  parseBooking, validDate, getCapacity, slotCount, isBlocked,
  run, exec, todayLocal, json, err, notifyNew,
} from "../_shared.js";

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return err("Bad request."); }

  const p = parseBooking(body);
  if (!p.ok) return err(p.error, p.status);

  const { name, contact, address, area, meds, notes, cats, visits, total } = p.ok;
  const today = todayLocal();
  if (visits.some((v) => v.date < today)) return err("Invalid visit details.");

  const db = env.DB;

  // Check capacity and blocks before inserting.
  const cap = await getCapacity(db);
  const conflicts = [];
  for (const k of new Set(visits.map((v) => v.date + "|" + v.slot))) {
    const [date, slot] = k.split("|");
    if ((await isBlocked(db, date, slot)) || (await slotCount(db, date, slot, 0)) >= cap) {
      conflicts.push({ date, slot });
    }
  }
  if (conflicts.length) {
    return json({ error: "Some of those times just filled up.", conflicts }, 409);
  }

  // D1 does not support interactive transactions in Pages Functions — use a batch instead.
  const insertBooking = db.prepare(
    "INSERT INTO bookings (name, contact, address, area, cats, meds, notes, total) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(name, contact, address, area, cats.join(", "), meds, notes, total);

  const { meta: bMeta } = await insertBooking.run();
  const id = Number(bMeta.last_row_id);

  // Insert all visit rows.
  const visitStmts = visits.map((v) =>
    db.prepare("INSERT INTO visits (booking_id, date, slot, len, price) VALUES (?,?,?,?,?)")
      .bind(id, v.date, v.slot, v.len, v.price),
  );
  if (visitStmts.length) await db.batch(visitStmts);

  notifyNew(env, { id, name, cats, visits, total });
  return json({ id, status: "pending", total }, 201);
}
