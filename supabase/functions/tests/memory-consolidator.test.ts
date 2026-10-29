// Testa memory-consolidator.ts (supabase/functions/_shared/ai/memory-consolidator.ts):
// consolidateContactMemory grava contacts.ai_memory a partir dos resumos
// existentes (ou é no-op fail-open sem chamar a IA quando não há nenhum);
// findContactsNeedingConsolidation filtra por last_consolidated_at.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import {
  consolidateContactMemory,
  findContactsNeedingConsolidation,
} from "../_shared/ai/memory-consolidator.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const TENANT_ID = "tenant-1";
const CONTACT_ID = "contact-1";

const VALID_MEMORY_JSON = JSON.stringify({
  personality: "direto, sem rodeios",
  preferences: ["prefere WhatsApp de manhã"],
  history_summary: "Contato chegou via indicação, negociou preço e fechou.",
  important_dates: [{ date: "2026-08-01", note: "retorno agendado" }],
  relationship_notes: "indicado pelo cliente X",
});

function aiSuccessBody(content: string) {
  return { choices: [{ message: { content } }] };
}

Deno.test("consolidateContactMemory", async (t) => {
  await t.step(
    "consolida com summaries existentes: chama a IA e grava contacts.ai_memory",
    async () => {
      let patchedBody: Record<string, unknown> | null = null;
      let contactSummariesQueryCount = 0;
      const router: FetchMatcher = (req) => {
        const sp = new URL(req.url).searchParams;
        if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
          contactSummariesQueryCount++;
          return jsonResponse(200, [
            {
              summary: "Perguntou sobre preço",
              key_facts: ["orçamento 5k"],
              sentiment: "neutral",
              topics_discussed: ["preço"],
              commitments: [],
              objections: ["achou caro"],
              period_start: "2026-07-01T10:00:00Z",
              period_end: "2026-07-01T11:00:00Z",
            },
          ]);
        }
        if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
          return jsonResponse(200, [{ name: "Maria" }]);
        }
        if (req.pathname === "/rest/v1/contacts" && req.method === "PATCH") {
          patchedBody = req.bodyJson as Record<string, unknown>;
          if (!sp.get("id")?.includes(CONTACT_ID)) {
            throw new Error(`PATCH sem filtro id esperado: ${req.url}`);
          }
          if (!sp.get("tenant_id")?.includes(TENANT_ID)) {
            throw new Error(`PATCH sem filtro tenant_id: ${req.url}`);
          }
          return emptyResponse(200);
        }
        if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
          return jsonResponse(200, aiSuccessBody(VALID_MEMORY_JSON));
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const result = await consolidateContactMemory(admin, {
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
        });

        if (!result.success) throw new Error(`esperava success:true, veio error=${result.error}`);
        if (contactSummariesQueryCount !== 1) {
          throw new Error(`summaries query rodou ${contactSummariesQueryCount}x`);
        }
        if (!patchedBody) throw new Error("PATCH em /rest/v1/contacts não foi capturado");
        const body = patchedBody as Record<string, unknown>;
        const memory = body.ai_memory as Record<string, unknown>;
        if (memory.history_summary !== "Contato chegou via indicação, negociou preço e fechou.") {
          throw new Error(`history_summary=${memory.history_summary}`);
        }
        if (memory.personality !== "direto, sem rodeios") {
          throw new Error(`personality=${memory.personality}`);
        }
        if (!Array.isArray(memory.preferences) || memory.preferences.length !== 1) {
          throw new Error(`preferences=${JSON.stringify(memory.preferences)}`);
        }
        if (!Array.isArray(memory.important_dates) || memory.important_dates.length !== 1) {
          throw new Error(`important_dates=${JSON.stringify(memory.important_dates)}`);
        }
        if (typeof memory.last_consolidated_at !== "string" || !memory.last_consolidated_at) {
          throw new Error(`last_consolidated_at=${memory.last_consolidated_at}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("sem summaries: retorna success:true sem chamar a IA", async () => {
    let aiCalled = false;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, []);
      }
      if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        aiCalled = true;
        return jsonResponse(200, aiSuccessBody(VALID_MEMORY_JSON));
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await consolidateContactMemory(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
      });
      if (!result.success) throw new Error(`esperava success:true, veio error=${result.error}`);
      if (aiCalled) throw new Error("a IA foi chamada mesmo sem nenhum summary");
    } finally {
      uninstall();
    }
  });

  await t.step("resposta da IA em formato inválido: success:false com erro", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, [
          {
            summary: "x",
            key_facts: [],
            sentiment: null,
            topics_discussed: [],
            commitments: [],
            objections: [],
            period_start: "2026-07-01T10:00:00Z",
            period_end: "2026-07-01T11:00:00Z",
          },
        ]);
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, [{ name: "Maria" }]);
      }
      if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        return jsonResponse(200, aiSuccessBody("não é json"));
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await consolidateContactMemory(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
      });
      if (result.success) throw new Error("esperava success:false");
      if (!result.error) throw new Error("esperava mensagem de erro");
    } finally {
      uninstall();
    }
  });

  await t.step("UPDATE em contacts falha na API: retorna success:false com o erro", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, [
          {
            summary: "x",
            key_facts: [],
            sentiment: null,
            topics_discussed: [],
            commitments: [],
            objections: [],
            period_start: "2026-07-01T10:00:00Z",
            period_end: "2026-07-01T11:00:00Z",
          },
        ]);
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, [{ name: "Maria" }]);
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "PATCH") {
        return jsonResponse(500, { message: "update falhou" });
      }
      if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        return jsonResponse(200, aiSuccessBody(VALID_MEMORY_JSON));
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await consolidateContactMemory(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
      });
      if (result.success) throw new Error("esperava success:false quando o UPDATE falha");
      if (!result.error) throw new Error("esperava mensagem de erro");
    } finally {
      uninstall();
    }
  });

  await t.step("LOVABLE_API_KEY ausente: retorna erro sem chamar a IA", async () => {
    Deno.env.delete("LOVABLE_API_KEY");
    let aiCalled = false;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, [
          {
            summary: "x",
            key_facts: [],
            sentiment: null,
            topics_discussed: [],
            commitments: [],
            objections: [],
            period_start: "2026-07-01T10:00:00Z",
            period_end: "2026-07-01T11:00:00Z",
          },
        ]);
      }
      if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        aiCalled = true;
        return jsonResponse(200, aiSuccessBody(VALID_MEMORY_JSON));
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await consolidateContactMemory(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
      });
      if (result.success) throw new Error("esperava success:false sem LOVABLE_API_KEY");
      if (result.error !== "LOVABLE_API_KEY ausente.") {
        throw new Error(`error=${result.error}`);
      }
      if (aiCalled) throw new Error("a IA não deveria ter sido chamada sem LOVABLE_API_KEY");
    } finally {
      uninstall();
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });

  await t.step("IA retorna 429: mensagem de muitas requisições", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, [
          {
            summary: "x",
            key_facts: [],
            sentiment: null,
            topics_discussed: [],
            commitments: [],
            objections: [],
            period_start: "2026-07-01T10:00:00Z",
            period_end: "2026-07-01T11:00:00Z",
          },
        ]);
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, [{ name: "Maria" }]);
      }
      if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        return jsonResponse(429, { message: "slow down" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await consolidateContactMemory(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
      });
      if (result.success) throw new Error("esperava success:false para 429");
      if (result.error !== "Muitas requisições à IA agora. Tentaremos de novo em instantes.") {
        throw new Error(`error=${result.error}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA retorna 402: mensagem de créditos esgotados", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, [
          {
            summary: "x",
            key_facts: [],
            sentiment: null,
            topics_discussed: [],
            commitments: [],
            objections: [],
            period_start: "2026-07-01T10:00:00Z",
            period_end: "2026-07-01T11:00:00Z",
          },
        ]);
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, [{ name: "Maria" }]);
      }
      if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        return jsonResponse(402, { message: "no credits" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await consolidateContactMemory(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
      });
      if (result.success) throw new Error("esperava success:false para 402");
      if (result.error !== "Créditos de IA esgotados.") {
        throw new Error(`error=${result.error}`);
      }
    } finally {
      uninstall();
    }
  });
});

Deno.test("findContactsNeedingConsolidation", async (t) => {
  await t.step(
    "encontra contato sem ai_memory e contato desatualizado, ignora o já atualizado",
    async () => {
      const router: FetchMatcher = (req) => {
        const sp = new URL(req.url).searchParams;
        if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
          // created_at desc — primeiro summary de cada contato já é o "mais recente".
          return jsonResponse(200, [
            { contact_id: "never-consolidated", period_end: "2026-07-05T00:00:00Z" },
            { contact_id: "outdated", period_end: "2026-07-05T00:00:00Z" },
            { contact_id: "up-to-date", period_end: "2026-07-01T00:00:00Z" },
          ]);
        }
        if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
          if (!sp.get("id")?.includes("never-consolidated")) {
            throw new Error(`filtro .in(id, candidateIds) inesperado: ${req.url}`);
          }
          return jsonResponse(200, [
            { id: "never-consolidated", ai_memory: null },
            { id: "outdated", ai_memory: { last_consolidated_at: "2026-07-02T00:00:00Z" } },
            { id: "up-to-date", ai_memory: { last_consolidated_at: "2026-07-03T00:00:00Z" } },
          ]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const ids = await findContactsNeedingConsolidation(admin, TENANT_ID, 10);
        const sorted = [...ids].sort();
        if (sorted.join(",") !== "never-consolidated,outdated") {
          throw new Error(`esperava [never-consolidated, outdated], veio [${sorted.join(", ")}]`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("sem summaries: retorna array vazio sem consultar contacts", async () => {
    let contactsQueried = false;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_conversation_summaries" && req.method === "GET") {
        return jsonResponse(200, []);
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        contactsQueried = true;
        return jsonResponse(200, []);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const ids = await findContactsNeedingConsolidation(admin, TENANT_ID, 10);
      if (ids.length !== 0) throw new Error(`esperava [], veio ${JSON.stringify(ids)}`);
      if (contactsQueried) throw new Error("contacts foi consultado mesmo sem nenhum summary");
    } finally {
      uninstall();
    }
  });
});
