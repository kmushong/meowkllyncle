// Middleware applied to ALL routes under /functions/ (i.e. all /api/* paths).
// Only requests to /api/admin/** are gated; everything else passes straight through.

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Only protect admin API routes.
  if (!url.pathname.startsWith("/api/admin/")) return next();

  const adminPassword = env.ADMIN_PASSWORD || "";
  if (!adminPassword) {
    return new Response("Admin is disabled: ADMIN_PASSWORD is not set.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // --- Rate-limit brute-force via a simple in-memory map (per isolate) ---
  // This is best-effort: Cloudflare may start a fresh isolate at any time.
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "?";

  const now  = Date.now();
  const lock = failStore.get(ip);
  if (lock && lock.n >= 10 && now - lock.t < 15 * 60 * 1000) {
    return new Response("Too many failed attempts. Try again in 15 minutes.", {
      status: 429,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // --- HTTP Basic auth ---
  const authHeader = request.headers.get("authorization") || "";
  let authed = false;
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const colon   = decoded.indexOf(":");
      const user    = colon === -1 ? decoded : decoded.slice(0, colon);
      const pass    = colon === -1 ? ""       : decoded.slice(colon + 1);
      if (user === "admin") {
        // Timing-safe comparison via SubtleCrypto.
        const enc  = new TextEncoder();
        const aKey = await crypto.subtle.importKey("raw", enc.encode(pass),          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const bKey = await crypto.subtle.importKey("raw", enc.encode(adminPassword), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const msg  = enc.encode("compare");
        const [aSig, bSig] = await Promise.all([
          crypto.subtle.sign("HMAC", aKey, msg),
          crypto.subtle.sign("HMAC", bKey, msg),
        ]);
        // Compare byte-by-byte (constant time within JS limits).
        const aBytes = new Uint8Array(aSig);
        const bBytes = new Uint8Array(bSig);
        let diff = 0;
        for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
        authed = diff === 0;
      }
    } catch { /* malformed base64 — treat as denied */ }
  }

  if (authed) {
    failStore.delete(ip);
    return next();
  }

  // Record failed attempt.
  if (authHeader) {
    const prev = failStore.get(ip);
    failStore.set(ip, {
      n: (prev && now - prev.t < 15 * 60 * 1000 ? prev.n : 0) + 1,
      t: now,
    });
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Kelly admin"',
      "Cache-Control": "no-store",
    },
  });
}

// Module-level store: lives as long as the isolate does.
const failStore = new Map();
