// Testa a lógica pura de supabase/functions/messaging-channels-reconcile/runner.ts:
// classificação de webhook_health (ok/broken/unknown) por janela de tempo,
// reconciliação de status Evolution com a API real (conectado/desconectado/
// erro de rede -- sem mascarar status), isolamento de erro por canal, e o
// critério de aceite central da Fase 5: genericidade total (nenhum
// tenant/channel/instância hardcoded no runner NEM no mock deste teste --
// ver "genericidade" abaixo). Mesmo harness Deno (createClient real +
// installFetchMock) usado pelos demais arquivos desta pasta -- ver
// docs/TESTING.md ("Edge functions (Deno) — deno test"); NÃO um arquivo
// Vitest (vitest.config.ts só cobre src/**, e este módulo importa de esm.sh).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { runMessagingChannelsReconcile } from "../messaging-channels-reconcile/runner.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const HOUR_MS = 60 * 60 * 1000;

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function stripOp(raw: string | null): string {
  return raw?.replace(/^[a-z.]+\./, "") ?? "";
}

interface ChannelRowState {
  id: string;
  tenant_id: string;
  type: string;
  provider_slug: string;
  status: string;
  config: Record<string, unknown>;
  created_at: string;
  webhook_health: string | null;
  webhook_health_checked_at: string | null;
  status_message: string | null;
  last_connected_at: string | null;
  webhook_token: string | null;
}

interface WebhookEventRow {
  channel_id: string;
  processed: boolean;
  created_at: string;
}

interface EvolutionApiBehavior {
  networkError?: boolean;
  status?: number;
  body?: unknown;
}

interface ZappazApiBehavior {
  networkError?: boolean;
  status?: number;
}

interface MockState {
  channels: ChannelRowState[];
  webhookEvents: WebhookEventRow[];
  secretsByTenant: Record<string, Record<string, string>>;
  evolutionApiByUrl: Record<string, EvolutionApiBehavior>;
  zappazSessionBySessionId: Record<string, ZappazApiBehavior>;
  zappazWebhookRegistrations: string[];
  zappazWebhookShouldFail: boolean;
  webhookHealthQueryShouldFail: Set<string>;
  channelPatches: Array<{ channelId: string; body: Record<string, unknown> }>;
}

function defaultState(): MockState {
  return {
    channels: [],
    webhookEvents: [],
    secretsByTenant: {},
    evolutionApiByUrl: {},
    zappazSessionBySessionId: {},
    zappazWebhookRegistrations: [],
    zappazWebhookShouldFail: false,
    webhookHealthQueryShouldFail: new Set(),
    channelPatches: [],
  };
}

function makeChannel(overrides: Partial<ChannelRowState> & { id: string }): ChannelRowState {
  return {
    tenant_id: "tenant-1",
    type: "whatsapp",
    provider_slug: "zapi",
    status: "connected",
    config: {},
    created_at: hoursAgoIso(24 * 30), // 30 dias -- "canal antigo" por padrão
    webhook_health: "unknown",
    webhook_health_checked_at: null,
    status_message: null,
    last_connected_at: null,
    webhook_token: null,
    ...overrides,
  };
}

/**
 * Mock genérico: TODO lookup abaixo resolve por `state.channels`/
 * `state.evolutionApiByUrl`/etc, nunca por `if (id === "...")`. É o que
 * torna o teste de "genericidade" (mais abaixo) uma prova de verdade -- o
 * MESMO router, sem edição, atende qualquer canal novo adicionado a
 * `state.channels`.
 */
function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;

    // -------- channels: leitura do lote (loadActiveChannels) --------
    if (r.pathname === "/rest/v1/channels" && r.method === "GET") {
      if (sp.get("status") !== "neq.disabled") {
        throw new Error(`GET channels esperava status=neq.disabled, veio ${sp.get("status")}`);
      }
      const limit = Number(sp.get("limit") ?? "200");
      return jsonResponse(200, state.channels.slice(0, limit));
    }

    // -------- channels: PATCH (webhook_health e/ou status Evolution) --------
    if (r.pathname === "/rest/v1/channels" && r.method === "PATCH") {
      const id = stripOp(sp.get("id"));
      const row = state.channels.find((c) => c.id === id);
      if (!row) return jsonResponse(404, null);
      const body = r.bodyJson as Record<string, unknown>;
      state.channelPatches.push({ channelId: id, body });
      Object.assign(row, body);
      return new Response(null, { status: 204 });
    }

    // -------- messaging_webhook_events: contagem (computeWebhookHealth) --------
    if (r.pathname === "/rest/v1/messaging_webhook_events" && r.method === "HEAD") {
      const channelId = stripOp(sp.get("channel_id"));
      if (state.webhookHealthQueryShouldFail.has(channelId)) {
        // Fetch rejeitando (não uma resposta HTTP de erro) -- mesmo primitivo
        // já provado em evolution-client.test.ts ("falha de rede"): o await
        // em computeWebhookHealth propaga a exceção, sem depender de como
        // postgrest-js interpretaria um corpo de erro numa resposta HEAD.
        throw new TypeError("network down (messaging_webhook_events)");
      }
      // computeWebhookHealth faz DUAS contagens distintas, com filtros
      // DIFERENTES de propósito:
      //  1. COM created_at=gte.<cutoff> E processed=eq.true -> "processou
      //     alguma coisa na janela?" (ok)
      //  2. SEM recorte de tempo e SEM filtro de processed -> "chegou a
      //     RECEBER alguma coisa algum dia?" (separa `broken` = recebia e
      //     parou de `silent` = nunca recebeu nada).
      // A segunda não pode filtrar por processed: um canal que recebe webhook
      // mas falha em processar TODOS eles é o caso mais grave que existe, e
      // com o filtro ele contava zero e era rotulado `silent` ("nunca
      // recebeu") — exatamente o diagnóstico invertido.
      const sinceRaw = sp.get("created_at");
      if (sinceRaw !== null && !sinceRaw.startsWith("gte.")) {
        throw new Error(
          `HEAD messaging_webhook_events: created_at, quando presente, tem que ser gte.<iso>; veio ${sinceRaw}`,
        );
      }
      const since = sinceRaw ? new Date(stripOp(sinceRaw)) : null;
      const processedFilter = sp.get("processed");
      if (since !== null && processedFilter !== "eq.true") {
        throw new Error(
          `HEAD messaging_webhook_events (janela) esperava processed=eq.true, veio ${processedFilter}`,
        );
      }
      if (since === null && processedFilter !== null) {
        throw new Error(
          `HEAD messaging_webhook_events (histórica) não pode filtrar processed, veio ${processedFilter}`,
        );
      }
      const count = state.webhookEvents.filter(
        (e) =>
          e.channel_id === channelId &&
          (since === null || (e.processed && new Date(e.created_at) >= since)),
      ).length;
      return new Response(null, { status: 200, headers: { "content-range": `*/${count}` } });
    }

    // -------- integration_secrets: credenciais Evolution --------
    if (r.pathname === "/rest/v1/integration_secrets" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const creds = state.secretsByTenant[tenantId] ?? {};
      return jsonResponse(
        200,
        Object.entries(creds).map(([key, value]) => ({ key, value })),
      );
    }

    // -------- Evolution Go: GET /instance/status --------
    if (r.pathname.endsWith("/instance/status") && r.method === "GET") {
      const apiUrl = r.url.replace("/instance/status", "");
      const behavior = state.evolutionApiByUrl[apiUrl];
      if (!behavior) throw new Error(`sem comportamento Evolution configurado para ${apiUrl}`);
      if (behavior.networkError) throw new TypeError("network down");
      return jsonResponse(behavior.status ?? 200, behavior.body ?? { data: { Connected: false } });
    }

    // -------- Zappaz: POST /session/{id}/webhook (re-registro) --------
    if (/\/api\/v1\/session\/[^/]+\/webhook$/.test(r.pathname) && r.method === "POST") {
      if (state.zappazWebhookShouldFail) return jsonResponse(500, { error: "down" });
      const url = (r.bodyJson as { url?: string } | undefined)?.url ?? "";
      state.zappazWebhookRegistrations.push(url);
      return jsonResponse(200, { ok: true });
    }

    // -------- Zappaz: GET /session/{id} (checagem de sessão ao vivo) --------
    if (/\/api\/v1\/session\/[^/]+$/.test(r.pathname) && r.method === "GET") {
      const sessionId = r.pathname.split("/").pop() ?? "";
      const behavior = state.zappazSessionBySessionId[sessionId];
      if (!behavior) throw new Error(`sem comportamento Zappaz configurado para ${sessionId}`);
      if (behavior.networkError) throw new TypeError("network down");
      return jsonResponse(behavior.status ?? 200, { data: { connected: true } });
    }

    return undefined;
  };
}

const TEST_SUPABASE_URL = BASE_ENV.SUPABASE_URL;

async function run(state: MockState, limit?: number) {
  const uninstall = installFetchMock(router(state));
  try {
    return await runMessagingChannelsReconcile(
      { admin: newAdminClient(), supabaseUrl: TEST_SUPABASE_URL },
      { limit },
    );
  } finally {
    uninstall();
  }
}

// -------------------- webhook_health --------------------

Deno.test("webhook_health", async (t) => {
  await t.step("evento processado recente -> 'ok'", async () => {
    const state = defaultState();
    const chan = makeChannel({ id: "chan-ok-1", webhook_health: "unknown" });
    state.channels.push(chan);
    state.webhookEvents.push({ channel_id: chan.id, processed: true, created_at: hoursAgoIso(1) });

    const summary = await run(state);

    if (chan.webhook_health !== "ok") {
      throw new Error(`esperava webhook_health='ok', veio ${chan.webhook_health}`);
    }
    if (!chan.webhook_health_checked_at) {
      throw new Error("webhook_health_checked_at deveria estar preenchido");
    }
    if (summary.webhookHealthChanged !== 1) {
      throw new Error(`esperava webhookHealthChanged=1, veio ${summary.webhookHealthChanged}`);
    }
    if (summary.channelsProcessed !== 1) {
      throw new Error(`esperava channelsProcessed=1, veio ${summary.channelsProcessed}`);
    }
  });

  await t.step(
    "canal antigo sem evento recente -> 'broken' (evento fora da janela não conta)",
    async () => {
      const state = defaultState();
      const chan = makeChannel({
        id: "chan-broken-1",
        webhook_health: "ok",
        created_at: hoursAgoIso(24 * 10),
      });
      state.channels.push(chan);
      // Evento processado existe, mas fora da janela de 72h -- não deve contar.
      state.webhookEvents.push({
        channel_id: chan.id,
        processed: true,
        created_at: hoursAgoIso(96),
      });

      const summary = await run(state);

      if (chan.webhook_health !== "broken") {
        throw new Error(
          `esperava webhook_health='broken', veio ${chan.webhook_health}`,
        );
      }
      if (summary.webhookHealthChanged !== 1) {
        throw new Error(
          `esperava webhookHealthChanged=1 (mudou de 'ok' para 'broken'), veio ${summary.webhookHealthChanged}`,
        );
      }
    },
  );

  await t.step("canal antigo que NUNCA recebeu evento -> 'silent' (não 'broken')", async () => {
    const state = defaultState();
    // Mesma idade do canal do teste anterior; a ÚNICA diferença é não haver
    // nenhum evento na história. Sem essa separação os dois casos colapsavam em
    // 'broken', que foi o que deixou os 6 canais de produção marcados como
    // quebrados com webhook_consecutive_failures = 0.
    const chan = makeChannel({
      id: "chan-silent-1",
      webhook_health: "ok",
      created_at: hoursAgoIso(24 * 10),
    });
    state.channels.push(chan);

    const summary = await run(state);

    if (chan.webhook_health !== "silent") {
      throw new Error(`esperava webhook_health='silent', veio ${chan.webhook_health}`);
    }
    if (summary.webhookHealthChanged !== 1) {
      throw new Error(
        `esperava webhookHealthChanged=1 (de 'ok' para 'silent'), veio ${summary.webhookHealthChanged}`,
      );
    }
  });

  await t.step("canal que recebeu mas NUNCA processou -> 'broken' (não 'silent')", async () => {
    // O pior caso operacional possível: o webhook CHEGA (o provider está
    // configurado certo, tem tráfego real), mas nenhum evento consegue ser
    // processado. Com a contagem histórica filtrando `processed=true` esse
    // canal contava zero e virava `silent` = "nunca recebeu nada, não é
    // falha" — o diagnóstico exatamente invertido, mandando o operador
    // ignorar o único canal que está de fato quebrado.
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-nunca-processou",
      webhook_health: "ok",
      created_at: hoursAgoIso(24 * 10),
    });
    state.channels.push(chan);
    state.webhookEvents.push({
      channel_id: chan.id,
      processed: false,
      created_at: hoursAgoIso(48),
    });
    state.webhookEvents.push({ channel_id: chan.id, processed: false, created_at: hoursAgoIso(2) });

    await run(state);

    if (chan.webhook_health !== "broken") {
      throw new Error(`esperava webhook_health='broken', veio ${chan.webhook_health}`);
    }
  });

  await t.step("canal recém-criado (dentro da janela) sem evento ainda -> 'unknown'", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-new-1",
      created_at: hoursAgoIso(2),
      webhook_health: "unknown",
    });
    state.channels.push(chan);

    await run(state);

    if (chan.webhook_health !== "unknown") {
      throw new Error(`esperava webhook_health='unknown', veio ${chan.webhook_health}`);
    }
  });
});

// -------------------- status Evolution --------------------

Deno.test("status Evolution", async (t) => {
  await t.step(
    "reconectado: status/last_connected_at atualizados, status_message limpo",
    async () => {
      const state = defaultState();
      const apiUrl = "https://evo-recon.example.com";
      // status inicial 'disconnected' (não 'waiting_qr'/'connecting') --
      // esses dois são propriedade do watchdog e o reconcile agora os pula
      // (ver EVOLUTION_TRANSITIONAL_STATUSES em runner.ts e a suíte de testes
      // "estados transitórios" abaixo, que cobre esse skip especificamente).
      const chan = makeChannel({
        id: "chan-evo-recon",
        tenant_id: "tenant-evo-recon",
        provider_slug: "evolution",
        status: "disconnected",
        status_message: "falha transitória anterior",
        config: { api_url: apiUrl, instance_name: "inst-recon" },
      });
      state.channels.push(chan);
      state.secretsByTenant["tenant-evo-recon"] = { api_key: "key-1", instance_token: "tok-1" };
      state.evolutionApiByUrl[apiUrl] = { status: 200, body: { data: { Connected: true } } };

      const summary = await run(state);

      if (chan.status !== "connected") {
        throw new Error(
          `esperava status='connected', veio ${chan.status}`,
        );
      }
      if (!chan.last_connected_at) throw new Error("last_connected_at deveria estar preenchido");
      if (chan.status_message !== null) {
        throw new Error(
          `esperava status_message limpo, veio ${chan.status_message}`,
        );
      }
      if (summary.statusChanged !== 1) {
        throw new Error(
          `esperava statusChanged=1, veio ${summary.statusChanged}`,
        );
      }
    },
  );

  await t.step(
    "erro de rede na checagem: status_message atualizado, status NÃO muda (patch não inclui a chave status)",
    async () => {
      const state = defaultState();
      const apiUrl = "https://evo-erro.example.com";
      const chan = makeChannel({
        id: "chan-evo-erro",
        tenant_id: "tenant-evo-erro",
        provider_slug: "evolution",
        status: "connected",
        config: { api_url: apiUrl, instance_name: "inst-erro" },
      });
      state.channels.push(chan);
      state.secretsByTenant["tenant-evo-erro"] = { api_key: "key-2", instance_token: "tok-2" };
      state.evolutionApiByUrl[apiUrl] = { networkError: true };

      const summary = await run(state);

      if (chan.status !== "connected") {
        throw new Error(`status NÃO deveria mudar numa falha transitória, veio ${chan.status}`);
      }
      if (!chan.status_message) {
        throw new Error("status_message deveria estar preenchido com o erro");
      }
      if (summary.statusChanged !== 0) {
        throw new Error(`esperava statusChanged=0, veio ${summary.statusChanged}`);
      }

      // Garantia real (não só o valor final): NENHUM dos PATCHes enviados ao
      // banco para este canal (webhook_health E status Evolution) pode
      // conter a chave "status" -- reenviar o mesmo valor mascararia uma
      // escrita concorrente (ex.: o webhook confirmando reconexão) que
      // tivesse acontecido entre a leitura e este UPDATE. Usar `.filter`
      // (não `.find`) é o que importa aqui: este canal recebe 2 PATCHes (1
      // de webhook_health, 1 de status Evolution) -- pegar só o primeiro
      // checaria o patch errado e aprovaria a regressão vaziamente.
      const evoPatches = state.channelPatches.filter((p) => p.channelId === "chan-evo-erro");
      if (evoPatches.length === 0) throw new Error("nenhum PATCH registrado para o canal");
      if (evoPatches.some((p) => "status" in p.body)) {
        throw new Error(
          `nenhum patch de erro deveria conter a chave "status": ${JSON.stringify(evoPatches)}`,
        );
      }
    },
  );
});

// -------------------- estados transitórios (propriedade do watchdog) --------------------

Deno.test("status Evolution transitório (waiting_qr/connecting) não é tocado pelo reconcile", async (t) => {
  await t.step(
    "waiting_qr: reconcileEvolutionStatus não é chamado, canal fica intocado",
    async () => {
      const state = defaultState();
      const apiUrl = "https://evo-waiting-qr.example.com";
      const chan = makeChannel({
        id: "chan-evo-waiting-qr",
        tenant_id: "tenant-evo-waiting-qr",
        provider_slug: "evolution",
        status: "waiting_qr",
        status_message: "aguardando leitura do QR code",
        config: {
          api_url: apiUrl,
          instance_name: "inst-waiting-qr",
          qr_code: "base64-qr-pendente",
        },
      });
      state.channels.push(chan);
      state.secretsByTenant["tenant-evo-waiting-qr"] = {
        api_key: "key-1",
        instance_token: "tok-1",
      };
      // Nenhum comportamento configurado em evolutionApiByUrl -- se o reconcile
      // chamar checkEvolutionInstanceStatus mesmo assim, o router lança
      // ("sem comportamento Evolution configurado"), o que faria este teste
      // falhar por erro registrado em summary.errors (verificado abaixo).

      const summary = await run(state);

      if (chan.status !== "waiting_qr") {
        throw new Error(`status não deveria mudar (canal transitório), veio ${chan.status}`);
      }
      if (chan.config.qr_code !== "base64-qr-pendente") {
        throw new Error("QR code pendente não deveria ser sobrescrito/apagado");
      }
      if (summary.statusChanged !== 0) {
        throw new Error(
          `esperava statusChanged=0, veio ${summary.statusChanged}`,
        );
      }
      if (summary.skippedTransitional !== 1) {
        throw new Error(`esperava skippedTransitional=1, veio ${summary.skippedTransitional}`);
      }
      if (summary.errors.length !== 0) {
        throw new Error(
          `não esperava erros: ${JSON.stringify(summary.errors)}`,
        );
      }

      // Nenhum PATCH de status Evolution foi emitido para este canal -- só o
      // PATCH de webhook_health (que roda incondicionalmente para todo canal).
      const patches = state.channelPatches.filter((p) => p.channelId === chan.id);
      if (patches.some((p) => "status" in p.body)) {
        throw new Error(
          `nenhum patch deveria conter a chave "status" para canal transitório: ${
            JSON.stringify(patches)
          }`,
        );
      }
    },
  );

  await t.step("connecting: mesmo comportamento de skip", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-evo-connecting",
      tenant_id: "tenant-evo-connecting",
      provider_slug: "evolution",
      status: "connecting",
      config: { api_url: "https://evo-connecting.example.com", instance_name: "inst-connecting" },
    });
    state.channels.push(chan);
    state.secretsByTenant["tenant-evo-connecting"] = { api_key: "key-2", instance_token: "tok-2" };

    const summary = await run(state);

    if (chan.status !== "connecting") {
      throw new Error(`status não deveria mudar, veio ${chan.status}`);
    }
    if (summary.skippedTransitional !== 1) {
      throw new Error(`esperava skippedTransitional=1, veio ${summary.skippedTransitional}`);
    }
    if (summary.errors.length !== 0) {
      throw new Error(`não esperava erros: ${JSON.stringify(summary.errors)}`);
    }
  });

  await t.step(
    "canal Evolution em status não-transitório (ex.: disconnected) segue reconciliado normalmente",
    async () => {
      const state = defaultState();
      const apiUrl = "https://evo-nao-transitorio.example.com";
      const chan = makeChannel({
        id: "chan-evo-nao-transitorio",
        tenant_id: "tenant-evo-nao-transitorio",
        provider_slug: "evolution",
        status: "disconnected",
        config: { api_url: apiUrl, instance_name: "inst-nao-transitorio" },
      });
      state.channels.push(chan);
      state.secretsByTenant["tenant-evo-nao-transitorio"] = {
        api_key: "key-3",
        instance_token: "tok-3",
      };
      state.evolutionApiByUrl[apiUrl] = { status: 200, body: { data: { Connected: true } } };

      const summary = await run(state);

      if (chan.status !== "connected") {
        throw new Error(`esperava status='connected', veio ${chan.status}`);
      }
      if (summary.skippedTransitional !== 0) {
        throw new Error(
          `esperava skippedTransitional=0 para canal não-transitório, veio ${summary.skippedTransitional}`,
        );
      }
      if (summary.statusChanged !== 1) {
        throw new Error(`esperava statusChanged=1, veio ${summary.statusChanged}`);
      }
    },
  );
});

// -------------------- isolamento de erro --------------------

Deno.test("erro em 1 canal não aborta o processamento dos demais", async () => {
  const state = defaultState();
  const broken = makeChannel({ id: "chan-query-falha", webhook_health: "unknown" });
  const healthy = makeChannel({ id: "chan-saudavel", webhook_health: "unknown" });
  state.channels.push(broken, healthy);
  state.webhookHealthQueryShouldFail.add(broken.id);
  state.webhookEvents.push({ channel_id: healthy.id, processed: true, created_at: hoursAgoIso(1) });

  const summary = await run(state);

  if (summary.channelsProcessed !== 2) {
    throw new Error(`esperava channelsProcessed=2, veio ${summary.channelsProcessed}`);
  }
  if (!summary.errors.some((e) => e.startsWith(`${broken.id} (webhook_health)`))) {
    throw new Error(
      `esperava erro registrado para ${broken.id}: ${JSON.stringify(summary.errors)}`,
    );
  }
  if (broken.webhook_health !== "unknown") {
    throw new Error(
      `canal com falha não deveria ter webhook_health alterado, veio ${broken.webhook_health}`,
    );
  }
  if (healthy.webhook_health !== "ok") {
    throw new Error(
      `canal saudável deveria seguir processado normalmente, veio ${healthy.webhook_health}`,
    );
  }
});

// -------------------- genericidade (critério de aceite da Fase 5) --------------------

Deno.test(
  "genericidade: canal Evolution novo (id/tenant nunca vistos em nenhum outro teste ou no runner) é monitorado sem qualquer alteração de código",
  async () => {
    const state = defaultState();
    // IDs deliberadamente arbitrários -- não aparecem em runner.ts, em
    // nenhum outro teste deste arquivo, nem no router acima (que resolve
    // tudo por lookup em `state`, nunca por comparação literal de id). Se
    // este teste passar, é porque loadActiveChannels + o branch
    // `provider_slug === "evolution"` bastam para monitorar um canal criado
    // depois do deploy -- exatamente o critério de aceite do PRD.
    const apiUrl = "https://evo-simulando-deploy-novo.example.com";
    const chan = makeChannel({
      id: "chan-pos-deploy-9f3a",
      tenant_id: "tenant-pos-deploy-9f3a",
      provider_slug: "evolution",
      status: "disconnected",
      created_at: hoursAgoIso(1), // canal recém-criado
      config: { api_url: apiUrl, instance_name: "inst-pos-deploy" },
    });
    state.channels.push(chan);
    state.secretsByTenant["tenant-pos-deploy-9f3a"] = {
      api_key: "key-novo",
      instance_token: "tok-novo",
    };
    state.evolutionApiByUrl[apiUrl] = { status: 200, body: { data: { Connected: true } } };

    const summary = await run(state);

    // webhook_health: canal recém-criado, sem evento ainda -> 'unknown'.
    if (chan.webhook_health !== "unknown") {
      throw new Error(
        `esperava webhook_health='unknown' para canal novo, veio ${chan.webhook_health}`,
      );
    }
    // status Evolution: reconciliado com a API real, igual a qualquer outro canal Evolution.
    if (chan.status !== "connected") {
      throw new Error(`esperava status='connected', veio ${chan.status}`);
    }
    if (!chan.last_connected_at) throw new Error("last_connected_at deveria estar preenchido");
    if (summary.statusChanged !== 1) {
      throw new Error(`esperava statusChanged=1, veio ${summary.statusChanged}`);
    }
    if (summary.errors.length !== 0) {
      throw new Error(`não esperava erros: ${JSON.stringify(summary.errors)}`);
    }
  },
);

// -------------------- status Zappaz (checagem ao vivo) --------------------
//
// Até 2026-07-31 só Evolution tinha checagem ao vivo: um canal Zappaz com a
// sessão do WhatsApp caída seguia `connected` e a UI mostrava "Webhook ok"
// enquanto o último inbound estivesse dentro da janela de 72h.

Deno.test("status Zappaz", async (t) => {
  await t.step("sessão viva -> status 'connected' e status_message limpo", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-zap-ok",
      provider_slug: "zappaz",
      status: "disconnected",
      config: { session_id: "sess-1" },
      status_message: "erro antigo",
    });
    state.channels.push(chan);
    state.webhookEvents.push({ channel_id: chan.id, processed: true, created_at: hoursAgoIso(1) });
    state.secretsByTenant[chan.tenant_id] = { api_key: "key-1" };
    state.zappazSessionBySessionId["sess-1"] = { status: 200 };

    const summary = await run(state);

    if (chan.status !== "connected") throw new Error(`esperava connected, veio ${chan.status}`);
    if (chan.status_message !== null) throw new Error("status_message deveria ter sido limpo");
    if (summary.statusChanged !== 1) {
      throw new Error(`esperava statusChanged=1, veio ${summary.statusChanged}`);
    }
  });

  await t.step(
    "sessão inexistente (404) -> status 'disconnected' com motivo em PT-BR",
    async () => {
      const state = defaultState();
      const chan = makeChannel({
        id: "chan-zap-404",
        provider_slug: "zappaz",
        status: "connected",
        config: { session_id: "sess-morta" },
      });
      state.channels.push(chan);
      state.webhookEvents.push({
        channel_id: chan.id,
        processed: true,
        created_at: hoursAgoIso(1),
      });
      state.secretsByTenant[chan.tenant_id] = { api_key: "key-1" };
      state.zappazSessionBySessionId["sess-morta"] = { status: 404 };

      await run(state);

      if (chan.status !== "disconnected") {
        throw new Error(
          `esperava disconnected, veio ${chan.status}`,
        );
      }
      if (!chan.status_message || /abort|timeout/i.test(chan.status_message)) {
        throw new Error(`status_message inesperado: ${chan.status_message}`);
      }
    },
  );

  await t.step("falha de rede -> NÃO sobrescreve status (só status_message)", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-zap-net",
      provider_slug: "zappaz",
      status: "connected",
      config: { session_id: "sess-net" },
    });
    state.channels.push(chan);
    state.webhookEvents.push({ channel_id: chan.id, processed: true, created_at: hoursAgoIso(1) });
    state.secretsByTenant[chan.tenant_id] = { api_key: "key-1" };
    state.zappazSessionBySessionId["sess-net"] = { networkError: true };

    await run(state);

    if (chan.status !== "connected") throw new Error(`status não podia mudar, veio ${chan.status}`);
    const patch = state.channelPatches.find(
      (p) => p.channelId === chan.id && "status_message" in p.body,
    );
    if (!patch) throw new Error("esperava patch com status_message");
    if ("status" in patch.body) {
      throw new Error("patch de falha transitória não pode conter 'status'");
    }
  });

  await t.step("sessão viva mas canal silencioso -> reregistra a URL de webhook", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-zap-silent",
      provider_slug: "zappaz",
      status: "connected",
      created_at: hoursAgoIso(24 * 10),
      config: { session_id: "sess-silent" },
      webhook_token: "tok-1",
    });
    state.channels.push(chan);
    state.secretsByTenant[chan.tenant_id] = { api_key: "key-1" };
    state.zappazSessionBySessionId["sess-silent"] = { status: 200 };

    await run(state);

    if (state.zappazWebhookRegistrations.length !== 1) {
      throw new Error(`esperava 1 re-registro, veio ${state.zappazWebhookRegistrations.length}`);
    }
    const url = state.zappazWebhookRegistrations[0];
    if (!url.includes(chan.id) || !url.includes("token=tok-1")) {
      throw new Error(`URL de webhook inesperada: ${url}`);
    }
  });

  await t.step("canal com tráfego recente NÃO reregistra webhook", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-zap-busy",
      provider_slug: "zappaz",
      status: "connected",
      config: { session_id: "sess-busy" },
      webhook_token: "tok-2",
    });
    state.channels.push(chan);
    state.webhookEvents.push({ channel_id: chan.id, processed: true, created_at: hoursAgoIso(1) });
    state.secretsByTenant[chan.tenant_id] = { api_key: "key-1" };
    state.zappazSessionBySessionId["sess-busy"] = { status: 200 };

    await run(state);

    if (state.zappazWebhookRegistrations.length !== 0) {
      throw new Error("canal saudável não deveria reregistrar webhook");
    }
  });

  await t.step("credenciais incompletas -> 'disconnected' sem chamar a Zappaz", async () => {
    const state = defaultState();
    const chan = makeChannel({
      id: "chan-zap-nocred",
      provider_slug: "zappaz",
      status: "connected",
      config: {},
    });
    state.channels.push(chan);
    state.webhookEvents.push({ channel_id: chan.id, processed: true, created_at: hoursAgoIso(1) });

    await run(state);

    if (chan.status !== "disconnected") {
      throw new Error(`esperava disconnected, veio ${chan.status}`);
    }
  });
});
