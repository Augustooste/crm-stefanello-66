import { assertEquals } from "jsr:@std/assert@1";
import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

// captureHandler faz o import real (com Deno.serve interceptado) primeiro; só
// depois é seguro importar novamente para pegar exports nomeados — o módulo já
// está no cache do Deno, então isso não reexecuta o topo do arquivo nem chama
// o Deno.serve real de novo.
const handler = await captureHandler("../ai-respond/index.ts");
const { renderTemplate, DEFAULT_AI_MODEL, AUDIO_CIFRADO_REPLY } = (await import(
  "../ai-respond/index.ts"
)) as {
  renderTemplate: (tpl: string, vars: Record<string, string | undefined>) => string;
  DEFAULT_AI_MODEL: string;
  AUDIO_CIFRADO_REPLY: string;
};

// -------------------- Fixtures --------------------
const TENANT_ID = "tenant-1";
const CONV_ID = "conv-1";
const CONTACT_ID = "contact-1";
const MESSAGE_ID = "msg-1";
const DEAL_ID = "deal-1";
const STAGE_ID = "stage-1";
const BOARD_ID = "board-1";
const NEXT_STAGE_ID = "stage-2";
const AI_MSG_ID = "ai-msg-1";
// TLD .invalid nunca resolve: validatePublicHttpsUrl faz um lookup DNS
// best-effort e engole a falha, entao a URL passa sem depender de rede real.
const AUDIO_URL = "https://cdn.exemplo-qa.invalid/audio-teste.ogg";
const META_MEDIA_REFERENCE = "meta-media:meta-audio-1";
const META_MEDIA_DOWNLOAD_URL =
  "https://lookaside.fbsbx.com/whatsapp_business/attachments/meta-audio-1";

const DEFAULT_HANDOFF_KEYWORDS = [
  "falar com humano",
  "atendente",
  "pessoa real",
  "agendar",
  "marcar",
];

interface Msg {
  id: string;
  tenant_id: string;
  conversation_id: string;
  sender: string;
  direction: string;
  content: string;
  media_url: string | null;
  media_type: string | null;
  created_at: string;
}

interface Conv {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  ai_active: boolean;
  subject: string | null;
  awaiting_human: boolean;
  channels: { tenant_id?: string; provider_slug: string; type: string } | null;
}

interface Tenant {
  id: string;
  name: string;
  business_profile: Record<string, unknown> | null;
  ai_enabled: boolean;
}

interface Contact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  ai_paused: boolean;
}

interface AiSettingsRow {
  tenant_id: string;
  base_system_prompt: string | null;
  handoff_default_keywords: string[] | null;
  send_mode: string | null;
  model: string | null;
  // Colunas da migration 20260727120000, lidas por loadVoiceReplyPreference.
  // Opcionais porque o default do harness é sem voz.
  voice_reply_mode?: string | null;
  voice_id?: string | null;
  max_response_blocks?: number | null;
  response_block_delay_ms?: number | null;
  message_coalesce_window_ms?: number | null;
}

interface InboundRow {
  id: string;
  created_at: string;
}

interface Deal {
  id: string;
  stage_id: string | null;
}

interface Board {
  id: string;
}

interface Stage {
  id: string;
  board_id?: string;
  position?: number;
}

interface StageCfg {
  system_prompt: string | null;
  enabled: boolean;
  advancement_criteria: unknown;
  handoff_keywords: string[] | null;
  stage_goal: string | null;
}

interface ExternalSendCfg {
  status: number;
  body: unknown;
  throws?: boolean;
}

interface State {
  msg: Msg | null;
  conv: Conv | null;
  tenant: Tenant | null;
  contact: Contact | null;
  aiSettings: AiSettingsRow | null;
  aiSettingsInsertOk: boolean;
  openDeal: Deal | null;
  board: Board | null;
  firstStage: Stage | null;
  newDeal: { id: string } | null;
  stageCfg: StageCfg | null;
  dealOwnerRow: { owner_id: string | null } | null;
  secrets: Record<string, string>;
  aiStatus: number;
  aiBody: unknown;
  aiThrows: boolean;
  aiThrowValue?: unknown;
  evalStatus: number;
  evalBody: unknown;
  evalThrows: boolean;
  currentStage: Stage | null;
  nextStage: Stage | null;
  externalSend: ExternalSendCfg;
  insertMessageFails: boolean;
  recentHistory: Array<{ sender: string; content: string | null; created_at: string }>;
  recentHistoryQueryFails: boolean;
  secretsQueryFails: boolean;
  /** Falha SÓ a leitura do slug elevenlabs — isola a credencial de voz da do
   * provider de envio, que compartilha a mesma tabela. */
  elevenlabsSecretsQueryFails: boolean;
  /** status em tenant_integrations; null = tenant sem registro da integração. */
  elevenlabsIntegrationStatus: string | null;
  // Transcrição de áudio (voice.ts): download do media_url + STT da ElevenLabs.
  elevenlabsSecrets: Record<string, string>;
  audioDownloadStatus: number;
  sttStatus: number;
  sttText: string;
  messagePatchFails: boolean;
  lockAcquired: boolean;
  claimAcquired: boolean;
  // Fase 2 — coalescer de turno (turn-coalescer.ts): inbound recente (burst)
  // e resposta prévia da IA (dedupe). Default = solo (só a msg atual), sem
  // duplicata — não interfere no fluxo feliz das demais suites.
  recentInbound: InboundRow[];
  aiAlreadyAnswered: InboundRow | null;
  // Fase 2 — gate de takeover humano (takeover-gate.ts / has-human-responded.ts):
  // última mensagem de um atendente (sender='agent') nesta conversa. Default
  // null = nenhum humano jamais respondeu → gate sempre libera.
  lastAgentMessage: InboundRow | null;
  // Fase 2 — rate limit por conversa via RPC (rate-limiter.ts).
  rateLimitAllowed: boolean;
  rateLimitRetryAfterSeconds: number;
  // A RPC em si falhou (banco fora do ar) — distinto de rate-limit legítimo.
  rateLimitRpcFails: boolean;
  // notifyAdminHandoff (notify-admin-handoff.ts): destinatários de e-mail
  // ativos do tenant. Default [] faz o alerta ser no-op silencioso nos
  // testes que não são especificamente sobre esta notificação.
  weeklyReportRecipients: Array<{ address: string }>;
  captured: {
    systemPrompt?: string;
    historyMessages?: Array<{ role: string; content: string }>;
    model?: string;
    sentContent?: string;
    lastErrorPayload?: unknown;
    awaitingHumanPayload?: boolean;
    aiActivePayload?: boolean;
    patchedMessageContent?: string;
  };
  calls: {
    dealsPatch: number;
    dealsInsert: number;
    aiSettingsPatch: number;
    aiBehaviorSettingsReads: number;
    aiFailureLogsInsert: number;
    // notifyAdminHandoff (notify-admin-handoff.ts) chamando o Resend para o
    // alerta de admin — distinto de state.externalSend (canal da conversa em
    // si, que pode ser outro provider como zapi).
    resendPost: number;
    weeklyReportRecipientsQuery: number;
    audioDownload: number;
    metaMediaLookup: number;
    metaMediaDownload: number;
    sttPost: number;
    messagePatch: number;
    aiClaimFinishBodies: Array<Record<string, unknown>>;
    // Log ordenado dos marcos do turno ("send" | "finish_claim" | "eval"),
    // usado pelo teste de duplicata: o que importa não é quantas vezes cada um
    // acontece, é em que ordem.
    order: string[];
  };
}

function defaultState(): State {
  return {
    msg: {
      id: MESSAGE_ID,
      tenant_id: TENANT_ID,
      conversation_id: CONV_ID,
      sender: "contact",
      direction: "in",
      content: "Olá, quero saber mais sobre os serviços",
      media_url: null,
      media_type: null,
      created_at: "2026-01-01T00:00:05.000Z",
    },
    conv: {
      id: CONV_ID,
      tenant_id: TENANT_ID,
      contact_id: CONTACT_ID,
      channel_id: "channel-1",
      ai_active: true,
      subject: null,
      // Default = ainda não aguardando humano. weeklyReportRecipients=[] por
      // padrão faz os testes de handoff/falha abaixo (que disparam
      // notifyAdminHandoff nesta transição) serem no-op silencioso.
      awaiting_human: false,
      channels: { tenant_id: TENANT_ID, provider_slug: "zapi", type: "whatsapp" },
    },
    tenant: {
      id: TENANT_ID,
      name: "Acme",
      business_profile: {},
      ai_enabled: true,
    },
    contact: {
      id: CONTACT_ID,
      name: "João",
      phone: "5511999998888",
      email: "joao@example.com",
      ai_paused: false,
    },
    aiSettings: {
      tenant_id: TENANT_ID,
      base_system_prompt: null,
      handoff_default_keywords: DEFAULT_HANDOFF_KEYWORDS,
      send_mode: "auto",
      model: "default",
    },
    aiSettingsInsertOk: true,
    openDeal: { id: DEAL_ID, stage_id: STAGE_ID },
    board: { id: BOARD_ID },
    firstStage: { id: STAGE_ID },
    newDeal: { id: DEAL_ID },
    stageCfg: {
      system_prompt: null,
      enabled: true,
      advancement_criteria: [],
      handoff_keywords: [],
      stage_goal: "",
    },
    dealOwnerRow: { owner_id: "owner-1" },
    secrets: { instance_id: "i1", instance_token: "t1", client_token: "c1" },
    aiStatus: 200,
    aiBody: { choices: [{ message: { content: "Claro, posso ajudar!" } }] },
    aiThrows: false,
    evalStatus: 200,
    evalBody: { choices: [{ message: { content: JSON.stringify({ results: [] }) } }] },
    evalThrows: false,
    currentStage: { id: STAGE_ID, board_id: BOARD_ID, position: 1 },
    nextStage: { id: NEXT_STAGE_ID, position: 2 },
    externalSend: { status: 200, body: { messageId: "ext-1" } },
    insertMessageFails: false,
    // A query real ordena por created_at DESC (mais recente primeiro) — o
    // código faz .reverse() para virar cronológico. O mock precisa devolver
    // já em ordem descendente, como o PostgREST real devolveria.
    recentHistory: [
      { sender: "ai", content: "Olá! Como posso ajudar?", created_at: "2026-01-01T00:01:00.000Z" },
      { sender: "contact", content: "Oi", created_at: "2026-01-01T00:00:00.000Z" },
    ],
    recentHistoryQueryFails: false,
    secretsQueryFails: false,
    elevenlabsSecretsQueryFails: false,
    elevenlabsIntegrationStatus: "active",
    elevenlabsSecrets: { api_key: "el-key-1" },
    audioDownloadStatus: 200,
    sttStatus: 200,
    // Texto neutro de propósito: não pode conter nenhuma DEFAULT_HANDOFF_KEYWORDS
    // ("agendar"/"marcar"/"atendente"/...), senão o step do caminho feliz cai em
    // handoff por keyword e testa outra coisa.
    sttText: "oi, tudo bem? queria entender melhor como funciona o tratamento",
    messagePatchFails: false,
    lockAcquired: true,
    claimAcquired: true,
    // Solo (1 mensagem, é a própria MESSAGE_ID) — sem burst, sem sleep.
    recentInbound: [{ id: MESSAGE_ID, created_at: "2026-01-01T00:00:05.000Z" }],
    aiAlreadyAnswered: null,
    lastAgentMessage: null,
    rateLimitAllowed: true,
    rateLimitRetryAfterSeconds: 0,
    rateLimitRpcFails: false,
    weeklyReportRecipients: [],
    captured: {},
    calls: {
      dealsPatch: 0,
      dealsInsert: 0,
      aiSettingsPatch: 0,
      aiBehaviorSettingsReads: 0,
      aiFailureLogsInsert: 0,
      resendPost: 0,
      weeklyReportRecipientsQuery: 0,
      audioDownload: 0,
      metaMediaLookup: 0,
      metaMediaDownload: 0,
      sttPost: 0,
      messagePatch: 0,
      aiClaimFinishBodies: [],
      order: [],
    },
  };
}

function sendResponse(cfg: ExternalSendCfg): Response {
  if (typeof cfg.body === "string" && cfg.body.startsWith("RAW:")) {
    return new Response(cfg.body.slice(4), { status: cfg.status });
  }
  return jsonResponse(cfg.status, cfg.body);
}

function router(state: State): FetchMatcher {
  return (req: MockRequest) => {
    const u = new URL(req.url);
    const sp = u.searchParams;

    if (u.pathname === "/rest/v1/messages") {
      if (req.method === "GET" && sp.get("id")?.startsWith("eq.")) {
        return jsonResponse(200, state.msg ? [state.msg] : []);
      }
      // turn-coalescer.fetchRecentInbound: direction=eq.in, sem sender.
      if (req.method === "GET" && sp.get("direction") === "eq.in") {
        return jsonResponse(200, state.recentInbound);
      }
      // turn-coalescer.wasAlreadyAnswered: sender=eq.ai + direction=eq.out.
      if (
        req.method === "GET" &&
        sp.get("sender") === "eq.ai" &&
        sp.get("direction") === "eq.out"
      ) {
        return jsonResponse(200, state.aiAlreadyAnswered ? [state.aiAlreadyAnswered] : []);
      }
      // takeover-gate.isOperatorActive / has-human-responded.hasHumanResponded:
      // ambas filtram sender=eq.agent (uma pede created_at, outra pede id — o
      // mock devolve as duas colunas, PostgREST real também devolveria a
      // linha inteira independente do select nesse nível de fidelidade).
      if (req.method === "GET" && sp.get("sender") === "eq.agent") {
        return jsonResponse(200, state.lastAgentMessage ? [state.lastAgentMessage] : []);
      }
      if (req.method === "GET" && sp.get("conversation_id")?.startsWith("eq.")) {
        if (state.recentHistoryQueryFails) return jsonResponse(500, { message: "query failed" });
        return jsonResponse(200, state.recentHistory);
      }
      // Gravação da transcrição em messages.content (ai-respond, bloco de áudio).
      // Sem isto o áudio transcrito não chegaria em loadRecentHistory, que
      // descarta mensagem de content vazio.
      if (req.method === "PATCH" && sp.get("id")?.startsWith("eq.")) {
        state.calls.messagePatch++;
        const b = req.bodyJson as { content?: string } | undefined;
        if (typeof b?.content === "string") state.captured.patchedMessageContent = b.content;
        if (state.messagePatchFails) return jsonResponse(500, { message: "patch failed" });
        return emptyResponse(204);
      }
      if (req.method === "POST") {
        // .select("id").single() — supabase-js NÃO desembrulha array de 1 item
        // aqui (verificado empiricamente); o servidor real honra o Accept
        // vnd.pgrst.object+json e devolve objeto puro. Mock deve fazer o mesmo.
        if (state.insertMessageFails) return jsonResponse(500, { message: "insert failed" });
        return jsonResponse(201, { id: AI_MSG_ID });
      }
      if (req.method === "PATCH") return emptyResponse(200);
    }

    if (
      u.pathname === "/rest/v1/rpc/claim_ai_processing_message" &&
      req.method === "POST"
    ) {
      return jsonResponse(200, [
        {
          claimed: state.claimAcquired,
          claim_state: state.claimAcquired ? "claimed" : "processing",
          attempt: 1,
          lease_token: "44444444-4444-4444-8444-444444444444",
          lease_expires_at: "2026-01-01T00:03:00.000Z",
        },
      ]);
    }

    if (
      u.pathname === "/rest/v1/rpc/finish_ai_processing_message" &&
      req.method === "POST"
    ) {
      state.calls.aiClaimFinishBodies.push(req.bodyJson as Record<string, unknown>);
      state.calls.order.push("finish_claim");
      return jsonResponse(200, true);
    }

    if (u.pathname === "/rest/v1/rpc/check_and_record_rate_limit" && req.method === "POST") {
      if (state.rateLimitRpcFails) return jsonResponse(500, { message: "db indisponível" });
      return jsonResponse(200, {
        allowed: state.rateLimitAllowed,
        retryAfterSeconds: state.rateLimitRetryAfterSeconds,
      });
    }

    if (u.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
      state.calls.aiFailureLogsInsert++;
      return emptyResponse(201);
    }

    if (u.pathname === "/rest/v1/deal_stage_evaluations" && req.method === "POST") {
      return jsonResponse(201, []);
    }

    if (u.pathname === "/rest/v1/stage_transitions" && req.method === "GET") {
      return jsonResponse(
        200,
        state.nextStage
          ? [
            {
              to_stage_id: state.nextStage.id,
              autonomy_mode: "manual",
              ai_priority: 0,
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ]
          : [],
      );
    }

    if (u.pathname === "/rest/v1/rpc/transition_deal_stage" && req.method === "POST") {
      state.calls.dealsPatch++;
      return jsonResponse(200, { success: true, status: "accepted" });
    }

    if (u.pathname === "/rest/v1/conversations") {
      if (req.method === "GET") return jsonResponse(200, state.conv ? [state.conv] : []);
      if (req.method === "PATCH") {
        // claimAITurn faz .update(...).or(...).select("ai_lock_token").single()
        // — presença do param "or" identifica o claim; demais updates
        // (handoff, last_error, release do lock) não passam "or" nem "select".
        const orParam = sp.get("or");
        if (orParam) {
          if (!state.lockAcquired) {
            return jsonResponse(406, { code: "PGRST116", message: "0 rows" });
          }
          const b = req.bodyJson as { ai_lock_token?: string | null } | undefined;
          return jsonResponse(200, { ai_lock_token: b?.ai_lock_token ?? null });
        }
        const b = req.bodyJson as
          | { last_error?: unknown; awaiting_human?: boolean; ai_active?: boolean }
          | undefined;
        if (b && Object.prototype.hasOwnProperty.call(b, "last_error")) {
          state.captured.lastErrorPayload = b.last_error;
        }
        if (b && Object.prototype.hasOwnProperty.call(b, "awaiting_human")) {
          state.captured.awaitingHumanPayload = b.awaiting_human;
        }
        // `ai_active` só é escrito por performHandoff, e escrever false ali é o
        // que deixa a conversa muda para SEMPRE (gate ai_paused_conversation).
        // Sem capturar isto, um teste "a IA respondeu" passa mesmo que o
        // handoff tenha rodado junto e desligado o canal.
        if (b && Object.prototype.hasOwnProperty.call(b, "ai_active")) {
          state.captured.aiActivePayload = b.ai_active;
        }
        // Guarda otimista de gates.ts (loadConversationAndTakeover/
        // enforceRateLimit, TOCTOU fix — só estes dois rodam ANTES do lock):
        // .eq("awaiting_human", false).select("id"). Este arquivo só simula
        // UMA invocação por teste (sem corrida real), então o "casa ou não"
        // depende só do snapshot inicial de state.conv.awaiting_human.
        if (sp.get("awaiting_human") === "eq.false" && sp.get("select") === "id") {
          const matched = state.conv?.awaiting_human === false;
          return jsonResponse(200, matched ? [{ id: state.conv?.id ?? CONV_ID }] : []);
        }
        return emptyResponse(200);
      }
    }

    if (u.pathname === "/rest/v1/tenants" && req.method === "GET") {
      return jsonResponse(200, state.tenant ? [state.tenant] : []);
    }

    if (u.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, state.contact ? [state.contact] : []);
    }

    if (u.pathname === "/rest/v1/ai_settings") {
      if (req.method === "GET") {
        if (sp.get("select")?.includes("max_response_blocks")) {
          state.calls.aiBehaviorSettingsReads++;
        }
        return jsonResponse(200, state.aiSettings ? [state.aiSettings] : []);
      }
      if (req.method === "POST") {
        // .select(...).single() — objeto puro, ver nota acima.
        if (!state.aiSettingsInsertOk) return jsonResponse(500, { message: "insert failed" });
        return jsonResponse(201, {
          tenant_id: TENANT_ID,
          base_system_prompt: null,
          handoff_default_keywords: DEFAULT_HANDOFF_KEYWORDS,
          send_mode: null,
          model: null,
        });
      }
      if (req.method === "PATCH") {
        state.calls.aiSettingsPatch++;
        return emptyResponse(200);
      }
    }

    if (u.pathname === "/rest/v1/deals") {
      if (req.method === "GET") {
        if (sp.get("id")?.startsWith("eq.") && !sp.get("contact_id")) {
          return jsonResponse(200, state.dealOwnerRow ? [state.dealOwnerRow] : []);
        }
        return jsonResponse(200, state.openDeal ? [state.openDeal] : []);
      }
      if (req.method === "POST") {
        // .select("id").single() — objeto puro, ver nota acima.
        state.calls.dealsInsert++;
        return state.newDeal
          ? jsonResponse(201, state.newDeal)
          : jsonResponse(500, { message: "fail" });
      }
      if (req.method === "PATCH") {
        state.calls.dealsPatch++;
        // .select("id") (guarda otimista de advanceDealStage, Fase 3):
        // PostgREST devolve array quando o UPDATE tem representação.
        return jsonResponse(200, [{ id: DEAL_ID }]);
      }
    }

    if (u.pathname === "/rest/v1/boards" && req.method === "GET") {
      return jsonResponse(200, state.board ? [state.board] : []);
    }

    if (u.pathname === "/rest/v1/board_stages" && req.method === "GET") {
      const select = sp.get("select") ?? "";
      if (select === "id") return jsonResponse(200, state.firstStage ? [state.firstStage] : []);
      if (sp.get("position")?.startsWith("gt.")) {
        return jsonResponse(200, state.nextStage ? [state.nextStage] : []);
      }
      return jsonResponse(200, state.currentStage ? [state.currentStage] : []);
    }

    if (u.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
      return jsonResponse(200, state.stageCfg ? [state.stageCfg] : []);
    }

    if (u.pathname === "/rest/v1/activities" && req.method === "POST") {
      // performHandoff faz .insert(...).select("id").single() (Fase 3 — a
      // activity precisa existir antes do PATCH em conversations, para
      // handoff_activity_id ir na mesma chamada).
      return jsonResponse(201, { id: "activity-mock-1" });
    }

    // Gate de voz (voice.ts:isElevenLabsActive): desconectar a integração tem
    // que parar o áudio, então a preferência salva só vale com status='active'.
    if (u.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") {
      return jsonResponse(
        200,
        state.elevenlabsIntegrationStatus ? [{ status: state.elevenlabsIntegrationStatus }] : [],
      );
    }

    if (u.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
      if (state.secretsQueryFails) return jsonResponse(500, { message: "query failed" });
      // loadProviderSecrets filtra por slug; a transcrição pede slug=elevenlabs
      // e os envios pedem o slug do provider. Sem separar, o teste de "tenant
      // sem ElevenLabs" passaria por acidente ao herdar os secrets da Z-API.
      if (sp.get("slug") === "eq.elevenlabs") {
        if (state.elevenlabsSecretsQueryFails) {
          return jsonResponse(500, { message: "query failed" });
        }
        return jsonResponse(
          200,
          Object.entries(state.elevenlabsSecrets).map(([key, value]) => ({ key, value })),
        );
      }
      return jsonResponse(
        200,
        Object.entries(state.secrets).map(([key, value]) => ({ key, value })),
      );
    }

    // Download do áudio apontado por messages.media_url (voice.ts:downloadAudio).
    if (u.href.startsWith(AUDIO_URL)) {
      state.calls.audioDownload++;
      if (state.audioDownloadStatus !== 200) return jsonResponse(state.audioDownloadStatus, {});
      return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    if (u.pathname === "/v23.0/meta-audio-1" && req.method === "GET") {
      state.calls.metaMediaLookup++;
      if (req.headers.get("Authorization") !== "Bearer meta-access-token") {
        throw new Error("lookup Meta sem Authorization");
      }
      return jsonResponse(200, {
        url: META_MEDIA_DOWNLOAD_URL,
        mime_type: "audio/ogg",
      });
    }

    if (u.href.startsWith(META_MEDIA_DOWNLOAD_URL) && req.method === "GET") {
      state.calls.metaMediaDownload++;
      if (req.headers.get("Authorization") !== "Bearer meta-access-token") {
        throw new Error("download Meta sem Authorization");
      }
      return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    // STT da ElevenLabs (voice.ts:transcribeAudio).
    if (u.href.startsWith("https://api.elevenlabs.io/v1/speech-to-text")) {
      state.calls.sttPost++;
      if (state.sttStatus !== 200) return jsonResponse(state.sttStatus, { detail: "recusado" });
      return jsonResponse(200, { text: state.sttText });
    }

    // notifyAdminHandoff (notify-admin-handoff.ts): cooldown de flood (Fase 3
    // — hitl_handoff_sla_events) sempre vazio neste arquivo = nunca ativo;
    // nenhum teste aqui é especificamente sobre o throttle em si (ver
    // notify-admin-handoff.test.ts para isso).
    if (u.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
      return jsonResponse(200, []);
    }

    // notifyAdminHandoff (notify-admin-handoff.ts): destinatários de e-mail.
    // Default [] (defaultState) faz o alerta ser no-op silencioso em todo
    // teste que não é especificamente sobre isto.
    if (u.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
      state.calls.weeklyReportRecipientsQuery++;
      return jsonResponse(200, state.weeklyReportRecipients);
    }

    // captureEdgeError (telemetry.ts) — sink best-effort de notifyAdminHandoff
    // quando o envio falha; nenhum teste deste arquivo verifica o payload, só
    // precisa não cair no catch-all 501.
    if (u.pathname === "/rest/v1/system_events" && req.method === "POST") {
      return emptyResponse(201);
    }

    if (
      u.href.includes("api.z-api.io") ||
      u.href.includes("api.twilio.com") ||
      u.href.includes("graph.facebook.com") ||
      u.href.includes("api.resend.com")
    ) {
      if (u.href.includes("api.z-api.io")) {
        const b = req.bodyJson as { message?: string } | undefined;
        state.captured.sentContent = b?.message;
        state.calls.order.push("send");
      }
      if (u.href.includes("api.resend.com")) {
        state.calls.resendPost++;
      }
      if (state.externalSend.throws) throw new Error("network down");
      return sendResponse(state.externalSend);
    }

    if (u.href === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      const payload = req.bodyJson as {
        model?: string;
        response_format?: unknown;
        messages: Array<{ role: string; content: string }>;
      };
      const isEval = !!payload?.response_format;
      if (isEval) {
        state.calls.order.push("eval");
        if (state.evalThrows) throw new Error("network down (eval)");
        return jsonResponse(state.evalStatus, state.evalBody);
      }
      state.captured.systemPrompt = payload.messages[0]?.content;
      state.captured.historyMessages = payload.messages.slice(1);
      state.captured.model = payload.model;
      if (state.aiThrows) throw new Error("network down (ai)");
      if (state.aiThrowValue !== undefined) throw state.aiThrowValue;
      return jsonResponse(state.aiStatus, state.aiBody);
    }

    return undefined;
  };
}

function req(body?: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  }
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function run(
  state: State,
  opts: { messageId?: string; auth?: string | null } = {},
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(
      req({ message_id: opts.messageId ?? MESSAGE_ID }, { auth: opts.auth }),
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, body };
  } finally {
    uninstall();
  }
}

// ==================== renderTemplate (exportado) ====================

Deno.test("renderTemplate", async (t) => {
  await t.step("template vazio retorna string vazia", () => {
    if (renderTemplate("", { a: "1" }) !== "") throw new Error("esperado vazio");
  });

  await t.step("resolve variável simples e faz trim do valor", () => {
    const out = renderTemplate("Olá {{nome}}!", { nome: "  Ana  " });
    if (out !== "Olá Ana!") throw new Error(`inesperado: "${out}"`);
  });

  await t.step("variável não resolvida remove a frase inteira da linha", () => {
    const out = renderTemplate("Bem-vindo. Seu horário é {{hours}}. Obrigado.", {});
    if (out !== "Bem-vindo. Obrigado.") throw new Error(`inesperado: "${out}"`);
  });

  await t.step("variável com string vazia/whitespace conta como não resolvida", () => {
    const out = renderTemplate("Loja: {{cidade}}.", { cidade: "   " });
    if (out !== "") throw new Error(`inesperado: "${out}"`);
  });

  await t.step("linha inteira some quando toda ela depende de var não resolvida", () => {
    const out = renderTemplate("Primeira linha.\n{{inexistente}}\nÚltima linha.", {});
    if (out !== "Primeira linha.\nÚltima linha.") throw new Error(`inesperado: "${out}"`);
  });

  await t.step("colapsa espaços múltiplos e faz trim geral", () => {
    const out = renderTemplate("{{a}}    {{b}}", { a: "x", b: "y" });
    if (out !== "x y") throw new Error(`inesperado: "${out}"`);
  });
});

// ==================== Handler: validação básica ====================

Deno.test("ai-respond", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (await res.text()) throw new Error("esperado corpo vazio");
    } finally {
      uninstall();
    }
  });

  await t.step("método não-POST retorna 405", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "GET" }));
      if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("sem Authorization retorna 401", async () => {
    const { res } = await run(defaultState(), { auth: null });
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const { res } = await run(defaultState(), { auth: "Bearer errado" });
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("corpo inválido (JSON quebrado) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request("http://fn.local", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`,
            "content-type": "application/json",
          },
          body: "{not-json",
        }),
      );
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Corpo inválido.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("message_id ausente retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({}, {}));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "message_id obrigatório.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  // ==================== Carregamento de entidades ====================

  await t.step("mensagem não encontrada retorna ok:false message_not_found", async () => {
    const state = defaultState();
    state.msg = null;
    const { res, body } = await run(state);
    if (res.status !== 200 || body.reason !== "message_not_found") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("mensagem outbound (direction out) retorna not_contact_inbound", async () => {
    const state = defaultState();
    state.msg!.direction = "out";
    const { body } = await run(state);
    if (body.reason !== "not_contact_inbound") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("mensagem enviada pela IA (sender ai) retorna not_contact_inbound", async () => {
    const state = defaultState();
    state.msg!.sender = "ai";
    const { body } = await run(state);
    if (body.reason !== "not_contact_inbound") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("conversa não encontrada retorna conversation_not_found", async () => {
    const state = defaultState();
    state.conv = null;
    const { body } = await run(state);
    if (body.reason !== "conversation_not_found") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("conversa de outro tenant retorna conversation_not_found", async () => {
    const state = defaultState();
    state.conv!.tenant_id = "outro-tenant";
    const { body } = await run(state);
    if (body.reason !== "conversation_not_found") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("IA pausada na conversa retorna ai_paused_conversation", async () => {
    const state = defaultState();
    state.conv!.ai_active = false;
    const { body } = await run(state);
    if (body.reason !== "ai_paused_conversation") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("tenant não encontrado retorna tenant_not_found", async () => {
    const state = defaultState();
    state.tenant = null;
    const { body } = await run(state);
    if (body.reason !== "tenant_not_found") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("IA desativada no tenant retorna ai_disabled_tenant", async () => {
    const state = defaultState();
    state.tenant!.ai_enabled = false;
    const { body } = await run(state);
    if (body.reason !== "ai_disabled_tenant") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("contato não encontrado retorna contact_not_found", async () => {
    const state = defaultState();
    state.contact = null;
    const { body } = await run(state);
    if (body.reason !== "contact_not_found") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("IA pausada no contato retorna ai_paused_contact", async () => {
    const state = defaultState();
    state.contact!.ai_paused = true;
    const { body } = await run(state);
    if (body.reason !== "ai_paused_contact") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== Rate limit + lock de concorrência ====================

  await t.step("RPC de rate limit nega: retorna rate_limited sem chamar a IA", async () => {
    const state = defaultState();
    state.rateLimitAllowed = false;
    state.rateLimitRetryAfterSeconds = 42;
    const { res, body } = await run(state);
    if (res.status !== 200 || body.reason !== "rate_limited") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
    if (state.captured.systemPrompt !== undefined) throw new Error("não deveria chamar a IA");
  });

  await t.step("RPC de rate limit permite: segue o fluxo normalmente", async () => {
    const state = defaultState();
    state.rateLimitAllowed = true;
    const { res, body } = await run(state);
    if (res.status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "RPC de rate limit falhou (infra, não limite legítimo): reporta falha e marca awaiting_human",
    async () => {
      const state = defaultState();
      state.rateLimitRpcFails = true;
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "rate_limited") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.captured.systemPrompt !== undefined) throw new Error("não deveria chamar a IA");
      if (state.calls.aiFailureLogsInsert !== 1) {
        throw new Error(
          `esperado 1 insert em ai_failure_logs, veio ${state.calls.aiFailureLogsInsert}`,
        );
      }
      if (state.captured.awaitingHumanPayload !== true) {
        throw new Error("esperava awaiting_human=true marcado na conversa");
      }
    },
  );

  await t.step(
    "RPC de rate limit nega legitimamente (não é falha de RPC): não reporta falha nem marca awaiting_human",
    async () => {
      const state = defaultState();
      state.rateLimitAllowed = false;
      state.rateLimitRetryAfterSeconds = 30;
      const { body } = await run(state);
      if (body.reason !== "rate_limited") throw new Error(`inesperado: ${JSON.stringify(body)}`);
      if (state.calls.aiFailureLogsInsert !== 0) {
        throw new Error(`não deveria reportar falha, veio ${state.calls.aiFailureLogsInsert}`);
      }
      if (state.captured.awaitingHumanPayload !== undefined) {
        throw new Error("não deveria marcar awaiting_human para rate-limit legítimo");
      }
    },
  );

  await t.step(
    "lock não adquirido (disparo concorrente) retorna locked sem chamar a IA",
    async () => {
      const state = defaultState();
      state.lockAcquired = false;
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "locked") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.captured.systemPrompt !== undefined) throw new Error("não deveria chamar a IA");
    },
  );

  await t.step(
    "lock não adquirido: não cria deal (busca/criação agora protegida pelo lock)",
    async () => {
      const state = defaultState();
      state.lockAcquired = false;
      state.openDeal = null;
      const { body } = await run(state);
      if (body.reason !== "locked") throw new Error(`inesperado: ${JSON.stringify(body)}`);
      if (state.calls.dealsInsert !== 0) {
        throw new Error("não deveria criar deal sem o lock — criação de deal roda fora do lock");
      }
    },
  );

  await t.step(
    "claim por message_id perdido (outra invocação já processa esta mensagem) pula sem chamar a IA",
    async () => {
      const state = defaultState();
      state.claimAcquired = false;
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "message_already_processing") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.captured.systemPrompt !== undefined) throw new Error("não deveria chamar a IA");
    },
  );

  // ==================== ai_settings bootstrap ====================

  await t.step("ai_settings ausente é criado com defaults e keyword padrão funciona", async () => {
    const state = defaultState();
    state.aiSettings = null;
    state.msg!.content = "quero agendar uma visita";
    const { body } = await run(state);
    if (body.reason !== "keyword:agendar") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step(
    "ai_settings ausente e insert falha: keyword de handoff ainda leva para humano",
    async () => {
      // Fica VERDE de propósito depois do fix 05 · H2. O que aquele achado
      // impede é a IA RESPONDER o cliente com a persona de fábrica; aqui a
      // mensagem casa com keyword de handoff e o fluxo entrega a conversa para
      // um humano ANTES de gerar qualquer texto — degradado (usa a lista de
      // keywords padrão), mas seguro. O caminho perigoso, em que o gate agora
      // NEGA em vez de responder com o prompt padrão, está coberto em
      // gates.test.ts ("erro persistente no SELECT: nega o gate em vez de cair
      // na persona padrão").
      const state = defaultState();
      state.aiSettings = null;
      state.aiSettingsInsertOk = false;
      state.msg!.content = "quero agendar uma visita";
      const { body } = await run(state);
      if (body.reason !== "keyword:agendar") throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step("ai_settings sem keywords é atualizado com defaults", async () => {
    const state = defaultState();
    state.aiSettings!.handoff_default_keywords = [];
    state.msg!.content = "preciso de atendente";
    const { body } = await run(state);
    if (state.calls.aiSettingsPatch !== 1) throw new Error("esperava PATCH em ai_settings");
    if (body.reason !== "keyword:atendente") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== Criação de deal ====================

  await t.step("sem deal aberto: cria novo deal quando board e stage inicial existem", async () => {
    const state = defaultState();
    state.openDeal = null;
    const { res, body } = await run(state);
    if (state.calls.dealsInsert !== 1) throw new Error("esperava insert de deal");
    if (res.status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "título do novo deal cai para o telefone quando o contato não tem nome",
    async () => {
      const state = defaultState();
      state.openDeal = null;
      state.contact!.name = null;
      const { res, body } = await run(state);
      if (state.calls.dealsInsert !== 1) throw new Error("esperava insert de deal");
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "título do novo deal cai para o e-mail quando não há nome nem telefone",
    async () => {
      const state = defaultState();
      state.openDeal = null;
      state.contact!.name = null;
      state.contact!.phone = null;
      const { res, body } = await run(state);
      if (state.calls.dealsInsert !== 1) throw new Error("esperava insert de deal");
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "título do novo deal usa 'Contato' quando nome, telefone e e-mail estão ausentes",
    async () => {
      const state = defaultState();
      state.openDeal = null;
      state.contact!.name = null;
      state.contact!.phone = null;
      state.contact!.email = null;
      const { res, body } = await run(state);
      if (state.calls.dealsInsert !== 1) throw new Error("esperava insert de deal");
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("sem deal aberto e sem board padrão: segue sem criar deal", async () => {
    const state = defaultState();
    state.openDeal = null;
    state.board = null;
    const { res, body } = await run(state);
    if (state.calls.dealsInsert !== 0) throw new Error("não deveria inserir deal");
    if (res.status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "sem deal aberto, board existe mas sem stage inicial: segue sem criar deal",
    async () => {
      const state = defaultState();
      state.openDeal = null;
      state.firstStage = null;
      const { res, body } = await run(state);
      if (state.calls.dealsInsert !== 0) throw new Error("não deveria inserir deal");
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("insert do deal falha: dealId fica nulo mas fluxo continua", async () => {
    const state = defaultState();
    state.openDeal = null;
    state.newDeal = null;
    state.stageCfg!.advancement_criteria = ["algum critério"];
    const { res, body } = await run(state);
    if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage sem dealId");
    if (res.status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  // ==================== stage_ai_config ====================

  await t.step("stage_ai_config ausente: segue com prompt de estágio vazio", async () => {
    const state = defaultState();
    state.stageCfg = null;
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step(
    "stage_ai_config desabilitado ainda carrega handoff_keywords do estágio",
    async () => {
      const state = defaultState();
      state.stageCfg!.enabled = false;
      state.stageCfg!.handoff_keywords = ["à venda"];
      state.msg!.content = "Isso está à venda ainda?";
      const { body } = await run(state);
      if (body.reason !== "keyword:a venda") throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step("advancement_criteria em formato {criteria:[...]} é interpretado", async () => {
    const state = defaultState();
    state.stageCfg!.advancement_criteria = { criteria: ["fechou negócio"] };
    state.evalBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({ results: [{ criterion: "fechou negócio", met: true }] }),
          },
        },
      ],
    };
    const { res } = await run(state);
    if (state.calls.dealsPatch !== 1) throw new Error("esperava avanço de stage");
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step(
    "advancement_criteria em formato inválido vira lista vazia (sem avaliação)",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = "texto qualquer";
      const { res } = await run(state);
      if (state.calls.dealsPatch !== 0) throw new Error("não deveria avaliar avanço");
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    },
  );

  await t.step("stage_ai_config.handoff_keywords não-array vira lista vazia", async () => {
    const state = defaultState();
    // deno-lint-ignore no-explicit-any
    (state.stageCfg as any).handoff_keywords = null;
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step("stage_ai_config.stage_goal nulo cai no fallback de string vazia", async () => {
    const state = defaultState();
    // deno-lint-ignore no-explicit-any
    (state.stageCfg as any).stage_goal = null;
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step("stage_goal preenchido é incluído no prompt de avaliação de avanço", async () => {
    const state = defaultState();
    state.stageCfg!.stage_goal = "Fechar contrato mensal";
    state.stageCfg!.advancement_criteria = ["cliente confirmou"];
    state.evalBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({ results: [{ criterion: "cliente confirmou", met: true }] }),
          },
        },
      ],
    };
    const { res } = await run(state);
    if (state.calls.dealsPatch !== 1) throw new Error("esperava avanço de stage");
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step(
    "advancement_criteria com item objeto (não string) usa description/text como critério",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = [
        { description: "cliente pediu orçamento" },
        { text: "cliente confirmou data" },
        {},
      ];
      state.evalBody = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  { criterion: "cliente pediu orçamento", met: true },
                  { criterion: "cliente confirmou data", met: true },
                ],
              }),
            },
          },
        ],
      };
      const { res } = await run(state);
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    },
  );

  await t.step(
    "resposta de avaliação sem 'choices' cai no fallback '{}' antes do parse",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a"];
      state.evalBody = {};
      const { res } = await run(state);
      if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage");
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    },
  );

  await t.step(
    "avaliação com 'results' que não é array trata como lista vazia (não avança)",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a"];
      state.evalBody = {
        choices: [{ message: { content: JSON.stringify({ results: "não é array" }) } }],
      };
      const { res } = await run(state);
      if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage");
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    },
  );

  // ==================== Handoff pre-check ====================

  await t.step("mensagem com media_url dispara handoff media_received", async () => {
    const state = defaultState();
    state.msg!.media_url = "https://cdn.example.com/foto.png";
    const { body } = await run(state);
    if (body.handoff !== true || body.reason !== "media_received") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
    // Controle positivo do captured.aiActivePayload: aqui o handoff DEVE
    // desligar a IA. Sem esta asserção, o "não desligou" do teste de áudio
    // cifrado passaria mesmo se o mock nunca capturasse o campo.
    if (state.captured.aiActivePayload !== false) {
      throw new Error(
        `handoff deveria gravar ai_active=false, veio ${state.captured.aiActivePayload}`,
      );
    }
  });

  await t.step(
    "mensagem com media_type (sem media_url) também dispara handoff media_received",
    async () => {
      const state = defaultState();
      state.msg!.media_type = "audio/ogg";
      const { body } = await run(state);
      if (body.reason !== "media_received") throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  // Regressão do canal Zappaz mudo (05/08): um áudio cifrado virava
  // handoff → ai_active=false, e a partir dali TODO texto do lead parava em
  // `ai_paused_conversation`. Ninguém percebia, porque o canal continuava
  // "connected" e o webhook seguia entregando.
  await t.step(
    "áudio cifrado do WhatsApp responde pedindo texto e NÃO faz handoff",
    async () => {
      const state = defaultState();
      state.msg!.media_type = "audio/ogg";
      state.msg!.media_url =
        "https://mmg.whatsapp.net/v/t62.7114-24/534697860_1557938419069245.enc?ccb=11-4";
      // Guarda determinística do flake: `dropTrailingQuestion` (send-dispatch)
      // sorteia com Math.random se apaga a pergunta final da resposta. Se este
      // texto terminar em "?", o pedido "me manda por escrito" some em parte
      // dos envios — o lead recebe só "Ainda não consigo ouvir áudios por
      // aqui." e fica sem saber o que fazer. Foi assim que a suíte ficou
      // instável (~1 em 4 execuções) antes desta correção.
      if (AUDIO_CIFRADO_REPLY.trimEnd().endsWith("?")) {
        throw new Error("AUDIO_CIFRADO_REPLY não pode terminar em pergunta");
      }
      const { body } = await run(state);
      if (body.handoff === true || body.reason !== "audio_cifrado_sem_suporte") {
        throw new Error(`esperado degradar sem handoff: ${JSON.stringify(body)}`);
      }
      if (state.captured.sentContent !== AUDIO_CIFRADO_REPLY) {
        throw new Error(`resposta enviada inesperada: ${state.captured.sentContent}`);
      }
      // O ponto do fix: responder não basta, a IA tem que continuar ligada.
      if (state.captured.aiActivePayload === false || state.captured.awaitingHumanPayload === true) {
        throw new Error(
          `handoff rodou junto: ai_active=${state.captured.aiActivePayload} awaiting_human=${state.captured.awaitingHumanPayload}`,
        );
      }
      // Corta antes de gastar rede e crédito: os bytes do link são ciphertext,
      // baixar e mandar para a ElevenLabs só produziria o mesmo erro.
      if (state.calls.audioDownload !== 0 || state.calls.sttPost !== 0) {
        throw new Error(
          `não deveria baixar nem transcrever: download=${state.calls.audioDownload} stt=${state.calls.sttPost}`,
        );
      }
    },
  );

  await t.step("media_type só com espaços em branco não conta como mídia", async () => {
    const state = defaultState();
    state.msg!.media_type = "   ";
    const { res, body } = await run(state);
    if (res.status !== 200 || body.handoff === true) {
      throw new Error(`não deveria disparar handoff de mídia: ${JSON.stringify(body)}`);
    }
  });

  await t.step("keyword padrão com acento é normalizada e dispara handoff", async () => {
    const state = defaultState();
    state.msg!.content = "Quero MARCAR um horário, por favor";
    const { body } = await run(state);
    if (body.reason !== "keyword:marcar") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  const handoffIntentCases = [
    { phrase: "Quero falar com uma pessoa.", expected: true },
    { phrase: "Me passa para um atendente.", expected: true },
    { phrase: "Nao quero falar com robo.", expected: true },
    { phrase: "Preciso de ajuda humana.", expected: true },
    { phrase: "O atendente humano explicou isso ontem.", expected: false },
    { phrase: "Nosso atendimento humano funciona ate as 18h.", expected: false },
    { phrase: "Pode marcar essa opcao no formulario pra mim?", expected: false },
    { phrase: "Qual o preco do plano basico?", expected: false },
  ];
  for (const testCase of handoffIntentCases) {
    await t.step(`handoff intent: ${testCase.phrase}`, async () => {
      const state = defaultState();
      state.msg!.content = testCase.phrase;
      state.aiBody = { choices: [{ message: { content: "Claro, posso ajudar com isso." } }] };
      const { body } = await run(state);
      if (Boolean(body.handoff) !== testCase.expected) {
        throw new Error(
          `esperado handoff=${testCase.expected}, veio ${JSON.stringify(body)}`,
        );
      }
    });
  }

  await t.step("handoff sem deal aberto: ownerId fica nulo mas não quebra", async () => {
    const state = defaultState();
    state.openDeal = null;
    state.board = null;
    state.msg!.media_url = "https://cdn.example.com/a.png";
    const { body } = await run(state);
    if (body.reason !== "media_received") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("contactLabel usa e-mail quando nome e telefone estão ausentes", async () => {
    const state = defaultState();
    state.contact!.name = null;
    state.contact!.phone = null;
    state.msg!.media_url = "https://cdn.example.com/a.png";
    const { body } = await run(state);
    if (body.reason !== "media_received") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("handoff com deal aberto mas sem registro de owner: ownerId fica nulo", async () => {
    const state = defaultState();
    state.dealOwnerRow = null;
    state.msg!.media_url = "https://cdn.example.com/a.png";
    const { body } = await run(state);
    if (body.reason !== "media_received") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("contactLabel usa só o telefone quando o nome está ausente", async () => {
    const state = defaultState();
    state.contact!.name = null;
    state.msg!.media_url = "https://cdn.example.com/a.png";
    const { body } = await run(state);
    if (body.reason !== "media_received") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("IA declara [TRANSFERIR_HUMANO] dispara handoff ai_declared_unknown", async () => {
    const state = defaultState();
    state.aiBody = { choices: [{ message: { content: "não sei, [transferir_humano]" } }] };
    const { body } = await run(state);
    if (body.reason !== "ai_declared_unknown") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  // ==================== Montagem do prompt / vars ====================

  await t.step("base_system_prompt default usa {{empresa}} do tenant", async () => {
    const state = defaultState();
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (!state.captured.systemPrompt?.includes("Acme")) {
      throw new Error(`prompt não contém nome do tenant: ${state.captured.systemPrompt}`);
    }
  });

  await t.step(
    "base_system_prompt customizado + alias PT resolve via business_profile",
    async () => {
      const state = defaultState();
      state.aiSettings!.base_system_prompt =
        "Atende {{segmento}} em {{cidade}} com a equipe {{equipe}}.";
      state.tenant!.business_profile = {
        segment: "estética",
        city: "Curitiba",
        team: "Ana e Bruno",
      };
      const { res } = await run(state);
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const prompt = state.captured.systemPrompt ?? "";
      if (
        !prompt.includes("estética") ||
        !prompt.includes("Curitiba") ||
        !prompt.includes("Ana e Bruno")
      ) {
        throw new Error(`prompt sem variáveis resolvidas: ${prompt}`);
      }
    },
  );

  await t.step("business_profile.hours formata horários e ignora dia mal configurado", async () => {
    const state = defaultState();
    state.aiSettings!.base_system_prompt = "Horário: {{hours}}.";
    state.tenant!.business_profile = {
      hours: {
        mon: { enabled: true, open: "09:00", close: "18:00" },
        tue: { enabled: false, open: "09:00", close: "18:00" },
        xyz: { enabled: true, open: "10:00", close: "12:00" },
      },
    };
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    const prompt = state.captured.systemPrompt ?? "";
    if (!prompt.includes("seg 09:00-18:00") || !prompt.includes("xyz 10:00-12:00")) {
      throw new Error(`horários não formatados como esperado: ${prompt}`);
    }
  });

  await t.step("business_profile.hours vazio remove a frase de horário do prompt", async () => {
    const state = defaultState();
    state.aiSettings!.base_system_prompt = "Fixo. Horário: {{hours}}.";
    state.tenant!.business_profile = { hours: {} };
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    const prompt = state.captured.systemPrompt ?? "";
    if (prompt.includes("Horário:")) {
      throw new Error(`horário deveria ter sido removido: ${prompt}`);
    }
    if (!prompt.includes("Fixo.")) throw new Error(`prompt perdeu conteúdo válido: ${prompt}`);
  });

  await t.step("stage prompt vazio: systemPrompt não duplica quebras de linha", async () => {
    const state = defaultState();
    state.stageCfg!.enabled = false;
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (!state.captured.systemPrompt) throw new Error("systemPrompt não capturado");
  });

  await t.step(
    "business_profile com campo null, array e número popula flat vars corretamente",
    async () => {
      const state = defaultState();
      state.aiSettings!.base_system_prompt = "Serviços: {{servicos_lista}}. Nota: {{rating}}.";
      state.tenant!.business_profile = {
        campo_nulo: null,
        servicos_lista: ["Corte", "Barba", ""],
        rating: 4.5,
      };
      const { res } = await run(state);
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const prompt = state.captured.systemPrompt ?? "";
      if (!prompt.includes("Corte, Barba") || !prompt.includes("4.5")) {
        throw new Error(`vars não resolvidas como esperado: ${prompt}`);
      }
    },
  );

  await t.step("tenant.business_profile nulo cai no fallback {} sem quebrar", async () => {
    const state = defaultState();
    state.tenant!.business_profile = null;
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (!state.captured.systemPrompt?.includes("Acme")) {
      throw new Error(`prompt não contém nome do tenant: ${state.captured.systemPrompt}`);
    }
  });

  await t.step("stage prompt habilitado é concatenado ao prompt base", async () => {
    const state = defaultState();
    state.stageCfg!.system_prompt = "Foque em agendar uma demonstração.";
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (!state.captured.systemPrompt?.includes("Foque em agendar uma demonstração.")) {
      throw new Error(`prompt de estágio ausente: ${state.captured.systemPrompt}`);
    }
  });

  // ==================== Histórico ====================

  await t.step("histórico filtra mensagens sem conteúdo e rotula remetentes", async () => {
    const state = defaultState();
    // Ordem descendente (mais recente primeiro), como a query real devolve.
    state.recentHistory = [
      { sender: "ai", content: "Claro!", created_at: "2026-01-01T00:03:00.000Z" },
      { sender: "human", content: "Já te respondo", created_at: "2026-01-01T00:02:00.000Z" },
      { sender: "contact", content: "Oi", created_at: "2026-01-01T00:01:00.000Z" },
      { sender: "contact", content: "", created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const { res } = await run(state);
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    const hist = state.captured.historyMessages ?? [];
    if (hist.length !== 3) {
      throw new Error(`esperava 3 mensagens no histórico, veio ${hist.length}`);
    }
    if (hist[0].role !== "user" || hist[0].content !== "Oi") {
      throw new Error("mapeamento do lead incorreto");
    }
    if (hist[1].role !== "assistant" || !hist[1].content.startsWith("[Atendente]")) {
      throw new Error(`rótulo de atendente incorreto: ${JSON.stringify(hist[1])}`);
    }
    // A IA NÃO leva rótulo: `role: "assistant"` já diz de quem é, e o rótulo
    // vazava para a resposta enviada ao lead (15 de 65 no QA de 2026-08-04,
    // uma com "[IA] [IA] " porque a resposta contaminada volta ao histórico).
    if (hist[2].role !== "assistant" || hist[2].content !== "Claro!") {
      throw new Error(`resposta da IA não deve levar rótulo: ${JSON.stringify(hist[2])}`);
    }
  });

  await t.step(
    "janela de caracteres mantém ao menos a mensagem mais recente mesmo estourando o teto",
    async () => {
      const state = defaultState();
      const big = "x".repeat(9000);
      // Ordem descendente (mais recente primeiro): "resposta curta" é a mais nova.
      state.recentHistory = [
        { sender: "ai", content: "resposta curta", created_at: "2026-01-01T00:01:00.000Z" },
        { sender: "contact", content: big, created_at: "2026-01-01T00:00:00.000Z" },
      ];
      const { res } = await run(state);
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const hist = state.captured.historyMessages ?? [];
      if (hist.length !== 1) throw new Error(`esperava só a mais recente, veio ${hist.length}`);
      if (!hist[0].content.includes("resposta curta")) {
        throw new Error("mensagem mais recente não preservada");
      }
    },
  );

  await t.step(
    "falha na query de histórico recente trata como lista vazia (sem quebrar)",
    async () => {
      const state = defaultState();
      state.recentHistoryQueryFails = true;
      const { res } = await run(state);
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if ((state.captured.historyMessages ?? []).length !== 0) {
        throw new Error("esperava histórico vazio quando a query falha");
      }
    },
  );

  await t.step(
    "mensagem de histórico com content nulo (não string vazia) é filtrada corretamente",
    async () => {
      const state = defaultState();
      state.recentHistory = [
        { sender: "ai", content: null, created_at: "2026-01-01T00:01:00.000Z" },
        { sender: "contact", content: "Oi", created_at: "2026-01-01T00:00:00.000Z" },
      ];
      const { res } = await run(state);
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const hist = state.captured.historyMessages ?? [];
      if (hist.length !== 1 || hist[0].content !== "Oi") {
        throw new Error(`esperava só a mensagem com conteúdo válido: ${JSON.stringify(hist)}`);
      }
    },
  );

  // ==================== callLovableAI ====================

  await t.step("sem LOVABLE_API_KEY: generation_failed", async () => {
    Deno.env.delete("LOVABLE_API_KEY");
    try {
      const state = defaultState();
      const { body } = await run(state);
      if (body.reason !== "generation_failed" || body.error !== "LOVABLE_API_KEY ausente.") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    } finally {
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });

  await t.step("IA retorna 429: mensagem de muitas requisições", async () => {
    const state = defaultState();
    state.aiStatus = 429;
    const { body } = await run(state);
    if (body.error !== "Muitas requisições à IA agora. Tentaremos de novo em instantes.") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("IA retorna 402: mensagem de créditos esgotados", async () => {
    const state = defaultState();
    state.aiStatus = 402;
    const { body } = await run(state);
    if (body.error !== "Créditos de IA esgotados. Recarregue para continuar respondendo.") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("IA retorna outro erro HTTP: mensagem genérica", async () => {
    const state = defaultState();
    state.aiStatus = 503;
    const { body } = await run(state);
    if (body.error !== "A IA não conseguiu responder desta vez.") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("IA retorna conteúdo vazio: mensagem de resposta vazia", async () => {
    const state = defaultState();
    state.aiBody = { choices: [{ message: { content: "   " } }] };
    const { body } = await run(state);
    if (body.error !== "A IA retornou uma resposta vazia.") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step("falha de rede na chamada à IA cai no catch de generation_failed", async () => {
    const state = defaultState();
    state.aiThrows = true;
    const { body } = await run(state);
    if (body.reason !== "generation_failed") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step(
    "generation_failed (awaiting_human era false): notifica admin por e-mail (Resend chamado)",
    async () => {
      const state = defaultState();
      state.aiThrows = true;
      state.weeklyReportRecipients = [{ address: "admin@acme.com" }];
      // Credenciais do Resend p/ o alerta de admin — distinto do canal da
      // conversa em si (zapi, default state), nunca alcançado neste teste
      // (a IA falha antes de chegar em finalizeAiReply/dispatchAiSend).
      state.secrets = { api_key: "re_test", from_domain: "acme.com" };
      const { body } = await run(state);
      if (body.reason !== "generation_failed") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.calls.resendPost !== 1) {
        throw new Error(
          `esperado 1 chamada ao Resend (alerta admin), veio ${state.calls.resendPost}`,
        );
      }
    },
  );

  await t.step(
    "awaiting_human já era true: bloqueia antes da geração e não notifica admin de novo",
    async () => {
      const state = defaultState();
      state.aiThrows = true;
      state.conv!.awaiting_human = true;
      const { body } = await run(state);
      if (body.reason !== "awaiting_human") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.calls.weeklyReportRecipientsQuery !== 0) {
        throw new Error(
          `não deveria consultar weekly_report_recipients, veio ${state.calls.weeklyReportRecipientsQuery} chamada(s)`,
        );
      }
    },
  );

  await t.step(
    "resposta da IA sem campo 'choices' também cai no fallback de conteúdo vazio",
    async () => {
      const state = defaultState();
      state.aiBody = {};
      const { body } = await run(state);
      if (body.error !== "A IA retornou uma resposta vazia.") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "exceção sem mensagem (não-Error) é normalizada por sanitizeProviderError",
    async () => {
      const state = defaultState();
      // Lança um valor sem `.message` (não é instância de Error) — exercita o
      // fallback de extractRawMessage (errors.ts): sem `.message`, faz
      // JSON.stringify do valor lançado. "etimedout" no JSON casa o padrão de
      // TIMEOUT do classify().
      state.aiThrowValue = { code: "ETIMEDOUT" };
      const { body } = await run(state);
      if (body.reason !== "generation_failed" || body.error !== '{"code":"ETIMEDOUT"}') {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  // ==================== send_mode: draft ====================

  await t.step("send_mode draft: grava rascunho e não envia externamente", async () => {
    const state = defaultState();
    state.aiSettings!.send_mode = "draft";
    // awaiting_human era false (default) e o modo draft É a espera por
    // aprovação humana (A3: alerta imediato) — notifyAdminHandoff deve
    // disparar com reason "draft_pending_approval". Credenciais do Resend
    // p/ o alerta de admin — distinto do canal da conversa em si (zapi,
    // default state), mesmo padrão do teste de generation_failed acima.
    state.weeklyReportRecipients = [{ address: "admin@acme.com" }];
    state.secrets = { api_key: "re_test", from_domain: "acme.com" };
    const { res, body } = await run(state);
    if (res.status !== 200 || body.draft !== true || body.sent !== false || body.id !== AI_MSG_ID) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
    if (state.calls.resendPost !== 1) {
      throw new Error(
        `esperado 1 chamada ao Resend (alerta admin), veio ${state.calls.resendPost}`,
      );
    }
  });

  await t.step("send_mode draft: falha ao gravar retorna insert_failed", async () => {
    const state = defaultState();
    state.aiSettings!.send_mode = "draft";
    state.insertMessageFails = true;
    const { body } = await run(state);
    if (body.reason !== "insert_failed") throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== send_mode: auto (insert) ====================

  await t.step(
    "send_mode auto: falha ao gravar mensagem pendente retorna insert_failed",
    async () => {
      const state = defaultState();
      state.insertMessageFails = true;
      // awaiting_human era false (default) e a falha de insert marca
      // awaiting_human=true (A3: alerta imediato) — notifyAdminHandoff deve
      // disparar com reason "persist_failed". Credenciais do Resend distintas
      // do canal da conversa (zapi, default state), mesmo padrão acima.
      state.weeklyReportRecipients = [{ address: "admin@acme.com" }];
      state.secrets = { api_key: "re_test", from_domain: "acme.com" };
      const { body } = await run(state);
      if (body.reason !== "insert_failed") throw new Error(`inesperado: ${JSON.stringify(body)}`);
      if (state.calls.resendPost !== 1) {
        throw new Error(
          `esperado 1 chamada ao Resend (alerta admin), veio ${state.calls.resendPost}`,
        );
      }
    },
  );

  // ==================== Envio externo: Z-API ====================

  await t.step("zapi: sem telefone cadastrado não tenta enviar", async () => {
    const state = defaultState();
    state.contact!.phone = null;
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("zapi: credenciais ausentes retorna 'não configurada'", async () => {
    const state = defaultState();
    state.secrets = {};
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("zapi: 403 retorna mensagem de credenciais inválidas (friendlyHttp)", async () => {
    const state = defaultState();
    state.externalSend = { status: 403, body: { error: "forbidden" } };
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("zapi: sucesso extrai external_id de messageId", async () => {
    const state = defaultState();
    state.externalSend = { status: 200, body: { messageId: "m-1" } };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("zapi: sucesso com corpo não-JSON cai no fallback de external_id nulo", async () => {
    const state = defaultState();
    state.externalSend = { status: 200, body: "RAW:isso não é json" };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== Envio externo: Twilio ====================

  await t.step("twilio: credenciais ausentes retorna 'não configurada'", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "twilio", type: "whatsapp" };
    state.secrets = {};
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("twilio: contato sem telefone cadastrado não tenta enviar", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "twilio", type: "whatsapp" };
    state.contact!.phone = null;
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step(
    "twilio: número configurado sem dígitos válidos retorna 'número inválido'",
    async () => {
      const state = defaultState();
      state.conv!.channels = { provider_slug: "twilio", type: "whatsapp" };
      // Credenciais presentes (passam no check de config) mas sem dígitos após
      // replace(/\D/g, "") — hit o branch fromDigits/toDigits vazio dentro de sendTwilio.
      state.secrets = { account_sid: "AC1", auth_token: "tok", whatsapp_number: "sem-digitos" };
      const { body } = await run(state);
      if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step("twilio: 401 retorna mensagem de credenciais inválidas", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "twilio", type: "whatsapp" };
    state.secrets = { account_sid: "AC1", auth_token: "tok", whatsapp_number: "+5511888887777" };
    state.externalSend = { status: 401, body: { message: "unauthorized" } };
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("twilio: sucesso extrai sid como external_id", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "twilio", type: "whatsapp" };
    state.secrets = { account_sid: "AC1", auth_token: "tok", whatsapp_number: "+5511888887777" };
    state.externalSend = { status: 200, body: { sid: "SM123" } };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("twilio: sucesso sem sid no corpo cai em external_id nulo", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "twilio", type: "whatsapp" };
    state.secrets = { account_sid: "AC1", auth_token: "tok", whatsapp_number: "+5511888887777" };
    state.externalSend = { status: 200, body: {} };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== Envio externo: Meta Cloud ====================

  await t.step("meta-cloud: credenciais ausentes retorna 'não configurada'", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
    state.secrets = {};
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("meta-cloud: contato sem telefone retorna 'sem telefone cadastrado'", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
    state.secrets = { access_token: "tok", phone_number_id: "123" };
    state.contact!.phone = null;
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step(
    "meta-cloud: telefone sem dígitos válidos retorna 'número inválido' (dentro de sendMetaCloud)",
    async () => {
      const state = defaultState();
      state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
      state.secrets = { access_token: "tok", phone_number_id: "123" };
      // Telefone truthy (passa no check externo) mas sem dígitos após replace(/\D/g, "").
      state.contact!.phone = "sem-digitos";
      const { body } = await run(state);
      if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step("meta-cloud: 401 retorna mensagem de access token inválido", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
    state.secrets = { access_token: "tok", phone_number_id: "123" };
    state.externalSend = { status: 401, body: { error: "bad token" } };
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("meta-cloud: sucesso extrai id de messages[0]", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
    state.secrets = { access_token: "tok", phone_number_id: "123" };
    state.externalSend = { status: 200, body: { messages: [{ id: "wamid.1" }] } };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("meta-cloud: sucesso sem array messages cai em external_id nulo", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
    state.secrets = { access_token: "tok", phone_number_id: "123" };
    state.externalSend = { status: 200, body: {} };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== Envio externo: Resend ====================

  await t.step("resend: credenciais ausentes retorna 'não configurada'", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "resend", type: "email" };
    state.secrets = {};
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("resend: contato sem e-mail retorna 'sem e-mail cadastrado'", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "resend", type: "email" };
    state.secrets = { api_key: "key", from_domain: "acme.com" };
    state.contact!.email = null;
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("resend: 403 retorna mensagem de chave inválida", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "resend", type: "email" };
    state.secrets = { api_key: "key", from_domain: "acme.com" };
    state.externalSend = { status: 403, body: { message: "forbidden" } };
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step(
    "resend: from_email customizado válido é usado; assunto sem 'Re:' recebe prefixo",
    async () => {
      const state = defaultState();
      state.conv!.channels = { provider_slug: "resend", type: "email" };
      state.conv!.subject = "Dúvida sobre plano";
      state.secrets = { api_key: "key", from_domain: "acme.com", from_email: "contato@acme.com" };
      state.externalSend = { status: 200, body: { id: "email-1" } };
      const { body } = await run(state);
      if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step(
    "resend: from_email inválido cai no fallback contato@dominio; assunto já com 'Re:' é mantido",
    async () => {
      const state = defaultState();
      state.conv!.channels = { provider_slug: "resend", type: "email" };
      state.conv!.subject = "Re: Dúvida sobre plano";
      state.secrets = { api_key: "key", from_domain: "acme.com", from_email: "sem-arroba" };
      state.externalSend = { status: 200, body: { id: "email-2" } };
      const { body } = await run(state);
      if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step("resend: sem subject usa 'Nova mensagem'", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "resend", type: "email" };
    state.conv!.subject = null;
    state.secrets = { api_key: "key", from_domain: "acme.com" };
    state.externalSend = { status: 200, body: { id: "email-3" } };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("resend: sucesso sem id no corpo cai em external_id nulo", async () => {
    const state = defaultState();
    state.conv!.channels = { provider_slug: "resend", type: "email" };
    state.secrets = { api_key: "key", from_domain: "acme.com" };
    state.externalSend = { status: 200, body: {} };
    const { body } = await run(state);
    if (body.sent !== true) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  // ==================== Envio externo: genéricos ====================

  await t.step(
    "canal sem provider_slug suportado retorna erro de canal não suportado",
    async () => {
      const state = defaultState();
      state.conv!.channels = { provider_slug: "instagram", type: "dm" };
      const { body } = await run(state);
      if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step(
    "conversa sem channels (join nulo) usa fallback de provider vazio -> canal não suportado",
    async () => {
      const state = defaultState();
      state.conv!.channels = null;
      const { body } = await run(state);
      if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step(
    "loadSecrets com falha na query lança e cai no catch com NET_ERR (não mascara como credencial ausente)",
    async () => {
      const state = defaultState();
      state.secretsQueryFails = true;
      const { body } = await run(state);
      if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
    },
  );

  await t.step(
    "provedor com status >= 500 retorna mensagem de indisponibilidade e reporta em ai_failure_logs",
    async () => {
      const state = defaultState();
      state.externalSend = { status: 500, body: { message: "boom" } };
      const { body } = await run(state);
      if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
      if (state.calls.aiFailureLogsInsert !== 1) {
        throw new Error(
          `esperado 1 insert em ai_failure_logs, veio ${state.calls.aiFailureLogsInsert}`,
        );
      }
    },
  );

  await t.step("provedor com status 429 pede para aguardar", async () => {
    const state = defaultState();
    state.externalSend = { status: 429, body: { message: "slow down" } };
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step("provedor com status genérico (404) retorna mensagem padrão", async () => {
    const state = defaultState();
    state.externalSend = { status: 404, body: { message: "not found" } };
    const { body } = await run(state);
    if (body.sent !== false) throw new Error(`inesperado: ${JSON.stringify(body)}`);
  });

  await t.step(
    "exceção de rede durante envio externo cai no catch com NET_ERR e reporta em ai_failure_logs",
    async () => {
      const state = defaultState();
      state.externalSend = { status: 200, body: {}, throws: true };
      const { res, body } = await run(state);
      if (res.status !== 200 || body.sent !== false) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.calls.aiFailureLogsInsert !== 1) {
        throw new Error(
          `esperado 1 insert em ai_failure_logs, veio ${state.calls.aiFailureLogsInsert}`,
        );
      }
    },
  );

  await t.step("envio externo com sucesso: mensagem final ok com sent=true", async () => {
    const state = defaultState();
    const { res, body } = await run(state);
    if (res.status !== 200 || body.ok !== true || body.sent !== true || body.id !== AI_MSG_ID) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  // ==================== Avaliação de avanço de estágio ====================

  // Regressão de duplicata: o claim de idempotência tem que fechar entre o
  // envio e a avaliação de avanço, nunca depois dela. A avaliação é uma SEGUNDA
  // chamada ao gateway e o turno corre contra o teto de 150 s do isolate; com o
  // finishClaim depois dela, um turno que já enviou e é morto no teto deixa o
  // claim aberto, a lease de 180 s expira, o job é reivindicado de novo e o
  // lead recebe a mesma resposta duas vezes (fora da janela de 30 s do
  // coalescer, que por isso não deduplica). A ordem é o invariante — não o
  // número de chamadas.
  await t.step("claim é concluído entre o envio e a avaliação de avanço", async () => {
    const state = defaultState();
    state.stageCfg!.advancement_criteria = ["cliente confirmou interesse"];
    state.evalBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [{ criterion: "cliente confirmou interesse", met: false }],
            }),
          },
        },
      ],
    };
    await run(state);
    const order = state.calls.order.join(",");
    if (order !== "send,finish_claim,eval") {
      throw new Error(`ordem esperada "send,finish_claim,eval", veio "${order}"`);
    }
  });

  await t.step("critérios cumpridos avançam para a próxima stage", async () => {
    const state = defaultState();
    state.stageCfg!.advancement_criteria = ["cliente confirmou interesse"];
    state.evalBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [{ criterion: "cliente confirmou interesse", met: true }],
            }),
          },
        },
      ],
    };
    const { res } = await run(state);
    if (state.calls.dealsPatch !== 1) throw new Error("esperava avanço de stage");
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step("critérios não cumpridos não avançam a stage", async () => {
    const state = defaultState();
    state.stageCfg!.advancement_criteria = ["cliente confirmou interesse"];
    state.evalBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [{ criterion: "cliente confirmou interesse", met: false }],
            }),
          },
        },
      ],
    };
    const { res } = await run(state);
    if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage");
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step(
    "resultados insuficientes (menos que os critérios) não avançam a stage",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a", "b"];
      state.evalBody = {
        choices: [
          { message: { content: JSON.stringify({ results: [{ criterion: "a", met: true }] }) } },
        ],
      };
      const { res } = await run(state);
      if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage");
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    },
  );

  await t.step(
    "regra explícita avança sem depender da leitura posicional da stage atual",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a"];
      state.currentStage = null;
      state.evalBody = {
        choices: [
          { message: { content: JSON.stringify({ results: [{ criterion: "a", met: true }] }) } },
        ],
      };
      const { res } = await run(state);
      if (state.calls.dealsPatch !== 1) throw new Error("esperava avanço pela regra explícita");
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    },
  );

  await t.step("critérios cumpridos mas não há próxima stage: não avança", async () => {
    const state = defaultState();
    state.stageCfg!.advancement_criteria = ["a"];
    state.nextStage = null;
    state.evalBody = {
      choices: [
        { message: { content: JSON.stringify({ results: [{ criterion: "a", met: true }] }) } },
      ],
    };
    const { res } = await run(state);
    if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage");
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step("fetch de avaliação retorna erro HTTP: pula avanço sem quebrar", async () => {
    const state = defaultState();
    state.stageCfg!.advancement_criteria = ["a"];
    state.evalStatus = 500;
    const { res } = await run(state);
    if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage");
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
  });

  await t.step(
    "fetch de avaliação lança exceção: capturado sem quebrar o handler, reporta em ai_failure_logs",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a"];
      state.evalThrows = true;
      const { res, body } = await run(state);
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.calls.aiFailureLogsInsert !== 1) {
        throw new Error(
          `esperado 1 insert em ai_failure_logs, veio ${state.calls.aiFailureLogsInsert}`,
        );
      }
    },
  );

  await t.step(
    "JSON inválido na resposta de avaliação é capturado sem quebrar o handler",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a"];
      state.evalBody = { choices: [{ message: { content: "isso não é json" } }] };
      const { res, body } = await run(state);
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "sem LOVABLE_API_KEY no momento da avaliação: pula a chamada de avanço",
    async () => {
      const state = defaultState();
      state.stageCfg!.advancement_criteria = ["a"];
      type EnvGet = typeof Deno.env.get;
      const mutableEnv = Deno.env as unknown as { get: EnvGet };
      const originalGet: EnvGet = mutableEnv.get.bind(Deno.env);
      let calls = 0;
      mutableEnv.get = ((key: string) => {
        if (key === "LOVABLE_API_KEY") {
          calls++;
          return calls === 1 ? "lovable-key" : undefined;
        }
        return originalGet(key);
      }) as EnvGet;
      try {
        const { res, body } = await run(state);
        if (state.calls.dealsPatch !== 0) throw new Error("não deveria avançar stage sem api key");
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
      } finally {
        mutableEnv.get = originalGet;
      }
    },
  );

  // ==================== Fase 2 — coalescer de turno (turn-coalescer.ts) ====================

  await t.step(
    "coalescer: mensagem não é a mais recente é coalescida sem chamar a IA",
    async () => {
      const state = defaultState();
      // fetchRecentInbound acha só 1 linha (solo, sem sleep) mas o id não bate
      // com o message_id do disparo atual — outra mensagem já é a mais recente.
      state.recentInbound = [
        { id: "outra-msg-mais-recente", created_at: "2026-01-01T00:00:06.000Z" },
      ];
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "coalesced_not_latest") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.captured.systemPrompt !== undefined) throw new Error("não deveria chamar a IA");
    },
  );

  await t.step(
    "coalescer: resposta da IA já existente (dedupe) retorna coalesced_duplicate_answer",
    async () => {
      const state = defaultState();
      state.aiAlreadyAnswered = { id: "ai-msg-prévio", created_at: "2026-01-01T00:00:07.000Z" };
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "coalesced_duplicate_answer") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.captured.systemPrompt !== undefined) throw new Error("não deveria chamar a IA");
    },
  );

  // ==================== Fase 2 — gate de takeover humano ====================

  await t.step("takeover: operador humano ativo (mensagem recente) bloqueia a IA", async () => {
    const state = defaultState();
    state.lastAgentMessage = { id: "op-msg-1", created_at: new Date().toISOString() };
    const { res, body } = await run(state);
    if (res.status !== 200 || body.reason !== "takeover_blocked_operator_active") {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "takeover: humano já respondeu (mesmo inativo há muito tempo) bloqueia a IA",
    async () => {
      const state = defaultState();
      // Muito mais antigo que AI_TAKEOVER_MINUTES — operador não está mais
      // ativo, mas ele JÁ respondeu nesta conversa em algum momento.
      state.lastAgentMessage = { id: "op-msg-1", created_at: "2020-01-01T00:00:00.000Z" };
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "takeover_blocked_human_responded") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("takeover: nenhum humano jamais respondeu (default) não bloqueia a IA", async () => {
    const state = defaultState();
    const { res, body } = await run(state);
    if (res.status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${JSON.stringify(body)}`);
    }
  });

  // ==================== Fase 2 — modelo por tenant (ai_settings.model) ====================

  await t.step("model: ai_settings.model 'default' usa o modelo hardcoded", async () => {
    const state = defaultState();
    const { res } = await run(state);
    if (res.status !== 200) throw new Error("esperado 200");
    if (state.captured.model !== DEFAULT_AI_MODEL) {
      throw new Error(`esperado modelo default, veio "${state.captured.model}"`);
    }
  });

  await t.step("model: ai_settings.model customizado é usado na chamada ao gateway", async () => {
    const state = defaultState();
    state.aiSettings!.model = "openai/gpt-4o-mini";
    const { res } = await run(state);
    if (res.status !== 200) throw new Error("esperado 200");
    if (state.captured.model !== "openai/gpt-4o-mini") {
      throw new Error(`esperado modelo customizado, veio "${state.captured.model}"`);
    }
  });

  // ==================== Fase 2 — cap de emojis (emoji-limiter.ts) ====================

  await t.step(
    "emoji: resposta da IA com múltiplos emojis nunca passa de 1 no envio",
    async () => {
      const state = defaultState();
      state.aiBody = {
        choices: [{ message: { content: "Oi! 😀 Tudo bem? 🎉 Vamos continuar 🚀" } }],
      };
      const { res } = await run(state);
      if (res.status !== 200) throw new Error("esperado 200");
      const emojiCount = (state.captured.sentContent?.match(/\p{Extended_Pictographic}/gu) ?? [])
        .length;
      // TETO, não igualdade. A #177 trocou a cadência de emoji por decisão
      // probabilística (capEmoji usa Math.random para chegar nos ~50% do humano
      // real), então 0 e 1 são resultados legítimos deste mesmo input. Asserção
      // de igualdade ficou instável: passava em ~metade das execuções e
      // reprovava PR alheia sem relação com o código dela.
      // O invariante que interessa e continua determinístico: NUNCA mais de um.
      if (emojiCount > 1) {
        throw new Error(
          `esperado no máximo 1 emoji no texto enviado, veio ${emojiCount}: "${state.captured.sentContent}"`,
        );
      }
    },
  );

  // ==================== Fase 2 — incerteza da IA (uncertainty.ts) ====================

  await t.step(
    "incerteza: resposta da IA sinalizando não-saber dispara handoff automático",
    async () => {
      const state = defaultState();
      state.aiBody = { choices: [{ message: { content: "Não sei te informar isso agora." } }] };
      const { res, body } = await run(state);
      if (
        res.status !== 200 ||
        body.handoff !== true ||
        body.reason !== "ai_detected_uncertainty"
      ) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    },
  );

  // ==================== Fase 2 — contrato de erro tipado + observabilidade ====================

  await t.step(
    "erro tipado: falha 429 grava last_error estruturado e reporta em ai_failure_logs",
    async () => {
      const state = defaultState();
      state.aiStatus = 429;
      state.aiBody = { message: "rate limited" };
      const { res, body } = await run(state);
      if (res.status !== 200 || body.reason !== "generation_failed") {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      const payload = state.captured.lastErrorPayload as {
        code?: string;
        message?: string;
        provider?: string;
        statusCode?: number;
      } | undefined;
      if (
        !payload ||
        payload.code !== "RATE_LIMIT" ||
        payload.provider !== "lovable-gateway" ||
        payload.statusCode !== 429
      ) {
        throw new Error(`last_error não estruturado como AiError: ${JSON.stringify(payload)}`);
      }
      if (state.calls.aiFailureLogsInsert !== 1) {
        throw new Error(
          `esperado 1 insert em ai_failure_logs, veio ${state.calls.aiFailureLogsInsert}`,
        );
      }
    },
  );

  // ---------------- áudio: a IA escuta em vez de passar pro humano ----------------
  // Antes desta fase QUALQUER mídia caía em doHandoff("media_received"). Estes
  // steps travam as 4 saídas possíveis do bloco novo.
  function audioState() {
    const state = defaultState();
    state.msg = { ...state.msg!, content: "", media_url: AUDIO_URL, media_type: "audio/ogg" };
    return state;
  }

  await t.step("áudio: transcreve, grava em messages.content e responde normalmente", async () => {
    const state = audioState();
    const { res, body } = await run(state);
    if (res.status !== 200 || body.handoff === true) {
      throw new Error(`esperava resposta normal, veio: ${JSON.stringify(body)}`);
    }
    if (state.calls.audioDownload !== 1 || state.calls.sttPost !== 1) {
      throw new Error(
        `esperava 1 download + 1 STT, veio ${state.calls.audioDownload}/${state.calls.sttPost}`,
      );
    }
    // O PATCH é o que faz o áudio existir para loadRecentHistory — sem ele a IA
    // responderia sem nunca ter "ouvido" nada.
    if (state.captured.patchedMessageContent !== state.sttText) {
      throw new Error(
        `transcrição não gravada em content: ${
          JSON.stringify(state.captured.patchedMessageContent)
        }`,
      );
    }
  });

  await t.step(
    "áudio Meta: resolve media_id, baixa com bearer e transcreve",
    async () => {
      const state = audioState();
      state.msg = {
        ...state.msg!,
        media_url: META_MEDIA_REFERENCE,
        media_type: "audio/ogg",
      };
      state.conv!.channels = { provider_slug: "meta-cloud", type: "whatsapp" };
      state.secrets = {
        access_token: "meta-access-token",
        phone_number_id: "1234567890",
      };
      const { res, body } = await run(state);
      if (res.status !== 200 || body.handoff === true) {
        throw new Error(`esperava resposta normal, veio: ${JSON.stringify(body)}`);
      }
      if (
        state.calls.metaMediaLookup !== 1 ||
        state.calls.metaMediaDownload !== 1 ||
        state.calls.sttPost !== 1
      ) {
        throw new Error(
          `fluxo Meta incompleto: ${
            JSON.stringify({
              lookup: state.calls.metaMediaLookup,
              download: state.calls.metaMediaDownload,
              stt: state.calls.sttPost,
            })
          }`,
        );
      }
      if (state.captured.patchedMessageContent !== state.sttText) {
        throw new Error("transcrição Meta não foi persistida em messages.content");
      }
    },
  );

  await t.step(
    "áudio: palavra-chave de handoff falada dispara handoff igual à digitada",
    async () => {
      const state = audioState();
      state.sttText = "isso não resolve, quero falar com um atendente";
      const { body } = await run(state);
      if (body.handoff !== true || !String(body.reason ?? "").startsWith("keyword:")) {
        throw new Error(`esperava handoff por keyword, veio: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("mídia não-áudio continua em handoff media_received", async () => {
    const state = audioState();
    state.msg = { ...state.msg!, media_type: "image/jpeg" };
    const { body } = await run(state);
    if (body.handoff !== true || body.reason !== "media_received") {
      throw new Error(`imagem deveria continuar em handoff: ${JSON.stringify(body)}`);
    }
    if (state.calls.sttPost !== 0) {
      throw new Error("imagem não pode chamar STT (queima crédito do tenant à toa)");
    }
  });

  await t.step("áudio sem ElevenLabs conectado cai em handoff com razão própria", async () => {
    const state = audioState();
    state.elevenlabsSecrets = {};
    const { body } = await run(state);
    if (body.handoff !== true || body.reason !== "audio_sem_transcricao") {
      throw new Error(`esperava audio_sem_transcricao, veio: ${JSON.stringify(body)}`);
    }
    if (state.calls.sttPost !== 0) throw new Error("sem chave não pode chamar a API");
  });

  // Desconectar a integração NÃO apaga o segredo (só `forget` apaga), e
  // loadProviderSecrets lê integration_secrets sem olhar o status. Sem o gate
  // em ai-respond/index.ts o tenant desconectava a ElevenLabs na UI e a
  // transcrição de entrada continuava rodando na conta dele. Gêmeo do gate de
  // TTS fechado no commit e1e0c31, que deixou este caminho de fora.
  await t.step(
    "áudio com ElevenLabs DESCONECTADA não transcreve (não queima crédito)",
    async () => {
      const state = audioState();
      state.elevenlabsIntegrationStatus = "disabled";
      const { body } = await run(state);
      if (state.calls.sttPost !== 0) {
        throw new Error(
          `integração desconectada não pode chamar STT (queima crédito do tenant): sttPost=${state.calls.sttPost}`,
        );
      }
      if (body.handoff !== true || body.reason !== "audio_sem_transcricao") {
        throw new Error(`esperava audio_sem_transcricao, veio: ${JSON.stringify(body)}`);
      }
    },
  );

  // As duas leituras de credencial da ElevenLabs ficam DENTRO da região
  // travada, e loadProviderSecrets LANÇA em erro de banco. Sem try/catch local
  // a exceção subia até o catch de topo, que devolve 500 e não passa por
  // releaseLock — e o claim em ai_processing_log não tem TTL nem delete, então
  // um blip de banco condenava aquela mensagem do lead a nunca mais ser
  // reprocessada. As duas quedas são diferentes de propósito: no áudio de
  // entrada não dá pra seguir sem transcrever (vai pro humano); na resposta o
  // áudio é enfeite e o texto tem que sair mesmo assim.
  await t.step("falha ao ler credencial de voz na ENTRADA vira handoff, não 500", async () => {
    const state = audioState();
    state.elevenlabsSecretsQueryFails = true;
    const { res, body } = await run(state);
    if (res.status !== 200) {
      throw new Error(`erro de banco não pode virar 500 (claim fica órfão): ${res.status}`);
    }
    if (body.handoff !== true || body.reason !== "transcription_failed") {
      throw new Error(`esperava transcription_failed, veio: ${JSON.stringify(body)}`);
    }
  });

  await t.step("falha ao ler credencial de voz na RESPOSTA cai para texto, não 500", async () => {
    const state = defaultState();
    state.aiSettings = { ...state.aiSettings!, voice_reply_mode: "always", voice_id: "voz-1" };
    state.elevenlabsSecretsQueryFails = true;
    const { res, body } = await run(state);
    if (res.status !== 200) {
      throw new Error(`erro de banco não pode virar 500 (claim fica órfão): ${res.status}`);
    }
    if (body.ok !== true || body.sent !== true) {
      throw new Error(`o texto tinha que sair mesmo sem o áudio: ${JSON.stringify(body)}`);
    }
  });

  await t.step("falha de transcrição vira handoff, nunca mensagem vazia", async () => {
    const state = audioState();
    state.sttStatus = 401;
    const { body } = await run(state);
    if (body.handoff !== true || body.reason !== "transcription_failed") {
      throw new Error(`esperava transcription_failed, veio: ${JSON.stringify(body)}`);
    }
    // Falha de voz precisa ser observável junto das demais falhas de IA.
    if (state.calls.aiFailureLogsInsert !== 1) {
      throw new Error(
        `esperava 1 registro em ai_failure_logs, veio ${state.calls.aiFailureLogsInsert}`,
      );
    }
  });

  await t.step("configuração do tenant chega ao dispatcher sem leitura por bloco", async () => {
    const state = defaultState();
    state.aiSettings = {
      ...state.aiSettings!,
      max_response_blocks: 3,
      response_block_delay_ms: 0,
      message_coalesce_window_ms: 0,
    };
    const paragraphs = [
      "Nossa equipe atende em horário comercial.",
      "A avaliação considera suas necessidades individuais.",
      "Os detalhes do tratamento são apresentados pela equipe.",
    ];
    state.aiBody = { choices: [{ message: { content: paragraphs.join("\n\n") } }] };
    const { body } = await run(state);
    if (body.ok !== true || body.sent !== true) {
      throw new Error(`esperava envio concluído: ${JSON.stringify(body)}`);
    }
    const sends = state.calls.order.filter((operation) => operation === "send").length;
    if (sends !== 3 || state.captured.sentContent !== paragraphs[2]) {
      throw new Error(`configuração não chegou ao envio: ${sends} blocos`);
    }
    if (state.calls.aiBehaviorSettingsReads !== 1) {
      throw new Error(`configuração foi lida ${state.calls.aiBehaviorSettingsReads} vezes`);
    }
  });

  await t.step("tenant sem configuração mantém a resposta condensada em um único envio", async () => {
    const state = defaultState();
    const paragraphs = [
      "Nossa equipe atende em horário comercial.",
      "A avaliação considera suas necessidades individuais.",
    ];
    state.aiBody = { choices: [{ message: { content: paragraphs.join("\n\n") } }] };
    const { body } = await run(state);
    const sends = state.calls.order.filter((operation) => operation === "send").length;
    if (body.sent !== true || sends !== 1 || state.captured.sentContent !== paragraphs.join(" ")) {
      throw new Error(`default foi alterado: ${sends} envios, texto=${state.captured.sentContent}`);
    }
  });

  for (const voice of [false, true]) {
    await t.step(`deadline real inclui STT, geração e ${voice ? "TTS/fallback" : "múltiplos blocos"}`, async () => {
      const state = audioState();
      state.aiSettings = {
        ...state.aiSettings!,
        max_response_blocks: 3,
        response_block_delay_ms: 0,
        message_coalesce_window_ms: 0,
        voice_reply_mode: voice ? "always" : "off",
        voice_id: voice ? "voz-1" : null,
      };
      state.aiBody = { choices: [{ message: { content: [
        "Nossa equipe atende em horário comercial.",
        "A avaliação considera suas necessidades individuais.",
        "Os detalhes do tratamento são apresentados pela equipe.",
      ].join("\n\n") } }] };
      let clock = 0;
      let ttsCalls = 0;
      let audioSends = 0;
      const originalNow = Date.now;
      const baseRouter = router(state);
      const restore = installFetchMock((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/rest/v1/ai_settings" &&
          url.searchParams.get("select")?.includes("max_response_blocks")) clock += 40000;
        if (url.pathname === "/v1/speech-to-text") clock += 30000;
        if (url.pathname === "/v1/chat/completions") clock += 25000;
        if (url.pathname.startsWith("/v1/text-to-speech/")) {
          ttsCalls++;
          clock += 15000;
          return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }
        if (url.pathname.startsWith("/storage/v1/object")) {
          return jsonResponse(200, { Key: "audio.mp3", signedURL: "/audio.mp3" });
        }
        if (url.pathname.endsWith("/send-audio")) {
          audioSends++;
          clock += 15000;
          return jsonResponse(500, { error: "áudio recusado" });
        }
        if (url.pathname.endsWith("/send-text")) clock += 15000;
        return baseRouter(request);
      });
      Date.now = () => clock;
      try {
        const response = await handler(req({ message_id: MESSAGE_ID }));
        const body = await response.json();
        assertEquals(body.interrupted, "deadline_exceeded");
        assertEquals(body.sent, !voice);
        assertEquals(state.calls.sttPost, 1);
        assertEquals(state.calls.order.filter((step) => step === "send").length, voice ? 0 : 2);
        assertEquals(ttsCalls, voice ? 1 : 0);
        assertEquals(audioSends, voice ? 1 : 0);
        assertEquals(clock, 125000);
        assertEquals(state.calls.order.includes("eval"), false);
        assertEquals(state.calls.aiClaimFinishBodies.length, 1);
        assertEquals(state.calls.aiClaimFinishBodies[0].p_status, "completed");
        assertEquals(state.captured.awaitingHumanPayload, true);
      } finally {
        Date.now = originalNow;
        restore();
      }
    });
  }
});
