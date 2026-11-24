// DELETE /api/admin/blocks/:id  — remove a block (admin only)
import { exec, json, err } from "../../../_shared.js";

export async function onRequestDelete({ params, env }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return err("Not found.", 404);
  await exec(env.DB, "DELETE FROM blocks WHERE id = ?", [id]);
  return json({ ok: true });
}
