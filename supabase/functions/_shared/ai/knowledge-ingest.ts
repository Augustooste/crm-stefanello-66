import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { callKnowledgeEmbeddings } from "./gateway.ts";
import { reportAIFailure } from "./failure-log.ts";
import { redactSecrets } from "../redact-secrets.ts";

export const KNOWLEDGE_MAX_BYTES = 25 * 1024 * 1024;
export const KNOWLEDGE_MAX_MB = Math.round(KNOWLEDGE_MAX_BYTES / (1024 * 1024));
export const KNOWLEDGE_MAX_CHUNKS = 200;
const KNOWLEDGE_MAX_TEXT_CHARS = 1_500_000;
const CHUNK_MAX_CHARS = 3_200;
const CHUNK_OVERLAP_CHARS = 320;
const PROVIDER_TIMEOUT_MS = 15_000;

export type KnowledgeSourceType = "text" | "upload";

export interface KnowledgeUploadInput {
  title: string;
  sourceType: KnowledgeSourceType;
  text?: string;
  fileName?: string;
  mimeType?: string;
  base64?: string;
}

export interface ValidatedKnowledgeUpload {
  title: string;
  sourceType: KnowledgeSourceType;
  fileName: string | null;
  mimeType: string;
  bytes: Uint8Array;
  sourceText: string | null;
  sourceBase64: string | null;
  contentHash: string;
}

export interface KnowledgeDocumentRow {
  id: string;
  tenant_id: string;
  title: string;
  source_type: KnowledgeSourceType;
  file_name: string | null;
  mime_type: string;
  source_text: string | null;
  source_base64: string | null;
  status: string;
  remote_file_id?: string | null;
  remote_job_id?: string | null;
}

export interface ParsedKnowledgeSource {
  text: string;
  remoteFileId: string | null;
  remoteJobId: string | null;
}

/**
 * Formatos aceitos no upload da base de conhecimento.
 * Espelha os tipos suportados pelo LlamaParse (documentos, planilhas e imagens).
 * Alguns navegadores enviam MIME vazio ou genérico — por isso
 * application/octet-stream e "" são tolerados quando a extensão é válida.
 */
const GENERIC_MIMES = ["", "application/octet-stream", "binary/octet-stream"] as const;

const UPLOAD_TYPES: Record<string, readonly string[]> = {
  // Texto puro (não passa pelo LlamaParse)
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain", "text/x-markdown"],
  // Documentos
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  doc: ["application/msword"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ppt: ["application/vnd.ms-powerpoint"],
  rtf: ["application/rtf", "text/rtf"],
  epub: ["application/epub+zip"],
  // Planilhas
  csv: ["text/csv", "application/csv", "text/plain"],
  tsv: ["text/tab-separated-values", "text/plain"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  xls: ["application/vnd.ms-excel"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet"],
  // Imagens (OCR do LlamaParse)
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  webp: ["image/webp"],
  tiff: ["image/tiff"],
  tif: ["image/tiff"],
  heic: ["image/heic"],
};

/** Extensões lidas diretamente como UTF-8, sem chamar o LlamaParse. */
const PLAIN_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

export const KNOWLEDGE_ACCEPTED_EXTENSIONS = Object.keys(UPLOAD_TYPES).map((ext) => `.${ext}`);

function cleanFileName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name.length > 180 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("Nome de arquivo inválido.");
  }
  return name;
}

function decodeBase64(input: string, declaredMime: string): Uint8Array {
  let raw = input.trim();
  const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(raw);
  if (dataUri) {
    if (dataUri[1].toLowerCase() !== declaredMime.toLowerCase()) {
      throw new Error("MIME type do arquivo não corresponde ao payload.");
    }
    raw = dataUri[2];
  }
  if (!raw || raw.length > Math.ceil((KNOWLEDGE_MAX_BYTES * 4) / 3) + 16) {
    throw new Error(`Arquivo vazio ou acima do limite de ${KNOWLEDGE_MAX_MB} MB.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new Error("Conteúdo base64 inválido.");
  }
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    throw new Error("Conteúdo base64 inválido.");
  }
  const out = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (out.byteLength < 1) throw new Error("Arquivo vazio.");
  if (out.byteLength > KNOWLEDGE_MAX_BYTES) {
    throw new Error(`Arquivo acima do limite de ${KNOWLEDGE_MAX_MB} MB.`);
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function validateKnowledgeUpload(
  input: KnowledgeUploadInput,
): Promise<ValidatedKnowledgeUpload> {
  const title = String(input.title ?? "").trim();
  if (!title || title.length > 200) {
    throw new Error("Título é obrigatório e deve ter até 200 caracteres.");
  }
  if (input.sourceType !== "text" && input.sourceType !== "upload") {
    throw new Error("sourceType deve ser text ou upload.");
  }

  if (input.sourceType === "text") {
    const text = String(input.text ?? "").trim();
    if (!text) throw new Error("Texto vazio.");
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > KNOWLEDGE_MAX_BYTES) {
      throw new Error(`Texto acima do limite de ${KNOWLEDGE_MAX_MB} MB.`);
    }
    return {
      title,
      sourceType: "text",
      fileName: null,
      mimeType: "text/plain",
      bytes,
      sourceText: text,
      sourceBase64: null,
      contentHash: await sha256Hex(bytes),
    };
  }

  const fileName = cleanFileName(String(input.fileName ?? ""));
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  const allowedMimes = UPLOAD_TYPES[extension];
  const declaredMime = String(input.mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (!allowedMimes) {
    throw new Error(
      "Formato não suportado. Envie PDF, DOCX, DOC, PPTX, PPT, RTF, EPUB, TXT, MD, CSV, TSV, XLSX, XLS, ODS ou imagem (PNG, JPG, WEBP, TIFF, HEIC).",
    );
  }
  const isGeneric = (GENERIC_MIMES as readonly string[]).includes(declaredMime);
  if (!isGeneric && !allowedMimes.includes(declaredMime)) {
    throw new Error("MIME type não corresponde à extensão do arquivo.");
  }
  // Navegadores costumam mandar MIME vazio/genérico para .csv, .heic e Office antigos.
  const mimeType = isGeneric ? allowedMimes[0] : declaredMime;
  const bytes = decodeBase64(String(input.base64 ?? ""), declaredMime);
  return {
    title,
    sourceType: "upload",
    fileName,
    mimeType,
    bytes,
    sourceText: null,
    sourceBase64: String(input.base64 ?? "").trim().replace(/^data:[^;,]+;base64,/s, ""),
    contentHash: await sha256Hex(bytes),
  };
}

function decodeStoredBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("Arquivo de texto não está em UTF-8 válido.");
  }
}

function pushLongPiece(target: string[], piece: string): void {
  let start = 0;
  while (start < piece.length) {
    const end = Math.min(start + CHUNK_MAX_CHARS, piece.length);
    const chunk = piece.slice(start, end).trim();
    if (chunk) target.push(chunk);
    if (end === piece.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
}

export function chunkKnowledgeText(text: string): Array<{ content: string; tokenCount: number }> {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  if (!normalized) throw new Error("O documento não contém texto aproveitável.");
  if (normalized.length > KNOWLEDGE_MAX_TEXT_CHARS) {
    throw new Error("Texto extraído acima do limite de processamento.");
  }

  const rawPieces = normalized.split(/\n{2,}|(?=^#{1,6}\s)/m).map((piece) => piece.trim()).filter(
    Boolean,
  );
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = current.slice(-CHUNK_OVERLAP_CHARS).trim();
  };

  for (const piece of rawPieces) {
    if (piece.length > CHUNK_MAX_CHARS) {
      flush();
      current = "";
      pushLongPiece(chunks, piece);
      continue;
    }
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length > CHUNK_MAX_CHARS) flush();
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  const unique = chunks.filter((chunk, index) =>
    chunk && (index === 0 || chunk !== chunks[index - 1])
  );
  if (unique.length > KNOWLEDGE_MAX_CHUNKS) throw new Error("Documento gerou mais de 200 chunks.");
  return unique.map((content) => ({
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
  }));
}

function llamaBaseUrl(region: string): string | null {
  if (region === "na") return "https://api.cloud.llamaindex.ai";
  if (region === "eu") return "https://api.cloud.eu.llamaindex.ai";
  return null;
}

async function loadLlamaCloud(
  admin: SupabaseClient,
  tenantId: string,
): Promise<{ apiKey: string; baseUrl: string }> {
  const { data: integration, error: integrationError } = await admin
    .from("tenant_integrations")
    .select("status, config")
    .eq("tenant_id", tenantId)
    .eq("slug", "llamacloud")
    .maybeSingle();
  if (integrationError) {
    throw new Error(`Falha ao ler integração LlamaCloud: ${integrationError.message}`);
  }
  if (!integration || integration.status !== "active") {
    throw new Error("Conecte o LlamaCloud para processar arquivos PDF.");
  }
  const config = (integration.config ?? {}) as { region?: unknown };
  const { data: rows, error: secretError } = await admin
    .from("integration_secrets")
    .select("key, value")
    .eq("tenant_id", tenantId)
    .eq("slug", "llamacloud");
  if (secretError) throw new Error(`Falha ao ler credenciais LlamaCloud: ${secretError.message}`);
  const secrets = Object.fromEntries(
    (rows ?? []).map((row) => [String(row.key), String(row.value)]),
  );
  const region = String(config.region ?? secrets.region ?? "").toLowerCase();
  const baseUrl = llamaBaseUrl(region);
  if (!secrets.api_key || !baseUrl) throw new Error("Credenciais LlamaCloud incompletas.");
  return { apiKey: secrets.api_key, baseUrl };
}

async function providerJson(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Orçamento de espera do parse remoto.
 *
 * O isolate da Edge Function morre no idle timeout de 150 s, então esperamos no
 * máximo ~110 s e devolvemos um erro retomável — o job segue vivo no LlamaCloud
 * e o "Reprocessar" o consulta pelo id salvo, sem novo upload nem novos créditos.
 */
const LLAMA_POLL_BUDGET_MS = 110_000;
const LLAMA_POLL_MAX_DELAY_MS = 5_000;

export const LLAMA_PENDING_MESSAGE =
  "O LlamaParse ainda está processando este arquivo. Aguarde alguns instantes e clique em Reprocessar — nenhum crédito extra será consumido.";

export class LlamaParsePendingError extends Error {
  constructor(readonly remoteFileId: string | null, readonly remoteJobId: string) {
    super(LLAMA_PENDING_MESSAGE);
    this.name = "LlamaParsePendingError";
  }
}

async function pollLlamaParseJob(
  apiKey: string,
  baseUrl: string,
  fileId: string | null,
  jobId: string,
  opts: { pollDelayMs?: number; maxPolls?: number; budgetMs?: number },
): Promise<ParsedKnowledgeSource> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? LLAMA_POLL_BUDGET_MS;
  const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;
  const baseDelay = opts.pollDelayMs ?? 1_000;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const statusRes = await fetch(
      `${baseUrl}/api/v2/parse/${encodeURIComponent(jobId)}?expand=markdown_full`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!statusRes.ok) {
      throw new Error(`Falha ao consultar job LlamaParse (HTTP ${statusRes.status}).`);
    }
    const statusBody = await providerJson(statusRes);
    const job = (statusBody.job ?? statusBody) as Record<string, unknown>;
    const status = String(job.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "CANCELLED") {
      const providerError = String(job.error_message ?? "").trim();
      const suffix = providerError ? `: ${redactSecrets(providerError).slice(0, 300)}` : "";
      throw new Error(`LlamaParse terminou com status ${status}${suffix}.`);
    }
    if (status === "COMPLETED") {
      const expanded = statusBody.markdown_full ?? job.markdown_full;
      const markdown = typeof expanded === "string"
        ? expanded.trim()
        : String((expanded as Record<string, unknown> | null)?.markdown ?? "").trim();
      if (!markdown) throw new Error("LlamaParse devolveu conteúdo vazio.");
      return { text: markdown, remoteFileId: fileId, remoteJobId: jobId };
    }
    // Backoff progressivo: 1s, 2s, 3s… até LLAMA_POLL_MAX_DELAY_MS.
    const delay = Math.min(baseDelay * (attempt + 1), LLAMA_POLL_MAX_DELAY_MS);
    if (Date.now() - startedAt + delay > budgetMs) break;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new LlamaParsePendingError(fileId, jobId);
}

/** Consulta um job já existente — usado no reprocessamento, sem novo upload. */
export async function resumeLlamaParseJob(
  admin: SupabaseClient,
  tenantId: string,
  jobId: string,
  fileId: string | null,
  opts: { pollDelayMs?: number; maxPolls?: number; budgetMs?: number } = {},
): Promise<ParsedKnowledgeSource> {
  const { apiKey, baseUrl } = await loadLlamaCloud(admin, tenantId);
  return await pollLlamaParseJob(apiKey, baseUrl, fileId, jobId, opts);
}

export async function parseFileWithLlamaParse(
  admin: SupabaseClient,
  tenantId: string,
  bytes: Uint8Array,
  fileName: string,
  mimeType: string = "application/pdf",
  opts: {
    pollDelayMs?: number;
    maxPolls?: number;
    budgetMs?: number;
    /** Persiste os ids assim que o job existe, antes da espera. */
    onJobCreated?: (ids: { remoteFileId: string; remoteJobId: string }) => Promise<void> | void;
  } = {},
): Promise<ParsedKnowledgeSource> {
  const { apiKey, baseUrl } = await loadLlamaCloud(admin, tenantId);
  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(bytes).buffer], { type: mimeType || "application/octet-stream" }),
    fileName,
  );
  form.append("purpose", "parse");
  const upload = await fetch(`${baseUrl}/api/v1/beta/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!upload.ok) throw new Error(`LlamaParse recusou o arquivo (HTTP ${upload.status}).`);
  const uploaded = await providerJson(upload);
  const fileId = String(uploaded.id ?? "");
  if (!fileId) throw new Error("LlamaParse não devolveu o id do arquivo.");

  const createJob = await fetch(`${baseUrl}/api/v2/parse`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_id: fileId,
      tier: "cost_effective",
      version: "latest",
      client_name: "acelera-flow-mvp",
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!createJob.ok) {
    throw new Error(`LlamaParse recusou o job (HTTP ${createJob.status}).`);
  }
  const createdJob = await providerJson(createJob);
  const jobId = String(createdJob.id ?? "");
  if (!jobId) throw new Error("LlamaParse não devolveu o id do job.");

  // Salva antes de esperar: se o tempo estourar, o reprocessamento retoma este job.
  if (opts.onJobCreated) {
    try {
      await opts.onJobCreated({ remoteFileId: fileId, remoteJobId: jobId });
    } catch (error) {
      console.error("kb.remote_job.persist_failed", {
        tenantId,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return await pollLlamaParseJob(apiKey, baseUrl, fileId, jobId, opts);
}

export async function extractKnowledgeSource(
  admin: SupabaseClient,
  document: KnowledgeDocumentRow,
): Promise<ParsedKnowledgeSource> {
  if (document.source_type === "text") {
    return {
      text: String(document.source_text ?? "").trim(),
      remoteFileId: null,
      remoteJobId: null,
    };
  }
  const mimeType = String(document.mime_type ?? "").toLowerCase();
  const existingJobId = String(document.remote_job_id ?? "").trim();
  // Reprocessamento de um job já criado: só consulta, sem reenviar (não gasta créditos).
  if (existingJobId && !PLAIN_TEXT_MIMES.has(mimeType)) {
    return await resumeLlamaParseJob(
      admin,
      document.tenant_id,
      existingJobId,
      document.remote_file_id ?? null,
    );
  }
  const bytes = decodeStoredBase64(String(document.source_base64 ?? ""));
  // Texto puro é lido direto; qualquer formato binário/estruturado vai para o LlamaParse.
  if (PLAIN_TEXT_MIMES.has(mimeType)) {
    return { text: decodeUtf8(bytes), remoteFileId: null, remoteJobId: null };
  }
  return await parseFileWithLlamaParse(
    admin,
    document.tenant_id,
    bytes,
    document.file_name ?? "documento",
    mimeType || "application/octet-stream",
    {
      onJobCreated: async ({ remoteFileId, remoteJobId }) => {
        await admin
          .from("kb_documents")
          .update({
            remote_provider: "llamacloud",
            remote_file_id: remoteFileId,
            remote_job_id: remoteJobId,
          })
          .eq("id", document.id)
          .eq("tenant_id", document.tenant_id);
      },
    },
  );
}

/**
 * Lease do claim de ingestão.
 *
 * Orçamento real do pior caso, medido no próprio caminho: LlamaParse faz upload
 * + criação do job (2 × PROVIDER_TIMEOUT_MS = 30 s) e depois espera o parse por
 * até LLAMA_POLL_BUDGET_MS (110 s); os embeddings somam até 7 lotes
 * de KNOWLEDGE_MAX_CHUNKS/32 a AI_GATEWAY_TIMEOUT_MS cada. Nada disso chega a
 * rodar inteiro: o isolate morre antes, no idle timeout de 150 s da Edge
 * Function (SUPABASE_EDGE_REQUEST_IDLE_TIMEOUT_MS). 5 min = 2× esse teto, e é o
 * mesmo intervalo das leases já usadas no repo
 * (20260728120000_webhook_ai_claim_leases.sql).
 *
 * `updated_at` é mantido pelo trigger kb_documents_set_updated_at
 * (20260728122000), então o claim renova a lease sem coluna nova.
 */
export const KNOWLEDGE_CLAIM_LEASE_MS = 5 * 60 * 1_000;

export async function processKnowledgeDocument(
  admin: SupabaseClient,
  document: KnowledgeDocumentRow,
): Promise<
  { ok: true; chunkCount: number } | { ok: false; status: string; error: string }
> {
  const leaseCutoff = new Date(Date.now() - KNOWLEDGE_CLAIM_LEASE_MS).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("kb_documents")
    .update({ status: "processing", error_message: null })
    .eq("id", document.id)
    .eq("tenant_id", document.tenant_id)
    .or(`status.neq.processing,updated_at.lt.${leaseCutoff}`)
    .select("id")
    .maybeSingle();
  if (claimError) {
    return { ok: false, status: document.status, error: "Falha ao iniciar o processamento." };
  }
  if (!claimed) {
    return { ok: false, status: "processing", error: "Documento já está sendo processado." };
  }

  console.log("kb.document.processing", { tenantId: document.tenant_id, documentId: document.id });
  try {
    const parsed = await extractKnowledgeSource(admin, document);
    const chunks = chunkKnowledgeText(parsed.text);
    const embeddings: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += 32) {
      embeddings.push(
        ...await callKnowledgeEmbeddings(
          chunks.slice(offset, offset + 32).map((chunk) => chunk.content),
          { taskType: "RETRIEVAL_DOCUMENT" },
        ),
      );
    }
    const payload = chunks.map((chunk, index) => ({
      chunk_index: index,
      content: chunk.content,
      token_count: chunk.tokenCount,
      embedding: `[${embeddings[index].join(",")}]`,
    }));
    const { data: replaced, error: replaceError } = await admin.rpc("replace_kb_chunks", {
      p_tenant_id: document.tenant_id,
      p_document_id: document.id,
      p_chunks: payload,
    });
    if (replaceError || Number(replaced) !== chunks.length) {
      throw new Error(`Falha ao indexar chunks: ${replaceError?.message ?? "contagem divergente"}`);
    }
    const { error: readyError } = await admin
      .from("kb_documents")
      .update({
        status: "ready",
        error_message: null,
        chunk_count: chunks.length,
        source_text: parsed.text,
        remote_provider: parsed.remoteJobId ? "llamacloud" : null,
        remote_file_id: parsed.remoteFileId,
        remote_job_id: parsed.remoteJobId,
      })
      .eq("id", document.id)
      .eq("tenant_id", document.tenant_id);
    if (readyError) throw new Error(`Falha ao concluir documento: ${readyError.message}`);
    console.log("kb.document.ready", {
      tenantId: document.tenant_id,
      documentId: document.id,
      chunkCount: chunks.length,
    });
    return { ok: true, chunkCount: chunks.length };
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    );
    console.error("kb.document.failed", {
      tenantId: document.tenant_id,
      documentId: document.id,
      error: detail,
    });
    await reportAIFailure(admin, {
      tenantId: document.tenant_id,
      route: "kb-documents.ingest",
      provider: /llamaparse|llamacloud/i.test(detail) ? "llamacloud" : "gemini",
      errorCode: "knowledge_ingest_failed",
      errorMessage: detail,
      context: { document_id: document.id },
    });
    const { error: failedError } = await admin
      .from("kb_documents")
      .update({ status: "failed", error_message: detail, chunk_count: 0 })
      .eq("id", document.id)
      .eq("tenant_id", document.tenant_id);
    // Se nem o "failed" gravou, a linha continua em processing: reportar
    // "failed" aqui seria a mesma mentira que este fix está removendo.
    return { ok: false, status: failedError ? "processing" : "failed", error: detail };
  }
}

export async function deleteRemoteKnowledgeFileBestEffort(
  admin: SupabaseClient,
  document: Pick<KnowledgeDocumentRow, "tenant_id"> & { remote_file_id?: string | null },
): Promise<void> {
  if (!document.remote_file_id) return;
  try {
    const { apiKey, baseUrl } = await loadLlamaCloud(admin, document.tenant_id);
    const res = await fetch(
      `${baseUrl}/api/v1/beta/files/${encodeURIComponent(document.remote_file_id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!res.ok && res.status !== 404) {
      console.error("kb.remote_file.delete_failed", {
        tenantId: document.tenant_id,
        status: res.status,
      });
    }
  } catch (error) {
    console.error("kb.remote_file.delete_failed", {
      tenantId: document.tenant_id,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }
}
