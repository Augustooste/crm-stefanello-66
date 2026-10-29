import { assert, assertEquals } from "jsr:@std/assert@1";
import { BASE_ENV, captureHandler, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { KNOWLEDGE_CLAIM_LEASE_MS } from "../_shared/ai/knowledge-ingest.ts";

setEnv({
  ...BASE_ENV,
  LOVABLE_API_KEY: "lovable-test",
  ALLOWED_ORIGINS: "https://crm.example.com",
});

const handler = await captureHandler("../kb-documents/index.ts");
const VECTOR = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);

function request(
  body: unknown,
  origin: string,
  method = "POST",
): Request {
  return new Request("http://fn.local", {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer user-token",
      origin,
    },
    body: method === "OPTIONS" ? undefined : JSON.stringify(body),
  });
}

Deno.test("kb-documents — CORS usa allowlist por request", async (t) => {
  await t.step("aceita subdomínio lovable.app", async () => {
    const res = await handler(request(null, "https://tenant.lovable.app", "OPTIONS"));
    assertEquals(res.headers.get("access-control-allow-origin"), "https://tenant.lovable.app");
    assertEquals(res.headers.get("vary"), "Origin");
  });

  await t.step("aceita origem configurada", async () => {
    const res = await handler(request(null, "https://crm.example.com", "OPTIONS"));
    assertEquals(res.headers.get("access-control-allow-origin"), "https://crm.example.com");
  });

  await t.step("bloqueia origem não autorizada", async () => {
    const res = await handler(request(null, "https://evil.example", "OPTIONS"));
    assertEquals(res.headers.get("access-control-allow-origin"), "null");
  });
});

Deno.test("kb-documents — sourceType upload é persistido e processado", async () => {
  let inserted: Record<string, unknown> | null = null;
  let ready = false;
  const restore = installFetchMock((req) => {
    if (req.pathname === "/auth/v1/user") {
      return jsonResponse(200, { id: "user-1", email: "admin@test.local" });
    }
    if (req.pathname === "/rest/v1/profiles") {
      return jsonResponse(200, {
        tenant_id: "tenant-a",
      });
    }
    if (req.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(200, {
        tenant_id: "tenant-a",
        user_id: "user-1",
        role_id: "role-admin",
        status: "active",
        revoked_at: null,
      });
    }
    if (req.pathname === "/rest/v1/roles") return jsonResponse(200, { role_key: "admin" });
    if (req.pathname === "/rest/v1/kb_documents" && req.method === "GET") {
      return jsonResponse(200, null);
    }
    if (req.pathname === "/rest/v1/kb_documents" && req.method === "POST") {
      inserted = req.bodyJson as Record<string, unknown>;
      return jsonResponse(200, {
        id: "da000000-0000-4000-8000-000000000001",
        tenant_id: "tenant-a",
        title: inserted.title,
        source_type: inserted.source_type,
        file_name: inserted.file_name,
        mime_type: inserted.mime_type,
        source_text: inserted.source_text,
        source_base64: inserted.source_base64,
        status: "uploaded",
      });
    }
    if (req.pathname === "/rest/v1/kb_documents" && req.method === "PATCH") {
      const patch = req.bodyJson as Record<string, unknown>;
      if (patch.status === "processing") {
        return jsonResponse(200, { id: "da000000-0000-4000-8000-000000000001" });
      }
      ready = patch.status === "ready";
      return jsonResponse(200, {});
    }
    if (req.pathname === "/v1/embeddings") {
      const input = (req.bodyJson as { input: string[] }).input;
      return jsonResponse(200, {
        data: input.map((_, index) => ({ index, embedding: VECTOR })),
      });
    }

    if (req.pathname === "/rest/v1/rpc/replace_kb_chunks") {
      return jsonResponse(200, 1);
    }
    return undefined;
  });

  try {
    const text = "# Manual\nA garantia vale por 12 meses.";
    const res = await handler(request(
      {
        action: "upload",
        title: "Manual",
        sourceType: "upload",
        fileName: "manual.md",
        mimeType: "text/markdown",
        base64: btoa(text),
      },
      "https://tenant.lovable.app",
    ));
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.status, "ready");
    assert(inserted);
    assertEquals((inserted as unknown as Record<string, unknown>).source_type, "upload");
    assertEquals((inserted as unknown as Record<string, unknown>).mime_type, "text/markdown");
    assertEquals(ready, true);
    assertEquals(res.headers.get("access-control-allow-origin"), "https://tenant.lovable.app");
  } finally {
    restore();
  }
});

const DOC_ID = "da000000-0000-4000-8000-000000000002";

/**
 * Simula o filtro do PostgREST no PATCH do claim: lê o `or=(...)` da query,
 * extrai o corte da lease e compara com o `updated_at` da linha fixture. Sem o
 * `.or(...)` no código, `or` vem nulo e o teste falha — que é o ponto.
 */
function claimWithLease(url: string, rowUpdatedAt: string, rowStatus: string): Response {
  const or = new URL(url).searchParams.get("or");
  assert(or, "o claim precisa mandar or=(status.neq.processing,updated_at.lt.<corte>)");
  const cutoff = /updated_at\.lt\.([^,)]+)/.exec(or)?.[1];
  assert(cutoff, `or sem corte de lease em updated_at: ${or}`);
  const claimable = rowStatus !== "processing" || Date.parse(rowUpdatedAt) < Date.parse(cutoff);
  return jsonResponse(200, claimable ? { id: DOC_ID } : null);
}

function reprocessMock(updatedAt: string): (req: {
  pathname: string;
  method: string;
  url: string;
  bodyJson: unknown;
}) => Response | undefined {
  return (req) => {
    if (req.pathname === "/auth/v1/user") {
      return jsonResponse(200, { id: "user-1", email: "admin@test.local" });
    }
    if (req.pathname === "/rest/v1/profiles") return jsonResponse(200, { tenant_id: "tenant-a" });
    if (req.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(200, {
        tenant_id: "tenant-a",
        user_id: "user-1",
        role_id: "role-admin",
        status: "active",
        revoked_at: null,
      });
    }
    if (req.pathname === "/rest/v1/roles") return jsonResponse(200, { role_key: "admin" });
    if (req.pathname === "/rest/v1/kb_documents" && req.method === "GET") {
      return jsonResponse(200, {
        id: DOC_ID,
        tenant_id: "tenant-a",
        title: "Manual travado",
        source_type: "text",
        file_name: null,
        mime_type: "text/plain",
        source_text: "# Manual\nA garantia vale por 12 meses.",
        source_base64: null,
        status: "processing",
        remote_file_id: null,
      });
    }
    if (req.pathname === "/rest/v1/kb_documents" && req.method === "PATCH") {
      const patch = req.bodyJson as Record<string, unknown>;
      if (patch.status === "processing") return claimWithLease(req.url, updatedAt, "processing");
      return jsonResponse(200, {});
    }
    if (req.pathname === "/v1/embeddings") {
      const requests = (req.bodyJson as { requests: unknown[] }).requests;
      return jsonResponse(200, {
        data: (req.bodyJson as { input: string[] }).input.map((_, index) => ({
          index,
          embedding: VECTOR,
        })),
      });
    }
    if (req.pathname === "/rest/v1/rpc/replace_kb_chunks") return jsonResponse(200, 1);
    return undefined;
  };
}

async function reprocess(updatedAt: string) {
  const restore = installFetchMock(reprocessMock(updatedAt));
  try {
    const res = await handler(request(
      { action: "reprocess", documentId: DOC_ID },
      "https://tenant.lovable.app",
    ));
    return await res.json();
  } finally {
    restore();
  }
}

Deno.test("kb-documents — lease vencida destrava documento preso em processing", async () => {
  const stale = new Date(Date.now() - KNOWLEDGE_CLAIM_LEASE_MS - 60_000).toISOString();
  const body = await reprocess(stale);
  assertEquals(body.ok, true);
  assertEquals(body.status, "ready");
});

Deno.test("kb-documents — lease viva recusa o claim e reporta o status real", async () => {
  const fresh = new Date().toISOString();
  const body = await reprocess(fresh);
  assertEquals(body.ok, false);
  // O bug era responder "failed" com a linha ainda em processing no banco.
  assertEquals(body.status, "processing");
  assertEquals(body.error, "Documento já está sendo processado.");
});
