import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  deleteRemoteKnowledgeFileBestEffort,
  type KnowledgeDocumentRow,
  type KnowledgeUploadInput,
  processKnowledgeDocument,
  validateKnowledgeUpload,
} from "../_shared/ai/knowledge-ingest.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { redactSecrets } from "../_shared/redact-secrets.ts";

function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
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
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

type Body =
  | { action: "list" }
  | ({ action: "upload" } & KnowledgeUploadInput)
  | { action: "reprocess"; documentId: string }
  | { action: "delete"; documentId: string };

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

function documentSelect(): string {
  return "id,tenant_id,title,source_type,file_name,mime_type,bytes,content_hash,status,error_message,chunk_count,remote_provider,remote_file_id,remote_job_id,created_at,updated_at";
}

async function authenticate(req: Request, cors: Record<string, string>): Promise<
  | { ok: true; admin: SupabaseClient; tenantId: string; userId: string }
  | { ok: false; response: Response }
> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    "";
  if (!supabaseUrl || !serviceRole || !anonKey) {
    return {
      ok: false,
      response: json(500, { ok: false, error: "Configuração do servidor ausente." }, cors),
    };
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) {
    return { ok: false, response: json(401, { ok: false, error: "Não autenticado." }, cors) };
  }
  const profile = await loadProfileOrFail(admin, auth.user.id, {
    operation: "kb.documents.load_profile",
    requireAdmin: true,
  });
  if (!profile.ok) {
    const status = profile.reason === "db_error" ? 503 : 403;
    const error = status === 503 ? PROFILE_DB_ERROR_MESSAGE : "Apenas administradores ativos.";
    return {
      ok: false,
      response: json(status, { ok: false, error }, cors),
    };
  }
  return {
    ok: true,
    admin,
    tenantId: profile.tenantId,
    userId: auth.user.id,
  };
}

async function listDocuments(
  admin: SupabaseClient,
  tenantId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const { data, error } = await admin
    .from("kb_documents")
    .select(documentSelect())
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("kb.document.list_failed", { tenantId, error: error.message });
    return json(503, { ok: false, error: "Não foi possível listar os documentos." }, cors);
  }
  return json(200, { ok: true, documents: data ?? [] }, cors);
}

async function findDuplicate(
  admin: SupabaseClient,
  tenantId: string,
  contentHash: string,
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await admin
    .from("kb_documents")
    .select("id,status")
    .eq("tenant_id", tenantId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (error) throw new Error(`Falha ao verificar duplicidade: ${error.message}`);
  return data as { id: string; status: string } | null;
}

async function uploadDocument(
  admin: SupabaseClient,
  tenantId: string,
  userId: string,
  body: Extract<Body, { action: "upload" }>,
  cors: Record<string, string>,
): Promise<Response> {
  let upload;
  try {
    upload = await validateKnowledgeUpload(body);
  } catch (error) {
    return json(
      400,
      {
        ok: false,
        error: error instanceof Error ? error.message : "Upload inválido.",
      },
      cors,
    );
  }

  try {
    const duplicate = await findDuplicate(admin, tenantId, upload.contentHash);
    if (duplicate) {
      return json(
        200,
        {
          ok: true,
          duplicate: true,
          documentId: duplicate.id,
          status: duplicate.status,
        },
        cors,
      );
    }
  } catch (error) {
    console.error("kb.document.dedupe_failed", { tenantId, error: String(error) });
    return json(503, { ok: false, error: "Não foi possível verificar o documento." }, cors);
  }

  const { data: inserted, error: insertError } = await admin
    .from("kb_documents")
    .insert({
      tenant_id: tenantId,
      title: upload.title,
      source_type: upload.sourceType,
      file_name: upload.fileName,
      mime_type: upload.mimeType,
      bytes: upload.bytes.byteLength,
      content_hash: upload.contentHash,
      source_text: upload.sourceText,
      source_base64: upload.sourceBase64,
      status: "uploaded",
      created_by: userId,
    })
    .select("id,tenant_id,title,source_type,file_name,mime_type,source_text,source_base64,status,remote_file_id,remote_job_id")
    .single();
  if (insertError || !inserted) {
    if (insertError?.code === "23505") {
      const duplicate = await findDuplicate(admin, tenantId, upload.contentHash).catch(() => null);
      return json(
        200,
        {
          ok: true,
          duplicate: true,
          documentId: duplicate?.id ?? null,
          status: duplicate?.status ?? "uploaded",
        },
        cors,
      );
    }
    console.error("kb.document.insert_failed", {
      tenantId,
      error: insertError?.message ?? "sem linha",
    });
    return json(503, { ok: false, error: "Não foi possível salvar o documento." }, cors);
  }

  const result = await processKnowledgeDocument(admin, inserted as KnowledgeDocumentRow);
  return json(
    200,
    {
      ok: result.ok,
      documentId: inserted.id,
      status: result.ok ? "ready" : result.status,
      ...(result.ok ? { chunkCount: result.chunkCount } : { error: result.error }),
    },
    cors,
  );
}

async function loadOwnedDocument(
  admin: SupabaseClient,
  tenantId: string,
  documentId: string,
): Promise<(KnowledgeDocumentRow & { remote_file_id?: string | null }) | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(documentId)) return null;
  const { data, error } = await admin
    .from("kb_documents")
    .select(
      "id,tenant_id,title,source_type,file_name,mime_type,source_text,source_base64,status,remote_file_id,remote_job_id",
    )
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler documento: ${error.message}`);
  return data as (KnowledgeDocumentRow & { remote_file_id?: string | null }) | null;
}

async function reprocessDocument(
  admin: SupabaseClient,
  tenantId: string,
  documentId: string,
  cors: Record<string, string>,
): Promise<Response> {
  let document;
  try {
    document = await loadOwnedDocument(admin, tenantId, documentId);
  } catch (error) {
    console.error("kb.document.reprocess_load_failed", {
      tenantId,
      documentId,
      error: String(error),
    });
    return json(503, { ok: false, error: "Não foi possível carregar o documento." }, cors);
  }
  if (!document) return json(404, { ok: false, error: "Documento não encontrado." }, cors);
  const result = await processKnowledgeDocument(admin, document);
  return json(
    200,
    {
      ok: result.ok,
      documentId,
      status: result.ok ? "ready" : result.status,
      ...(result.ok ? { chunkCount: result.chunkCount } : { error: result.error }),
    },
    cors,
  );
}

async function deleteDocument(
  admin: SupabaseClient,
  tenantId: string,
  documentId: string,
  cors: Record<string, string>,
): Promise<Response> {
  let document;
  try {
    document = await loadOwnedDocument(admin, tenantId, documentId);
  } catch (error) {
    console.error("kb.document.delete_load_failed", { tenantId, documentId, error: String(error) });
    return json(503, { ok: false, error: "Não foi possível carregar o documento." }, cors);
  }
  if (!document) return json(404, { ok: false, error: "Documento não encontrado." }, cors);

  await deleteRemoteKnowledgeFileBestEffort(admin, document);
  const { error } = await admin
    .from("kb_documents")
    .delete()
    .eq("id", documentId)
    .eq("tenant_id", tenantId);
  if (error) {
    console.error("kb.document.delete_failed", { tenantId, documentId, error: error.message });
    return json(503, { ok: false, error: "Não foi possível excluir o documento." }, cors);
  }
  console.log("kb.document.deleted", { tenantId, documentId });
  return json(200, { ok: true, documentId }, cors);
}

Deno.serve(async (req) => {
  const cors = buildCors(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, cors);
  }
  const auth = await authenticate(req, cors);
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "Corpo inválido." }, cors);
  }

  try {
    if (body.action === "list") return await listDocuments(auth.admin, auth.tenantId, cors);
    if (body.action === "upload") {
      return await uploadDocument(auth.admin, auth.tenantId, auth.userId, body, cors);
    }
    if (body.action === "reprocess") {
      return await reprocessDocument(
        auth.admin,
        auth.tenantId,
        String(body.documentId ?? ""),
        cors,
      );
    }
    if (body.action === "delete") {
      return await deleteDocument(auth.admin, auth.tenantId, String(body.documentId ?? ""), cors);
    }
    return json(400, { ok: false, error: "Ação inválida." }, cors);
  } catch (error) {
    console.error("kb.documents.unhandled", {
      tenantId: auth.tenantId,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
    return json(
      500,
      { ok: false, error: "Falha interna ao processar a base de conhecimento." },
      cors,
    );
  }
});
