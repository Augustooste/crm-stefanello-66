// Export/Import das preferências de visualização como JSON. Nunca inclui
// segredos — só as chaves conhecidas do registry.
import { z } from "zod";

import type { ViewPrefsMap } from "@/lib/api/view-prefs";
import { listPages } from "@/lib/view-prefs/registry";

const CURRENT_VERSION = 1;

const payloadSchema = z.object({
  version: z.literal(CURRENT_VERSION),
  exportedAt: z.string(),
  prefs: z.record(z.string(), z.record(z.string(), z.boolean())),
});

export type ExportPayload = z.infer<typeof payloadSchema>;

export function buildExportPayload(prefs: ViewPrefsMap): ExportPayload {
  return {
    version: CURRENT_VERSION,
    exportedAt: new Date().toISOString(),
    prefs,
  };
}

export function downloadPrefsJson(prefs: ViewPrefsMap, tenantSlug: string) {
  const payload = buildExportPayload(prefs);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `aceleraflow-view-prefs-${tenantSlug}-${today}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Valida e normaliza um JSON importado. Chaves desconhecidas (páginas ou
 * widgets que não existem no registry atual) são descartadas — não copiamos
 * cegamente.
 */
export function parseImportedPrefs(raw: unknown): ViewPrefsMap {
  const parsed = payloadSchema.parse(raw);
  const known = new Map<string, Set<string>>();
  for (const p of listPages()) {
    known.set(p.key, new Set(p.widgets.map((w) => w.key)));
  }
  const out: ViewPrefsMap = {};
  for (const [pageKey, widgets] of Object.entries(parsed.prefs)) {
    const validKeys = known.get(pageKey);
    if (!validKeys) continue;
    const filtered: Record<string, boolean> = {};
    for (const [wKey, val] of Object.entries(widgets)) {
      if (validKeys.has(wKey)) filtered[wKey] = val;
    }
    if (Object.keys(filtered).length > 0) out[pageKey] = filtered;
  }
  return out;
}

export async function readFileAsJson(file: File): Promise<unknown> {
  const text = await file.text();
  return JSON.parse(text);
}
