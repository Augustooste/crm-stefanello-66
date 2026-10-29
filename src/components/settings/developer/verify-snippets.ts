// Cópia dos trechos de supabase/functions/_shared/webhooks/docs-snippets.ts (código Deno não entra no bundle web).
// verify-snippets.test.ts garante paridade textual com o original.
export const NODE_VERIFY_SNIPPET = String.raw`const crypto = require("node:crypto");

// header: valor de X-Aceleraflow-Signature; rawBody: corpo EXATO recebido (string, sem re-serializar).
function verifyAceleraflowSignature(secret, header, rawBody, toleranceSeconds = 300, nowMs = Date.now()) {
  let t = null;
  const signatures = [];
  for (const part of String(header).split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (t === null || signatures.length === 0) return false;
  if (!(Math.abs(nowMs / 1000 - t) <= toleranceSeconds)) return false;
  const expected = Buffer.from(
    crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest("hex"),
  );
  let ok = false;
  for (const candidate of signatures) {
    const received = Buffer.from(candidate);
    if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) ok = true;
  }
  return ok;
}

module.exports = { verifyAceleraflowSignature };
`;

export const PYTHON_VERIFY_SNIPPET = String.raw`import hashlib
import hmac
import time


def verify_aceleraflow_signature(secret, header, raw_body, tolerance_seconds=300, now=None):
    """header: valor de X-Aceleraflow-Signature; raw_body: corpo EXATO recebido (str ou bytes)."""
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    t = None
    signatures = []
    for part in str(header).split(","):
        key, sep, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if not sep:
            continue
        if key == "t" and value.isascii() and value.isdigit():
            t = int(value)
        elif key == "v1" and value:
            signatures.append(value)
    if t is None or not signatures:
        return False
    current = time.time() if now is None else now
    if abs(current - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + body, hashlib.sha256).hexdigest()
    ok = False
    for candidate in signatures:
        if hmac.compare_digest(candidate.encode(), expected.encode()):
            ok = True
    return ok
`;
