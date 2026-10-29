// Brand Extract — recebe a URL do site do cliente, busca o HTML público e
// devolve uma proposta de cor de marca (primary/accent) + dados básicos da
// empresa para pré-preencher o wizard. Admins only. Nada é gravado aqui —
// o cliente vê o preview e confirma no StepEmpresa.
//
// Segurança: anti-SSRF (só http/https, bloqueia IPs privados/link-local após
// resolução DNS, redirects revalidados), timeout e teto de download.
// Guardrails de cor: hex válido, contraste WCAG calculado no servidor;
// o cliente só aplica em --primary/--accent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { getAIGatewayConfig, type AIGatewayConfig } from "../_shared/ai/gateway.ts";
import {
  buildBusinessPrompt,
  consolidateBusiness,
  countFilledFields,
  discoverInternalLinks,
  extractJsonLdNodes,
  extractVisibleText,
  factsFromJsonLd,
  MAX_INTERNAL_PAGES,
  parseAiBusiness,
  type ExtractedBusiness,
} from "./business.ts";

// Audit #5: CORS por allowlist em vez de "*". Reflete o Origin só se for domínio
// do app (*.lovable.app, localhost) ou constar em ALLOWED_ORIGINS (env, p/ domínio
// custom do tenant). Origin fora da lista → "null" (browser bloqueia).
// ponytail: allowlist por sufixo/env; domínio custom precisa entrar em ALLOWED_ORIGINS.
function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let allowed = false;
  if (origin) {
    if (extra.includes(origin)) allowed = true;
    else {
      try {
        const host = new URL(origin).hostname;
        allowed =
          host.endsWith(".lovable.app") ||
          host.endsWith(".lovableproject.com") ||
          host.endsWith(".sandbox.lovable.dev") ||
          host === "localhost" ||
          host === "127.0.0.1";
      } catch {
        allowed = false;
      }
    }
  }
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const AI_MODEL = "google/gemini-3-flash-preview";
// Prompt curto (cores + título); só classifica uma paleta.
const AI_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 600_000;
const MAX_ASSET_BYTES = 150_000;
const MAX_VISUAL_ASSETS = 8;
const MAX_REDIRECTS = 3;
const FUNCTION_REVISION = "brand-extract-2026-08-11-r8";
// Versão do formato público da resposta. Diferente da revisão de implantação:
// revisões novas continuam compatíveis enquanto este número não mudar.
const CONTRACT_VERSION = 1;
// Fundo do produto (dark premium) — cor extraída precisa funcionar sobre ele.
const APP_BG = "#0a0f1a";
const DARK_TEXT = "#05152b";

// ─── Anti-SSRF ────────────────────────────────────────────────────────────

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const low = ip.toLowerCase();
  return (
    low === "::" ||
    low === "::1" ||
    low.startsWith("fc") ||
    low.startsWith("fd") ||
    low.startsWith("fe8") ||
    low.startsWith("fe9") ||
    low.startsWith("fea") ||
    low.startsWith("feb") ||
    low.startsWith("::ffff:")
  );
}

async function resolvePublicHost(url: URL): Promise<string> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL precisa ser http(s).");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Endereço não permitido.");
  }
  // IP literal direto
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIpv4(host)) throw new Error("Endereço não permitido.");
    return host;
  }
  if (host.includes(":")) {
    if (isPrivateIpv6(host)) throw new Error("Endereço não permitido.");
    return host;
  }
  // Nome de domínio: resolve e valida todos os IPs.
  let resolved: string[] = [];
  try {
    const [a, aaaa] = await Promise.allSettled([
      Deno.resolveDns(host, "A"),
      Deno.resolveDns(host, "AAAA"),
    ]);
    if (a.status === "fulfilled") resolved = resolved.concat(a.value);
    if (aaaa.status === "fulfilled") resolved = resolved.concat(aaaa.value);
  } catch {
    throw new Error("Não foi possível resolver o domínio.");
  }
  if (resolved.length === 0) throw new Error("Não foi possível resolver o domínio.");
  for (const ip of resolved) {
    if (ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip)) {
      throw new Error("Endereço não permitido.");
    }
  }
  return resolved[0];
}

/** Log estruturado desta função — sempre com prefixo pra filtrar no painel. */
function logStep(
  step: string,
  requestId: string,
  detail: Record<string, unknown> = {},
): void {
  console.log(
    `[brand-extract] ${step} ${JSON.stringify({ revision: FUNCTION_REVISION, request_id: requestId, ...detail })}`,
  );
}

function resolveHttpUrl(value: string, baseUrl: string): string {
  const target = value.trim();
  if (!target) throw new Error("URL sem destino.");

  // Não usamos `new URL(target, baseUrl)` aqui. A versão do runtime que
  // atende alguns remixes já lançou "relative URL without a base" nesse
  // overload, embora navegadores e os testes locais o aceitem. Resolver os
  // formatos relativos explicitamente deixa o comportamento independente
  // dessa diferença de runtime.
  let current: URL;
  try {
    current = new URL(baseUrl);
  } catch {
    throw new Error("URL-base inválida.");
  }

  let absolute: string;
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^https?:\/\//i.test(target)) {
    throw new Error("URL com protocolo não permitido.");
  }
  if (/^https?:\/\//i.test(target)) absolute = target;
  else if (target.startsWith("//")) absolute = `${current.protocol}${target}`;
  else if (target.startsWith("/")) absolute = `${current.origin}${target}`;
  else if (target.startsWith("?")) absolute = `${current.origin}${current.pathname}${target}`;
  else if (target.startsWith("#")) absolute = `${current.origin}${current.pathname}${current.search}${target}`;
  else {
    const basePath = current.pathname.endsWith("/")
      ? current.pathname
      : current.pathname.slice(0, current.pathname.lastIndexOf("/") + 1);
    absolute = `${current.origin}${basePath}${target}`;
  }

  let next: URL;
  try {
    next = new URL(absolute);
  } catch {
    throw new Error("URL de destino inválida.");
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") {
    throw new Error("URL com protocolo não permitido.");
  }
  return next.href;
}

function resolveRedirectUrl(location: string, currentUrl: string): string {
  if (!location.trim()) throw new Error("Redirect sem destino.");
  return resolveHttpUrl(location, currentUrl);
}

async function fetchPublicHtml(
  rawUrl: string,
  requestId: string,
): Promise<{ html: string; finalUrl: string; hops: string[] }> {
  let currentUrl = new URL(rawUrl).href;
  const hops: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Valida host/IP antes de cada hop (inclusive depois de redirect).
    // Não fixamos a conexão no IP resolvido: sites atrás de CDN precisam da
    // negociação TLS/SNI pelo nome do domínio, e o pinning por proxy TCP
    // derrubava toda extração nesses casos.
    const url = new URL(currentUrl);
    hops.push(currentUrl);
    logStep("hop", requestId, { hop, url: currentUrl });
    await resolvePublicHost(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(currentUrl, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "User-Agent": "AceleraFlow-BrandExtract/1.0", Accept: "text/html" },
      });
      logStep("resposta", requestId, {
        hop,
        status: res.status,
        content_type: res.headers.get("content-type"),
        location: res.headers.get("location"),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new Error("Redirect sem destino.");
        currentUrl = resolveRedirectUrl(loc, currentUrl);
        continue;
      }
      if (!res.ok) throw new Error(`Site respondeu ${res.status}.`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) throw new Error("A URL não é uma página HTML.");
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Resposta vazia.");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      await reader.cancel().catch(() => {});
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c.subarray(0, Math.min(c.byteLength, total - off)), off);
        off += c.byteLength;
        if (off >= total) break;
      }
      logStep("html_lido", requestId, { hop, bytes: total, url: currentUrl });
      return {
        html: new TextDecoder("utf-8", { fatal: false }).decode(buf),
        finalUrl: currentUrl,
        hops,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Redirects demais.");
}

// ─── Extração de candidatos ───────────────────────────────────────────────

/** Papel visual do asset — é isso que a tela de diagnóstico mostra ao usuário. */
type VisualRole = "favicon" | "logo" | "og:image" | "twitter:image" | "stylesheet" | "manifest";

type VisualAsset = {
  kind: "css" | "icon" | "image" | "manifest";
  role: VisualRole;
  rawUrl: string;
  url: string;
};


function tagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/g)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3];
    if (name && value !== undefined) attrs[name] = value.trim();
  }
  return attrs;
}

function effectiveDocumentBase(html: string, finalUrl: string): string {
  const baseTag = html.slice(0, 200_000).match(/<base\b[^>]*>/i)?.[0];
  if (!baseTag) return finalUrl;
  const href = tagAttributes(baseTag).href;
  if (!href) return finalUrl;
  try {
    return resolveHttpUrl(href, finalUrl);
  } catch {
    return finalUrl;
  }
}

function extractVisualAssets(html: string, finalUrl: string): { baseUrl: string; assets: VisualAsset[] } {
  const head = html.slice(0, 200_000);
  const baseUrl = effectiveDocumentBase(head, finalUrl);
  const candidates: Array<{ kind: VisualAsset["kind"]; role: VisualRole; rawUrl: string }> = [];

  for (const tag of head.matchAll(/<(?:link|meta)\b[^>]*>/gi)) {
    const attrs = tagAttributes(tag[0]);
    const rel = (attrs.rel ?? "").toLowerCase();
    const property = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (attrs.href && rel.split(/\s+/).some((part) => part === "stylesheet")) {
      candidates.push({ kind: "css", role: "stylesheet", rawUrl: attrs.href });
    } else if (attrs.href && rel.split(/\s+/).some((part) => part.includes("icon"))) {
      candidates.push({ kind: "icon", role: "favicon", rawUrl: attrs.href });
    } else if (attrs.href && rel.split(/\s+/).includes("manifest")) {
      candidates.push({ kind: "manifest", role: "manifest", rawUrl: attrs.href });
    } else if (attrs.content && ["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes(property)) {
      candidates.push({
        kind: "image",
        role: property.startsWith("twitter") ? "twitter:image" : "og:image",
        rawUrl: attrs.content,
      });
    }
  }

  for (const tag of html.slice(0, 400_000).matchAll(/<img\b[^>]*>/gi)) {
    const attrs = tagAttributes(tag[0]);
    const hint = `${attrs.id ?? ""} ${attrs.class ?? ""} ${attrs.alt ?? ""}`.toLowerCase();
    if (attrs.src && /logo|brand|marca/.test(hint)) {
      candidates.push({ kind: "image", role: "logo", rawUrl: attrs.src });
    }
  }

  const assets: VisualAsset[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (assets.length >= MAX_VISUAL_ASSETS) break;

    const raw = candidate.rawUrl.trim();
    if (!raw || raw.startsWith("#") || /^(?:data|blob|javascript):/i.test(raw)) continue;
    try {
      const url = resolveHttpUrl(raw, baseUrl);
      if (seen.has(url)) continue;
      seen.add(url);
      assets.push({ ...candidate, rawUrl: raw, url });
    } catch {
      // Candidato inválido não invalida a página inteira.
    }
  }
  return { baseUrl, assets };
}

async function fetchVisualAsset(asset: VisualAsset, requestId: string): Promise<string> {
  let currentUrl = asset.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    await resolvePublicHost(parsed);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "AceleraFlow-BrandExtract/1.0",
          Accept: "text/css,image/svg+xml,application/manifest+json,application/json,image/*;q=0.8,*/*;q=0.5",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Redirect de asset sem destino.");
        currentUrl = resolveRedirectUrl(location, currentUrl);
        continue;
      }
      if (!response.ok) throw new Error(`Asset respondeu ${response.status}.`);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const textual = contentType.includes("text/css") || contentType.includes("svg") || contentType.includes("json");
      if (!textual) {
        await response.body?.cancel();
        logStep("asset_lido", requestId, { kind: asset.kind, url: currentUrl, content_type: contentType, textual: false });
        return "";
      }
      const reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_ASSET_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = MAX_ASSET_BYTES - total;
        const chunk = value.subarray(0, remaining);
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      await reader.cancel().catch(() => {});
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      logStep("asset_lido", requestId, { kind: asset.kind, url: currentUrl, content_type: contentType, bytes: total, textual: true });
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Redirects demais no asset.");
}

function attr(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m?.[1]?.trim() || null;
}

function extractCandidates(html: string) {
  const head = html.slice(0, 200_000);
  const themeColor =
    attr(head, /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i) ??
    attr(head, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i);
  const title =
    attr(head, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ??
    attr(head, /<title[^>]*>([^<]{1,120})/i);
  const description =
    attr(head, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
    attr(head, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const canonical =
    attr(head, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ??
    attr(head, /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);

  // Frequência de hex em <style>/style= — top cores saturadas.
  const freq = new Map<string, number>();
  for (const m of html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = normalizeHex(`#${m[1]}`);
    if (!hex) continue;
    freq.set(hex, (freq.get(hex) ?? 0) + 1);
  }
  const top = [...freq.entries()]
    .filter(([hex]) => {
      const { s, l } = hexToHsl(hex);
      return s > 0.25 && l > 0.12 && l < 0.9; // descarta cinzas/preto/branco
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([hex, n]) => ({ hex, n }));

  return {
    themeColor: themeColor ? normalizeHex(themeColor) : null,
    title,
    description,
    canonical,
    top,
  };
}

// ─── Cor: utilitários ─────────────────────────────────────────────────────

function normalizeHex(input: string): string | null {
  const m = input.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  return `#${h}`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mistura a cor com branco (t 0..1) — usada pra derivar o accent legível no dark. */
function lighten(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

/**
 * Aplica os guardrails WCAG: clareia a cor até ter contraste mínimo com o
 * fundo do app e calcula o foreground do botão (branco vs escuro, AA 4.5).
 */
function buildPalette(rawHex: string) {
  let primary = rawHex;
  for (let i = 0; i < 8 && contrast(primary, APP_BG) < 2.2; i++) {
    primary = lighten(primary, 0.12);
  }
  const primaryForeground = contrast(primary, "#ffffff") >= 4.5 ? "#ffffff" : DARK_TEXT;
  let accentForeground = primary;
  for (let i = 0; i < 8 && contrast(accentForeground, APP_BG) < 4.5; i++) {
    accentForeground = lighten(accentForeground, 0.15);
  }
  return { primary, primary_foreground: primaryForeground, accent_foreground: accentForeground };
}

// ─── IA: escolha da cor de marca ──────────────────────────────────────────

async function pickWithAi(
  gateway: AIGatewayConfig,
  input: {
    themeColor: string | null;
    title: string | null;
    description: string | null;
    top: Array<{ hex: string; n: number }>;
  },
): Promise<{ hex: string | null; segment: string | null }> {
  const prompt = [
    "Você ajuda a identificar a cor de marca de um site a partir de candidatos extraídos do HTML.",
    "Escolha a cor que mais parece ser a cor PRINCIPAL da marca (não fundo, não texto).",
    "Também sugira em 2-4 palavras o segmento do negócio em pt-BR (ex.: 'clínica odontológica'), ou null se não der pra inferir.",
    'Responda SOMENTE JSON: {"hex":"#rrggbb ou null","segment":"texto ou null"}',
    "",
    `theme-color: ${input.themeColor ?? "nenhum"}`,
    `título: ${input.title ?? "nenhum"}`,
    `descrição: ${input.description ?? "nenhuma"}`,
    `cores mais frequentes (hex: ocorrências): ${input.top.map((t) => `${t.hex}: ${t.n}`).join(", ") || "nenhuma"}`,
  ].join("\n");
  const r = await fetch(gateway.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.apiKey}` },
    body: JSON.stringify({
      model: gateway.model || AI_MODEL,
      reasoning_effort: gateway.reasoningEffort,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!r.ok) return { hex: null, segment: null };
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = (data.choices?.[0]?.message?.content ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    const parsed = JSON.parse(raw) as { hex?: unknown; segment?: unknown };
    const hex = typeof parsed.hex === "string" ? normalizeHex(parsed.hex) : null;
    const segment =
      typeof parsed.segment === "string" && parsed.segment.trim().length > 0
        ? parsed.segment.trim().slice(0, 80)
        : null;
    return { hex, segment };
  } catch {
    return { hex: null, segment: null };
  }
}

// ─── IA: dados empresariais ───────────────────────────────────────────────

/**
 * Complemento por IA sobre o conteúdo já baixado. Falha, timeout ou resposta
 * fora do formato devolvem `null`: os campos determinísticos continuam valendo.
 */
async function extractBusinessWithAi(
  gateway: AIGatewayConfig,
  prompt: string,
): Promise<ReturnType<typeof parseAiBusiness> | null> {
  const r = await fetch(gateway.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.apiKey}` },
    body: JSON.stringify({
      model: gateway.model || AI_MODEL,
      reasoning_effort: gateway.reasoningEffort,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? "";
  if (!raw.trim()) return null;
  return parseAiBusiness(raw);
}


// ─── Handler ──────────────────────────────────────────────────────────────

// ─── Diagnóstico ──────────────────────────────────────────────────────────
// A tela de onboarding precisa mostrar o que foi encontrado e onde parou.
// Por isso o diagnóstico acompanha TODAS as respostas (200 e 422), não só o
// sucesso: é exatamente no erro que ele importa.

type DiagnosticStepStatus = "ok" | "falhou" | "pulado";
type DiagnosticStep = { id: string; label: string; status: DiagnosticStepStatus; detail: string | null };
type DiagnosticAssetStatus = "lido" | "ignorado" | "nao_encontrado";
type DiagnosticAsset = {
  role: VisualRole;
  kind: VisualAsset["kind"] | null;
  url: string | null;
  status: DiagnosticAssetStatus;
  reason: string | null;
};

const DIAGNOSTIC_STEPS: Array<{ id: string; label: string }> = [
  { id: "acesso_site", label: "Acesso ao site" },
  { id: "leitura_html", label: "Leitura do HTML" },
  { id: "coleta_assets", label: "Coleta de assets visuais" },
  { id: "escolha_cor", label: "Escolha da cor de marca" },
  { id: "dados_empresa", label: "Dados da empresa" },
];
const REPORTED_ROLES: VisualRole[] = ["favicon", "logo", "og:image", "twitter:image"];

function createDiagnostics() {
  const steps: DiagnosticStep[] = DIAGNOSTIC_STEPS.map((s) => ({ ...s, status: "pulado", detail: null }));
  const assets: DiagnosticAsset[] = REPORTED_ROLES.map((role) => ({
    role,
    kind: null,
    url: null,
    status: "nao_encontrado",
    reason: null,
  }));
  return {
    snapshot: () => ({ steps: steps.map((s) => ({ ...s })), assets: assets.map((a) => ({ ...a })) }),
    step(id: string, status: DiagnosticStepStatus, detail: string | null = null) {
      const found = steps.find((s) => s.id === id);
      if (found) {
        found.status = status;
        found.detail = detail;
      }
    },
    found(asset: VisualAsset) {
      const entry = assets.find((a) => a.role === asset.role);
      if (!entry || entry.url) return;
      entry.kind = asset.kind;
      entry.url = asset.url;
      entry.status = "lido";
    },
    failed(asset: VisualAsset, reason: string) {
      const entry = assets.find((a) => a.role === asset.role && a.url === asset.url);
      if (!entry) return;
      entry.status = "ignorado";
      entry.reason = reason;
    },
  };
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const cors = buildCors(req);
  const diagnostics = createDiagnostics();
  const json = (status: number, body: unknown) =>
    new Response(
      JSON.stringify({
        ...(body as Record<string, unknown>),
         contract_version: CONTRACT_VERSION,
        revision: FUNCTION_REVISION,
        request_id: requestId,
        diagnostics: diagnostics.snapshot(),
      }),
      {
        status,
        headers: { ...cors, "content-type": "application/json" },
      },
    );

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  const prof = await loadProfileOrFail(admin, userData.user.id, {
    operation: "brand.extract.load_profile",
    requireAdmin: true,
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    if (prof.reason === "not_admin") return json(403, { error: "Apenas administradores." });
    return json(403, { error: "Perfil não encontrado." });
  }

  let rawUrl = "";
  try {
    const body = (await req.json()) as { url?: string };
    rawUrl = (body.url ?? "").trim();
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  if (!/^https?:\/\//i.test(rawUrl)) rawUrl = `https://${rawUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return json(400, { error: "URL inválida." });
  }

  logStep("inicio", requestId, { host: parsed.hostname, url: parsed.href, tenant_id: prof.tenantId });

  let html = "";
  let hops: string[] = [];
  let finalUrl = parsed.href;
  try {
    const res = await fetchPublicHtml(parsed.href, requestId);
    html = res.html;
    hops = res.hops;
    finalUrl = res.finalUrl;
    diagnostics.step("acesso_site", "ok", `${res.hops.length} requisição(ões) até ${res.finalUrl}`);
    diagnostics.step("leitura_html", "ok", `${html.length} caracteres lidos`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Não foi possível acessar o site.";
    // A causa real morria aqui: sem registro, todo problema de leitura virava
    // um 422 genérico e ninguém conseguia distinguir bloqueio anti-SSRF de
    // timeout, content-type inesperado ou falha de rede.
    logStep("falha_fetch", requestId, { host: parsed.hostname, motivo: msg });
    diagnostics.step("acesso_site", "falhou", msg);
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "brand.extract.fetch_site",
      tenantId: prof.tenantId,
      message: msg,
      stack: e instanceof Error ? (e.stack ?? null) : null,
      context: { host: parsed.hostname, request_id: requestId, revision: FUNCTION_REVISION },
    });
    return json(422, { error: `Não conseguimos ler o site: ${msg}` });
  }

  const visual = extractVisualAssets(html, finalUrl);
  for (const asset of visual.assets) diagnostics.found(asset);
  logStep("assets_encontrados", requestId, {
    base_url: visual.baseUrl,
    quantidade: visual.assets.length,
    tipos: visual.assets.map((asset) => asset.kind),
  });
  const assetTexts = (
    await Promise.all(
      visual.assets.map(async (asset) => {
        try {
          return await fetchVisualAsset(asset, requestId);
        } catch (e) {
          const motivo = e instanceof Error ? e.message : String(e);
          logStep("asset_ignorado", requestId, {
            kind: asset.kind,
            role: asset.role,
            url: asset.url,
            motivo,
          });
          diagnostics.failed(asset, motivo);
          return "";
        }
      }),
    )
  ).filter(Boolean);
  diagnostics.step("coleta_assets", "ok", `${visual.assets.length} asset(s) candidatos`);


  const candidates = extractCandidates(`${html}\n${assetTexts.join("\n")}`);
  logStep("candidatos", requestId, {
    hops: hops.length,
    theme_color: candidates.themeColor,
    tem_titulo: !!candidates.title,
    cores: candidates.top.length,
  });


  let hex: string | null = null;
  let segment: string | null = null;
  const gateway = getAIGatewayConfig();
  if (gateway.apiKey) {
    try {
      const ai = await pickWithAi(gateway, candidates);
      hex = ai.hex;
      segment = ai.segment;
    } catch (e) {
      // IA é opcional aqui — o fallback determinístico abaixo assume e a
      // resposta não muda. Mas "opcional" não pode significar "invisível":
      // se o gateway cair ou a LOVABLE_API_KEY for revogada, TODA extração
      // passa a usar o pick por frequência de hex e ninguém fica sabendo que
      // a escolha por IA parou de acontecer. Por isso `warn`, não `error`:
      // não é incidente (o usuário recebe uma cor válida), é degradação que
      // precisa ser contável.
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "brand.extract.ai_pick",
        tenantId: prof.tenantId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? null) : null,
        context: {
          candidatos: candidates.top.length,
          tem_theme_color: !!candidates.themeColor,
          request_id: requestId,
          revision: FUNCTION_REVISION,
        },
      });
    }
  }
  if (!hex) hex = candidates.themeColor ?? candidates.top[0]?.hex ?? null;
  if (!hex) {
    logStep("sem_cor", requestId, { host: parsed.hostname });
    diagnostics.step("escolha_cor", "falhou", "Nenhuma cor de marca identificada no HTML nem nos assets.");
    return json(422, {
      error: "Não encontramos uma cor de marca no site. Você pode definir manualmente depois.",
    });
  }
  diagnostics.step("escolha_cor", "ok", `Cor base ${hex}`);

  // ─── Dados empresariais ────────────────────────────────────────────────
  // Determinístico primeiro (JSON-LD + meta), IA só como complemento. Cada
  // etapa é isolada: falha vira "pulado" no diagnóstico, nunca erro de resposta.
  let business: ExtractedBusiness | null = null;
  try {
    const jsonLdNodes = extractJsonLdNodes(html);
    const jsonLdFacts = factsFromJsonLd(jsonLdNodes);
    const homeText = extractVisibleText(html);

    const internalPages: Array<{ url: string; text: string }> = [];
    let internalLinks: string[] = [];
    try {
      internalLinks = discoverInternalLinks(html, finalUrl, resolveHttpUrl, MAX_INTERNAL_PAGES);
    } catch {
      internalLinks = [];
    }
    for (const link of internalLinks) {
      try {
        const page = await fetchPublicHtml(link, requestId);
        internalPages.push({ url: page.finalUrl, text: extractVisibleText(page.html, 4000) });
      } catch (e) {
        logStep("pagina_interna_ignorada", requestId, {
          url: link,
          motivo: e instanceof Error ? e.message : String(e),
        });
      }
    }

    let ai: ReturnType<typeof parseAiBusiness> | null = null;
    if (gateway.apiKey) {
      try {
        ai = await extractBusinessWithAi(
          gateway,
          buildBusinessPrompt({
            url: finalUrl,
            title: candidates.title,
            description: candidates.description,
            jsonLd: jsonLdFacts,
            visibleText: homeText,
            internalPages,
          }),
        );
      } catch (e) {
        logStep("ia_negocio_indisponivel", requestId, {
          motivo: e instanceof Error ? e.message : String(e),
        });
      }
    }

    business = consolidateBusiness({
      jsonLd: jsonLdFacts,
      meta: {
        title: candidates.title,
        description: candidates.description,
        canonical: candidates.canonical,
      },
      ai,
      finalUrl,
    });
    const preenchidos = countFilledFields(business);
    diagnostics.step(
      "dados_empresa",
      preenchidos > 0 ? "ok" : "pulado",
      `${preenchidos} campo(s) encontrados · ${jsonLdNodes.length} bloco(s) JSON-LD · ${internalPages.length} página(s) interna(s)` +
        (ai ? "" : " · complemento por IA indisponível"),
    );
    logStep("dados_empresa", requestId, {
      campos: preenchidos,
      json_ld: jsonLdNodes.length,
      paginas_internas: internalPages.length,
      ia: !!ai,
    });
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    diagnostics.step("dados_empresa", "falhou", motivo);
    logStep("dados_empresa_falhou", requestId, { motivo });
  }

  const palette = buildPalette(hex);
  logStep("sucesso", requestId, {
    host: parsed.hostname,
    source_hex: hex,
    primary: palette.primary,
  });

  return json(200, {
    ...palette,
    source_hex: hex,
    site_title: candidates.title,
    site_description: candidates.description ? candidates.description.slice(0, 200) : null,
    suggested_segment: segment ?? business?.segment.value ?? null,
    ...(business ? { business } : {}),
  });
});
