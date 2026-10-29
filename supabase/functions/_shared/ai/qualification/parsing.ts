// qualification/parsing.ts — parsing manual + validação da resposta do LLM.
//
// Extraído de qualification.ts (split de simplificação): sem Zod/structured
// output (o gateway Lovable não garante response_format=json_schema para
// todo modelo por trás dele) — ver banner de qualification.ts para o
// racional completo do porte do medflow.

import type { QualificationDimensionConfig } from "./context.ts";
import { stripJsonFence, toStringArray } from "../gateway.ts";

const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const VALID_ALERT_TYPES = new Set(["warning", "opportunity", "risk"]);

export interface QualificationDimensionResult {
  key: string;
  status: string;
  notes: string;
}

export interface PendingPoint {
  point: string;
  context: string;
  priority: "high" | "medium" | "low";
}

export interface QualificationAlert {
  type: "warning" | "opportunity" | "risk";
  message: string;
}

export interface RecommendedApproach {
  opening: string;
  keyQuestions: string[];
  objectionsToAnticipate: string[];
  suggestedNextStep: string;
}

export interface QualificationPayload {
  executiveSummary: string;
  dimensions: QualificationDimensionResult[];
  pendingPoints: PendingPoint[];
  recommendedApproach: RecommendedApproach;
  alerts: QualificationAlert[];
  confidence: number;
}

export function parseQualificationPayload(
  raw: string,
  dimensions: QualificationDimensionConfig[],
): QualificationPayload | null {
  const cleaned = stripJsonFence(raw);
  if (!cleaned) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  const executiveSummary = typeof o.executiveSummary === "string" ? o.executiveSummary.trim() : "";
  if (!executiveSummary) return null;

  const recommendedApproach = parseRecommendedApproach(o.recommendedApproach);
  if (!recommendedApproach) return null;

  return {
    executiveSummary,
    dimensions: alignDimensions(o.dimensions, dimensions),
    pendingPoints: parsePendingPoints(o.pendingPoints),
    recommendedApproach,
    alerts: parseAlerts(o.alerts),
    confidence: clampConfidence(o.confidence),
  };
}

/** Reconstrói o array de dimensões a partir da CONFIGURAÇÃO (não da resposta
 * da IA): garante exatamente uma entrada por chave configurada, mesmo se a
 * IA omitiu, duplicou ou inventou chaves. */
function alignDimensions(
  raw: unknown,
  configured: QualificationDimensionConfig[],
): QualificationDimensionResult[] {
  const byKey = new Map<string, { status: string; notes: string }>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.key !== "string" || !o.key.trim()) continue;
      byKey.set(o.key.trim(), {
        status: typeof o.status === "string" && o.status.trim() ? o.status.trim() : "desconhecido",
        notes: typeof o.notes === "string" ? o.notes.trim() : "",
      });
    }
  }

  return configured.map((dim) => {
    const found = byKey.get(dim.key);
    return {
      key: dim.key,
      status: found?.status ?? "desconhecido",
      notes: found?.notes || "Nenhuma informação disponível.",
    };
  });
}

function parsePendingPoints(raw: unknown): PendingPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPoint[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const point = typeof o.point === "string" ? o.point.trim() : "";
    if (!point) continue;
    const priority =
      typeof o.priority === "string" && VALID_PRIORITIES.has(o.priority) ? o.priority : "medium";
    out.push({
      point,
      context: typeof o.context === "string" ? o.context.trim() : "",
      priority: priority as PendingPoint["priority"],
    });
  }
  return out;
}

function parseAlerts(raw: unknown): QualificationAlert[] {
  if (!Array.isArray(raw)) return [];
  const out: QualificationAlert[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const message = typeof o.message === "string" ? o.message.trim() : "";
    if (!message) continue;
    const type = typeof o.type === "string" && VALID_ALERT_TYPES.has(o.type) ? o.type : "warning";
    out.push({ type: type as QualificationAlert["type"], message });
  }
  return out;
}

function parseRecommendedApproach(raw: unknown): RecommendedApproach | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const opening = typeof o.opening === "string" ? o.opening.trim() : "";
  const suggestedNextStep =
    typeof o.suggestedNextStep === "string" ? o.suggestedNextStep.trim() : "";
  if (!opening || !suggestedNextStep) return null;

  return {
    opening,
    keyQuestions: toStringArray(o.keyQuestions),
    objectionsToAnticipate: toStringArray(o.objectionsToAnticipate),
    suggestedNextStep,
  };
}

function clampConfidence(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0.3;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}
