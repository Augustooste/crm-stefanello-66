import { readCapped } from "../_shared/http/read-capped.ts";
import { apiError } from "./errors.ts";
import type { Row } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;

/** Lê o corpo JSON com teto de 64 KB (Content-Length e tamanho realmente lido). */
export async function readJsonObject(req: Request, requestId: string): Promise<Row | Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  const tooLarge = () => apiError("payload_too_large", "Corpo acima de 64 KB.", requestId);
  if (declared > MAX_BODY_BYTES) return tooLarge();
  const bytes = await readCapped(req.body, MAX_BODY_BYTES);
  if (bytes === null) return tooLarge();
  let parsed: unknown;
  try {
    parsed = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    return apiError("validation_error", "Corpo JSON inválido.", requestId);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return apiError("validation_error", "Corpo JSON inválido.", requestId);
  }
  return parsed as Row;
}
