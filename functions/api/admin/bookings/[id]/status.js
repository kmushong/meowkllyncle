// POST /api/admin/bookings/:id/status  — change booking status (admin only)
import {
  one, visitsFor, getCapacity, slotCount, isBlocked, exec, json, err, STATUSES,
} from "../../../../_shared.js";

export async function onRequestPost({ params, request, env }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return err("Not found.", 404);

  let body;
  try { body = await request.json(); }
  catch { return err("Bad request."); }

  const { status } = body;
  if (!STATUSES.includes(status)) return err("Bad status.");

  const db = env.DB;
  const existing = await one(db, "SELECT status FROM bookings WHERE id = ?", [id]);
  if (!existing) return err("Not found.", 404);

  const reactivating =
    (status === "pending" || status === "confirmed") &&
    !["pending", "confirmed"].includes(existing.status);

  if (reactivating) {
    const cap = await getCapacity(db);
    for (const v of await visitsFor(db, id)) {
      if (
        (await isBlocked(db, v.date, v.slot)) ||
        (await slotCount(db, v.date, v.slot, id)) >= cap
      ) {
        return err(v.date + " " + v.slot + " is already full or blocked.", 409);
      }
    }
  }

  await exec(db, "UPDATE bookings SET status = ? WHERE id = ?", [status, id]);
  return json({ id, status });
}
