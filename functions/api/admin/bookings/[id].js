// POST /api/admin/bookings/:id  — edit/reschedule a booking (admin only)
import {
  one, run, exec, getCapacity, slotCount, parseBooking, json, err,
} from "../../../_shared.js";

export async function onRequestPost({ params, request, env }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return err("Not found.", 404);

  const db = env.DB;
  const existing = await one(db, "SELECT status FROM bookings WHERE id = ?", [id]);
  if (!existing) return err("Not found.", 404);

  let body;
  try { body = await request.json(); }
  catch { return err("Bad request."); }

  const p = parseBooking(body);
  if (!p.ok) return err(p.error, p.status);

  const { name, contact, address, area, meds, notes, cats, visits, total } = p.ok;

  if (existing.status === "pending" || existing.status === "confirmed") {
    const cap = await getCapacity(db);
    for (const k of new Set(visits.map((v) => v.date + "|" + v.slot))) {
      const [date, slot] = k.split("|");
      if ((await slotCount(db, date, slot, id)) >= cap) {
        return err(date + " " + slot + " is already full.", 409);
      }
    }
  }

  const updateBooking = db.prepare(
    "UPDATE bookings SET name=?, contact=?, address=?, area=?, cats=?, meds=?, notes=?, total=? WHERE id=?",
  ).bind(name, contact, address, area, cats.join(", "), meds, notes, total, id);

  const deleteVisits = db.prepare("DELETE FROM visits WHERE booking_id = ?").bind(id);

  const insertVisits = visits.map((v) =>
    db.prepare("INSERT INTO visits (booking_id, date, slot, len, price) VALUES (?,?,?,?,?)")
      .bind(id, v.date, v.slot, v.len, v.price),
  );

  await db.batch([updateBooking, deleteVisits, ...insertVisits]);
  return json({ id });
}
