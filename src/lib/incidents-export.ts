// incidents-export.ts — serialização de incidentes para CSV e JSON e download
// no navegador. Sem servidor: os dados já vieram redigidos do banco.

import type { Incident } from "@/lib/api/incidents";

export const INCIDENT_CSV_COLUMNS = [
  "tipo",
  "data_hora",
  "trace_id",
  "escopo",
  "codigo",
  "mensagem",
  "provedor",
  "modelo",
  "status_http",
] as const;

/**
 * Escapa um valor de célula CSV: aspas duplicadas, campo entre aspas quando
 * houver separador/quebra, e prefixo apóstrofo em texto que uma planilha
 * interpretaria como fórmula (=, +, -, @).
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/["\n\r,;]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

function csvRow(incident: Incident): unknown[] {
  return [
    incident.kind === "falha_ia" ? "Falha de IA" : "Erro do app",
    incident.occurredAt,
    incident.traceId ?? "",
    incident.scope,
    incident.code ?? "",
    incident.message,
    incident.provider ?? "",
    incident.model ?? "",
    incident.statusCode ?? "",
  ];
}

export function incidentsToCsv(incidents: Incident[]): string {
  const lines = [INCIDENT_CSV_COLUMNS.join(",")];
  for (const incident of incidents) {
    lines.push(csvRow(incident).map(escapeCsvValue).join(","));
  }
  return lines.join("\r\n");
}

export function incidentsToJson(incidents: Incident[]): string {
  return JSON.stringify(incidents, null, 2);
}

export function incidentsFileName(format: "csv" | "json", now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  return `incidentes-${stamp}.${format}`;
}

/** Dispara o download no navegador. No-op fora do browser (SSR/teste sem DOM). */
export function downloadIncidents(incidents: Incident[], format: "csv" | "json"): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const content = format === "csv" ? incidentsToCsv(incidents) : incidentsToJson(incidents);
  const blob = new Blob([content], {
    type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = incidentsFileName(format);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}
