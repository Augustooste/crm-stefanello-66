// Testes do catálogo de ações do copiloto. O que importa aqui não é o caminho
// feliz — é que o JSON vindo do modelo seja tratado como entrada hostil e que
// nenhuma consulta escape do tenant nem do papel.
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  type CopilotAtor,
  escaparIlike,
  executarAcao,
  lerPlano,
  padraoBusca,
} from "../_shared/ai/copilot-actions.ts";

setEnv(BASE_ENV);

function admin() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const ADMIN_ATOR: CopilotAtor = { tenantId: "tenant-1", userId: "user-admin", role: "admin" };
const AGENTE_ATOR: CopilotAtor = { tenantId: "tenant-1", userId: "user-agente", role: "agent" };

interface Chamada {
  pathname: string;
  search: URLSearchParams;
  method: string;
  body: Record<string, unknown> | null;
}

function router(
  chamadas: Chamada[],
  respostas: Record<string, unknown> = {},
): FetchMatcher {
  return (r) => {
    const url = new URL(r.url);
    chamadas.push({
      pathname: url.pathname,
      search: url.searchParams,
      method: r.method,
      body: (r.bodyJson ?? null) as Record<string, unknown> | null,
    });
    const chave = `${r.method} ${url.pathname}`;
    if (chave in respostas) return jsonResponse(200, respostas[chave]);
    return jsonResponse(200, []);
  };
}

Deno.test("lerPlano trata o JSON do modelo como entrada hostil", async (t) => {
  await t.step("recusa ação fora da whitelist", () => {
    for (const bruto of [
      { acao: "drop_table", parametros: {} },
      { acao: "", parametros: {} },
      { acao: "executarAcao", parametros: {} },
      "negocios_por_valor",
      null,
      ["negocios_por_valor"],
    ]) {
      let barrou = false;
      try {
        lerPlano(bruto);
      } catch {
        barrou = true;
      }
      if (!barrou) throw new Error(`plano deveria ser recusado: ${JSON.stringify(bruto)}`);
    }
  });

  await t.step("aceita ação válida e normaliza parâmetros ausentes", () => {
    const plano = lerPlano({ acao: "contatos_recentes" });
    if (plano.acao !== "contatos_recentes") throw new Error("ação perdida");
    if (typeof plano.parametros !== "object") throw new Error("parametros deveria virar objeto");
  });

  await t.step("parametros que não são objeto viram objeto vazio, não vazam", () => {
    const plano = lerPlano({ acao: "buscar_negocios", parametros: "'; drop table deals; --" });
    if (Object.keys(plano.parametros).length !== 0) throw new Error("string virou parametros");
  });
});

Deno.test("escaparIlike neutraliza curinga do termo digitado", () => {
  if (escaparIlike("100%") !== "100\\%") throw new Error("% não escapado");
  if (escaparIlike("a_b") !== "a\\_b") throw new Error("_ não escapado");
});

Deno.test("executarAcao: escopo de tenant e de papel", async (t) => {
  await t.step("leitura sempre filtra tenant_id", async () => {
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(router(chamadas));
    try {
      await executarAcao(admin(), ADMIN_ATOR, { acao: "negocios_por_valor", parametros: {} });
      const c = chamadas.find((x) => x.pathname === "/rest/v1/deals");
      if (!c) throw new Error("não consultou deals");
      if (c.search.get("tenant_id") !== "eq.tenant-1") {
        throw new Error(`consulta sem escopo de tenant: ${c.search.get("tenant_id")}`);
      }
      if (c.search.get("status") !== "eq.open") throw new Error("não filtrou negócios em aberto");
    } finally {
      uninstall();
    }
  });

  await t.step("limite do modelo é preso ao teto, não vira scan", async () => {
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(router(chamadas));
    try {
      await executarAcao(admin(), ADMIN_ATOR, {
        acao: "negocios_por_valor",
        parametros: { limite: 100000 },
      });
      const c = chamadas.find((x) => x.pathname === "/rest/v1/deals")!;
      if (c.search.get("limit") !== "50") {
        throw new Error(`limite não foi tetado: ${c.search.get("limit")}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("parâmetro de tipo errado falha fechado", async () => {
    const uninstall = installFetchMock(router([]));
    try {
      for (
        const plano of [
          { acao: "buscar_negocios", parametros: { termo: 42 } },
          { acao: "atualizar_valor", parametros: { deal_id: "nao-e-uuid", valor: 10 } },
          { acao: "atualizar_valor", parametros: { deal_id: crypto.randomUUID(), valor: "1000" } },
          { acao: "concluir_atividade", parametros: {} },
        ]
      ) {
        let barrou = false;
        try {
          await executarAcao(admin(), ADMIN_ATOR, plano);
        } catch {
          barrou = true;
        }
        if (!barrou) throw new Error(`deveria ter recusado: ${JSON.stringify(plano)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("atendente não escreve em negócio de outro responsável", async () => {
    const dealId = "11111111-1111-1111-1111-111111111111";
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(
      router(chamadas, {
        "GET /rest/v1/deals": {
          id: dealId,
          title: "Negócio alheio",
          board_id: "board-1",
          owner_id: "outro-usuario",
        },
      }),
    );
    try {
      let barrou = false;
      try {
        await executarAcao(admin(), AGENTE_ATOR, {
          acao: "atualizar_valor",
          parametros: { deal_id: dealId, valor: 999 },
        });
      } catch (e) {
        barrou = String(e).includes("responsável");
      }
      if (!barrou) throw new Error("atendente conseguiu escrever em negócio de outro");
      if (chamadas.some((c) => c.method === "PATCH")) {
        throw new Error("chegou a mandar o PATCH antes de barrar");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("admin escreve em negócio de qualquer responsável do tenant", async () => {
    const dealId = "22222222-2222-2222-2222-222222222222";
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(
      router(chamadas, {
        "GET /rest/v1/deals": {
          id: dealId,
          title: "Negócio do time",
          board_id: "board-1",
          owner_id: "outro-usuario",
        },
      }),
    );
    try {
      const r = await executarAcao(admin(), ADMIN_ATOR, {
        acao: "atualizar_valor",
        parametros: { deal_id: dealId, valor: 1500 },
      });
      if (!r.ok) throw new Error(`admin deveria conseguiu escrever: ${r.resumo}`);
      const patch = chamadas.find((c) => c.method === "PATCH" && c.pathname === "/rest/v1/deals");
      if (!patch) throw new Error("não mandou o PATCH");
      if (patch.search.get("tenant_id") !== "eq.tenant-1") {
        throw new Error("escrita sem escopo de tenant");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("atendente só conclui a própria atividade", async () => {
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(router(chamadas));
    try {
      await executarAcao(admin(), AGENTE_ATOR, {
        acao: "concluir_atividade",
        parametros: { atividade_id: "33333333-3333-3333-3333-333333333333" },
      });
      const c = chamadas.find((x) => x.pathname === "/rest/v1/activities")!;
      if (c.search.get("owner_id") !== "eq.user-agente") {
        throw new Error("atendente concluiu atividade sem filtro de dono");
      }
      // Posse não substitui tenant: sem esta asserção, remover o filtro de
      // tenant do UPDATE mantinha a suíte verde (provado por mutação).
      if (c.search.get("tenant_id") !== "eq.tenant-1") {
        throw new Error("conclusão de atividade sem escopo de tenant");
      }
    } finally {
      uninstall();
    }
  });

  // Negócio de OUTRO tenant não é "negado", é inexistente — o filtro de
  // tenant_id na SELECT de posse faz o PostgREST não achar a linha. Sem este
  // teste, remover aquele filtro deixava a suíte verde e abria IDOR.
  await t.step("negócio de outro tenant não é encontrado", async () => {
    const dealId = "44444444-4444-4444-4444-444444444444";
    for (const acao of ["atualizar_valor", "mover_negocio"] as const) {
      const chamadas: Chamada[] = [];
      const uninstall = installFetchMock(router(chamadas, { "GET /rest/v1/deals": null }));
      try {
        let barrou = false;
        try {
          await executarAcao(admin(), ADMIN_ATOR, {
            acao,
            parametros: acao === "atualizar_valor"
              ? { deal_id: dealId, valor: 10 }
              : { deal_id: dealId, estagio: "Proposta" },
          });
        } catch (e) {
          barrou = String(e).includes("não encontrado");
        }
        if (!barrou) throw new Error(`${acao} não barrou negócio de outro tenant`);
        const selecao = chamadas.find((c) => c.method === "GET" && c.pathname === "/rest/v1/deals");
        if (selecao?.search.get("tenant_id") !== "eq.tenant-1") {
          throw new Error(`${acao}: posse consultada sem escopo de tenant`);
        }
        if (chamadas.some((c) => c.method === "PATCH")) {
          throw new Error(`${acao} chegou a escrever`);
        }
      } finally {
        uninstall();
      }
    }
  });

  await t.step("mover_negocio resolve o estágio pelo quadro do negócio", async () => {
    const dealId = "55555555-5555-5555-5555-555555555555";
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(
      router(chamadas, {
        "GET /rest/v1/deals": {
          id: dealId,
          title: "Negócio",
          board_id: "board-9",
          owner_id: "user-admin",
        },
        "GET /rest/v1/board_stages": { id: "stage-9", name: "Proposta" },
      }),
    );
    try {
      const r = await executarAcao(admin(), ADMIN_ATOR, {
        acao: "mover_negocio",
        parametros: { deal_id: dealId, estagio: "Proposta" },
      });
      if (!r.ok) throw new Error(`deveria ter moldado: ${r.resumo}`);
      const estagios = chamadas.find((c) => c.pathname === "/rest/v1/board_stages")!;
      if (estagios.search.get("board_id") !== "eq.board-9") {
        throw new Error("estágio buscado fora do quadro do negócio");
      }
      const patch = chamadas.find((c) => c.method === "PATCH" && c.pathname === "/rest/v1/deals")!;
      if (patch.search.get("tenant_id") !== "eq.tenant-1") {
        throw new Error("movimento sem escopo de tenant");
      }
    } finally {
      uninstall();
    }
  });

  // O modelo pode inventar `tenant_id`/`owner_id` nos parâmetros. Eles têm que
  // ser ignorados: quem manda é o ator resolvido no servidor.
  await t.step("criar_atividade ignora tenant_id e owner_id forjados pelo modelo", async () => {
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(
      router(chamadas, { "POST /rest/v1/activities": { id: "act-1", title: "Ligar", due_at: null } }),
    );
    try {
      await executarAcao(admin(), AGENTE_ATOR, {
        acao: "criar_atividade",
        parametros: {
          titulo: "Ligar",
          tipo: "call",
          due_at: "2026-08-10T13:00:00.000Z",
          tenant_id: "tenant-invadido",
          owner_id: "user-vitima",
        },
      });
      const post = chamadas.find((c) => c.method === "POST" && c.pathname === "/rest/v1/activities")!;
      if (post.body?.tenant_id !== "tenant-1") {
        throw new Error(`tenant_id do INSERT veio do modelo: ${post.body?.tenant_id}`);
      }
      if (post.body?.owner_id !== "user-agente") {
        throw new Error(`owner_id do INSERT veio do modelo: ${post.body?.owner_id}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("buscar_negocios escapa o curinga antes de ir ao PostgREST", async () => {
    const chamadas: Chamada[] = [];
    const uninstall = installFetchMock(router(chamadas));
    try {
      await executarAcao(admin(), ADMIN_ATOR, {
        acao: "buscar_negocios",
        parametros: { termo: "100%" },
      });
      const c = chamadas.find((x) => x.pathname === "/rest/v1/deals")!;
      if (c.search.get("tenant_id") !== "eq.tenant-1") throw new Error("busca sem escopo de tenant");
      // O `\` do escape não sobrevive à decodificação da querystring, então a
      // prova de que o termo é escapado fica no helper que monta o padrão.
      if (padraoBusca("100%") !== "%100\\%%") {
        throw new Error(`padrão de busca sem escape: ${padraoBusca("100%")}`);
      }
      if (padraoBusca("a_b") !== "%a\\_b%") throw new Error("underscore não escapado no padrão");
    } finally {
      uninstall();
    }
  });

  await t.step("leituras restantes filtram tenant_id", async () => {
    for (
      const [acao, rota] of [
        ["contatos_recentes", "/rest/v1/contacts"],
        ["atividades_pendentes", "/rest/v1/activities"],
      ] as const
    ) {
      const chamadas: Chamada[] = [];
      const uninstall = installFetchMock(router(chamadas));
      try {
        await executarAcao(admin(), AGENTE_ATOR, { acao, parametros: {} });
        const c = chamadas.find((x) => x.pathname === rota)!;
        if (c.search.get("tenant_id") !== "eq.tenant-1") {
          throw new Error(`${acao} consultou sem escopo de tenant`);
        }
      } finally {
        uninstall();
      }
    }
  });
});
