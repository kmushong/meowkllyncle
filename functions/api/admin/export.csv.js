// GET /api/admin/export.csv  — download all bookings as CSV (admin only)
import { run, todayLocal } from "../../_shared.js";

function csvCell(v) {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}

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

  const head = ["Booking", "Submitted (UTC)", "Status", "Name", "Contact", "Address", "Area", "Cats",
                 "Visit date", "Slot", "Minutes", "Price", "Booking total", "Medication", "Notes"];
  const lines = [head.map(csvCell).join(",")];

  for (const b of rows) {
    const bVisits = visits
      .filter((v) => Number(v.booking_id) === Number(b.id))
      .map((v) => ({ ...v, price: Number(v.price) }));
    for (const v of bVisits) {
      lines.push([
        b.id, b.created_at, b.status, b.name, b.contact, b.address, b.area, b.cats,
        v.date, v.slot, v.len, v.price, b.total, b.meds, b.notes,
      ].map(csvCell).join(","));
    }
  }

  const csv = "\ufeff" + lines.join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bookings-${todayLocal()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
