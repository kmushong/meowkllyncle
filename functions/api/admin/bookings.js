// GET /api/admin/bookings  — list all bookings (admin only, auth handled by middleware)
import { run, getCapacity, json } from "../../_shared.js";

export async function onRequestGet({ env }) {
  const db = env.DB;
  const rows = await run(db, "SELECT * FROM bookings ORDER BY id DESC LIMIT 500");
  let visits = [];
  if (rows.length) {
    const placeholders = rows.map(() => "?").join(",");
    visits = await run(
      db,
      `SELECT booking_id, date, slot, len, price FROM visits WHERE booking_id IN (${placeholders}) ORDER BY date, slot`,
      rows.map((r) => r.id),
    );
  }
  const bookings = rows.map((b) => ({
    ...b,
    id:    Number(b.id),
    total: Number(b.total),
    visits: visits
      .filter((v) => Number(v.booking_id) === Number(b.id))
      .map((v) => ({ date: v.date, slot: v.slot, len: v.len, price: Number(v.price) })),
  }));
  return json({ capacity: await getCapacity(db), bookings });
}
