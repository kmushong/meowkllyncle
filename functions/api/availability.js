// GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
import { validDate, fullSlots, getCapacity, json, err } from "../_shared.js";

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  if (!validDate(from) || !validDate(to)) return err("Bad range.");
  const db = env.DB;
  return json({ capacity: await getCapacity(db), full: await fullSlots(db, from, to) });
}
