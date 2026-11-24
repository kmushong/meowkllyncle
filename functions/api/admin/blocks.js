// GET  /api/admin/blocks  — list upcoming blocks
// POST /api/admin/blocks  — add a block
import { run, exec, validDate, todayLocal, json, err, SLOTS, str } from "../../_shared.js";

export async function onRequestGet({ env }) {
  const db = env.DB;
  const blocks = await run(
    db,
    "SELECT id, date, slot, reason FROM blocks WHERE date >= ? ORDER BY date, slot",
    [todayLocal()],
  );
  return json({ blocks: blocks.map((b) => ({ ...b, id: Number(b.id) })) });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return err("Bad request."); }

  const slot = body.slot ? String(body.slot) : "";
  if (!validDate(body.date) || (slot && !SLOTS.includes(slot)))
    return err("Bad date or slot.");

  const db = env.DB;
  await exec(
    db,
    "INSERT OR IGNORE INTO blocks (date, slot, reason) VALUES (?,?,?)",
    [body.date, slot, str(body.reason, 120)],
  );
  return json({ ok: true }, 201);
}
