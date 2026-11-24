// GET  /api/admin/settings  — read capacity + notify config
// POST /api/admin/settings  — update capacity
import { getCapacity, exec, json, err } from "../../_shared.js";

export async function onRequestGet({ env }) {
  const db = env.DB;
  return json({
    capacity: await getCapacity(db),
    notify: {
      push:    !!env.NTFY_TOPIC,
      email:   !!(env.NTFY_TOPIC && env.NOTIFY_EMAIL),
      webhook: !!env.NOTIFY_WEBHOOK_URL,
    },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return err("Bad request."); }

  const n = Number(body.capacity);
  if (!Number.isInteger(n) || n < 1 || n > 20)
    return err("Capacity must be a whole number from 1 to 20.");

  await exec(
    env.DB,
    "INSERT INTO settings (key, value) VALUES ('capacity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(n)],
  );
  return json({ capacity: n });
}
