// evolution-client.ts — cliente da API Evolution Go (WhatsApp self-hosted), Fase 5.
//
// Porta a lógica REAL do provider Evolution do medflow-v0 (fonte de verdade,
// somente leitura, nunca copiado literalmente porque aquele repo usa classe +
// Next.js/npm e este projeto é Deno-puro/funcional):
// - lib/messaging/providers/whatsapp/evolution.provider.ts (send/status/QR)
// - lib/messaging/providers/whatsapp/evolution.schema.ts (nomes de credenciais)
// - supabase/functions/evolution-watchdog/index.ts (status/reconnect — é a
//   versão REALMENTE deployada em produção, endpoints /instance/status e
//   /instance/reconnect com token por instância, timeout via AbortSignal)
// - tests/edge-functions/_helpers/evolutionGoPayloads.ts +
//   supabase/functions/messaging-webhook-evolution/normalize.ts (shape real
//   do payload de webhook inbound)
//
// Estilo: mesmo padrão funcional de provider-send.ts (sem classe, sem
// npm:/CDN), reaproveitando o SendResult já exportado de lá (nenhum tipo
// paralelo de resultado de envio).
import type { SendResult } from "./provider-send.ts";
import { validatePublicHttpsUrl } from "../validate-http-url.ts";
import { redactSecrets } from "../redact-secrets.ts";

// =============================================================================
// TIPOS — CREDENCIAIS
// =============================================================================

/**
 * Credenciais Evolution Go por tenant/canal.
 *
 * `api_url`/`instance_name` são metadado não sensível (podem viver em
 * `channels.config`); `api_key`/`instance_token` são segredo (sempre em
 * `integration_secrets`, nunca em `channels.config` — mesma convenção de
 * zapi/twilio/meta-cloud/resend em provider-send.ts).
 *
 * `instance_token` é opcional porque o fluxo de enriquecimento que descobre o
 * token por instância a partir da API key global (`GET /instance/all`, ver
 * evolution-onboarding.ts do medflow-v0) está fora do escopo desta fase. Sem
 * enriquecimento, `api_key` funciona como o próprio token de instância — o
 * mesmo fallback que evolution.provider.ts já assume nativamente:
 * `this.instanceToken = credentials.instanceToken ?? credentials.apiKey`.
 */
export interface EvolutionCredentials {
  api_url: string;
  instance_name: string;
  api_key: string;
  instance_token?: string;
}

// =============================================================================
// TIPOS — PAYLOAD INBOUND (webhook)
// =============================================================================

/**
 * Campo `data.Info` de eventos "Message"/"SendMessage" da Evolution Go.
 * Shape real confirmado em evolutionGoPayloads.ts (fixtures) e
 * messaging-webhook-evolution/normalize.ts (normalizador em produção).
 */
export interface EvolutionInboundMessageInfo {
  ID: string;
  IsFromMe: boolean;
  IsGroup: boolean;
  Chat: string;
  Sender: string;
  SenderAlt?: string;
  PushName: string;
  Timestamp: string;
  Type: string;
  MediaType?: string;
}

/**
 * Payload bruto recebido no webhook da Evolution Go — envelope comum a todos
 * os eventos ("Message", "SendMessage", "Connected", "LoggedOut",
 * "ConnectFailure", "Receipt", ...). `instanceToken` no corpo é usado como
 * segundo fator de autenticação do webhook (comparado contra
 * `credentials.instance_token` do canal), igual ao `messaging-webhook-evolution`
 * do medflow-v0.
 */
export interface EvolutionInboundPayload {
  event: string;
  instanceId: string;
  instanceName: string;
  instanceToken: string;
  /** Presente em eventos "Receipt" (ex.: "Delivered" | "Read"). */
  state?: string;
  data: {
    Info?: EvolutionInboundMessageInfo;
    Message?: Record<string, unknown>;
    MessageIDs?: string[];
    Chat?: string | { User: string; Server: string };
    Timestamp?: string;
  };
}

// =============================================================================
// TIPOS — STATUS / RECONEXÃO
// =============================================================================

/**
 * Estado de conexão retornado por `GET /instance/status` da Evolution Go.
 *
 * NÃO inclui "waiting_qr": nenhum endpoint de status real da Evolution Go
 * devolve esse estado (`/instance/status` só devolve `{data:{Connected}}`,
 * `/instance/all` só devolve `connected:true/false`). "Aguardando QR" só é
 * conhecido quando `reconnectEvolutionInstance` retorna um `qrCode` — é o
 * chamador (reconciliação/watchdog) quem compõe os dois resultados para
 * decidir o vocabulário completo de `channels.status`.
 */
export type EvolutionConnectionState = "connected" | "disconnected" | "error";

export interface EvolutionInstanceStatus {
  state: EvolutionConnectionState;
  message?: string;
}

export interface EvolutionReconnectResult {
  ok: boolean;
  qrCode?: string;
  error?: string;
}

// =============================================================================
// HELPERS INTERNOS
// =============================================================================

function evolutionBaseUrl(cred: EvolutionCredentials): string {
  return cred.api_url.replace(/\/+$/, "");
}

/**
 * Resultado da descoberta do token de instância (ver
 * `resolveEvolutionInstanceToken`). Nunca lança — erro vira `{ok:false}`.
 */
export interface EvolutionTokenResolution {
  ok: boolean;
  token?: string;
  error?: string;
}

interface EvolutionAllInstancesBody {
  data?: Array<{ name?: string; token?: string }>;
  error?: string;
}

/**
 * Descobre o token da instância a partir da GLOBAL_API_KEY.
 *
 * Por que isto existe: `/instance/status`, `/instance/qr`,
 * `/instance/reconnect` e `/send/*` NÃO recebem o nome da instância em lugar
 * nenhum (ver OpenAPI oficial evo-go-instance.yaml) — a instância é resolvida
 * exclusivamente pelo header `apikey`, que precisa ser o token DAQUELA
 * instância. Mandar a chave global nesses endpoints devolve HTTP 401, que era
 * exatamente o sintoma relatado ("Evolution respondeu HTTP 401 em
 * /instance/status" com a instância pareada e funcionando).
 *
 * `GET /instance/all` é global (aceita a GLOBAL_API_KEY) e devolve
 * `data[] = { name, token, connected, ... }` — daí sai o token por nome.
 */
export async function resolveEvolutionInstanceToken(
  cred: EvolutionCredentials,
): Promise<EvolutionTokenResolution> {
  if (cred.instance_token) return { ok: true, token: cred.instance_token };
  if (!cred.api_url || !cred.instance_name || !cred.api_key) {
    return { ok: false, error: "Integração Evolution (WhatsApp self-hosted) não configurada." };
  }

  // Anti-SSRF: api_url é gravável por admin via PostgREST, valida antes do fetch.
  const urlCheck = await validatePublicHttpsUrl(cred.api_url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL da integração Evolution inválida." };
  }

  try {
    const r = await fetch(`${evolutionBaseUrl(cred)}/instance/all`, {
      headers: { apikey: cred.api_key },
      signal: AbortSignal.timeout(15_000),
    });

    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      console.error(
        `[evolution] /instance/all respondeu HTTP ${r.status}:`,
        redactSecrets(bodyText).slice(0, 300),
      );
      if (r.status === 401 || r.status === 403) {
        return {
          ok: false,
          error:
            "A chave global (GLOBAL_API_KEY) foi recusada pelo servidor Evolution Go. Confira o valor no .env do servidor.",
        };
      }
      return { ok: false, error: friendlyEvolutionHttp(r.status, bodyText) };
    }

    const body = (await r.json().catch(() => ({}) as EvolutionAllInstancesBody)) as
      EvolutionAllInstancesBody;
    if (body.error) return { ok: false, error: body.error };

    const wanted = cred.instance_name.trim().toLowerCase();
    const instances = Array.isArray(body.data) ? body.data : [];
    const match = instances.find((i) => (i.name ?? "").trim().toLowerCase() === wanted);

    if (!match) {
      const names = instances.map((i) => i.name).filter(Boolean).join(", ");
      return {
        ok: false,
        error: `A instância "${cred.instance_name}" não existe neste servidor Evolution Go.${
          names ? ` Instâncias encontradas: ${names}.` : ""
        }`,
      };
    }
    if (!match.token) {
      return {
        ok: false,
        error:
          `A instância "${cred.instance_name}" existe, mas o servidor não devolveu o token dela. Informe o token da instância manualmente.`,
      };
    }

    return { ok: true, token: match.token };
  } catch (err) {
    console.error("[evolution] falha de rede em /instance/all:", err);
    return { ok: false, error: "Falha de rede ao consultar as instâncias da Evolution." };
  }
}

function friendlyEvolutionHttp(status: number, bodyText: string): string {
  if (status === 401 || status === 403) {
    return "Credenciais da Evolution (WhatsApp self-hosted) não estão mais válidas. Reconecte a integração.";
  }
  if (status >= 500) {
    return "O servidor Evolution está indisponível no momento. Tente de novo em instantes.";
  }
  if (status === 429) {
    return "O servidor Evolution pediu para aguardar um pouco antes de enviar de novo.";
  }
  // A Evolution Go devolve 400 {"error":"invalid base64 encoding"} quando o
  // campo `url` de /send/media não é nem link http(s) nem base64 puro (data URI
  // com prefixo cai aqui). Mensagem crua não ajuda o dono da PME.
  if (bodyText.toLowerCase().includes("invalid base64 encoding")) {
    return "O servidor Evolution recusou o formato do arquivo de áudio. Tente novamente em instantes; se persistir, verifique se o servidor Evolution consegue acessar a internet para baixar a mídia.";
  }
  // Status desconhecido (ex.: 400/402/422 fora do caso "não registrado no
  // WhatsApp" já tratado acima): status e corpo (redigido, truncado) vão para
  // a mensagem — sem isso, todo 4xx não mapeado virava a mesma frase inútil
  // e o reason_detail persistido em channel_status_events ficava
  // indiagnosticável (docs/PLANO-OBSERVABILIDADE-2026-08-04.md).
  const detail = redactSecrets(bodyText).slice(0, 300);
  return `Não foi possível enviar a mensagem pelo WhatsApp self-hosted (Evolution) — HTTP ${status}.${
    detail ? ` Detalhe: ${detail}` : ""
  }`;
}

/**
 * Normaliza telefone para o formato esperado por `/send/*` da Evolution Go
 * (somente dígitos, sem "+"). Números BR no formato legado de 12 dígitos
 * (55 + DDD + 8 dígitos) recebem o "9" obrigatório de celular após o DDD,
 * produzindo o formato de 13 dígitos exigido.
 *
 * Trade-off (herdado de medflow-v0 phone-formatter.ts): a condição
 * `startsWith('55') && length === 12` também casa com fixos BR (mesma
 * contagem de dígitos). Aceitável neste domínio (contatos de CRM em
 * WhatsApp são majoritariamente celulares); um fixo que passasse por aqui
 * falharia no envio como "não registrado no WhatsApp".
 */
function normalizePhoneForEvolution(to: string): string {
  const rawDigits = to.replace(/\D/g, "");
  return rawDigits.startsWith("55") && rawDigits.length === 12
    ? `${rawDigits.slice(0, 4)}9${rawDigits.slice(4)}`
    : rawDigits;
}

// =============================================================================
// ENVIO
// =============================================================================

interface EvolutionSendResponseBody {
  data?: { Info?: { ID?: string; Chat?: string }; message?: string };
  message?: string;
  error?: string;
}

/**
 * Envia uma mensagem de texto via Evolution Go (`POST /send/text`).
 *
 * Não captura exceção de rede (fetch rejeitando) — mesma convenção dos
 * outros 4 adaptadores em provider-send.ts (sendZapi/sendTwilio/
 * sendMetaCloud/sendResend): só uma falha HTTP real vira `{ok:false,error}`,
 * falha de rede propaga como exceção para o caller decidir.
 */
export async function sendEvolutionMessage(
  cred: EvolutionCredentials,
  phone: string,
  content: string,
): Promise<SendResult> {
  if (!cred.api_url || !cred.instance_name || !(cred.instance_token || cred.api_key)) {
    return { ok: false, error: "Integração Evolution (WhatsApp self-hosted) não configurada." };
  }

  // Endpoints por instância exigem o token DA INSTÂNCIA (a chave global
  // devolve 401 — ver resolveEvolutionInstanceToken).
  const auth = await resolveEvolutionInstanceToken(cred);
  if (!auth.ok || !auth.token) {
    return { ok: false, error: auth.error ?? "Não foi possível identificar a instância Evolution." };
  }
  const instanceToken = auth.token;

  // Anti-SSRF: revalida a api_url no boundary do fetch. Um admin pode gravar
  // `channels.config.api_url` direto via PostgREST, driblando o guard do fluxo
  // integration-connect; sem esta checagem, um IP interno/loopback/metadata
  // vazaria por aqui. Ver _shared/validate-http-url.ts.
  const urlCheck = await validatePublicHttpsUrl(cred.api_url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL da integração Evolution inválida." };
  }

  const number = normalizePhoneForEvolution(phone);
  if (!number) return { ok: false, error: "Contato sem telefone cadastrado." };

  // Evolution Go usa o campo "id" do corpo como o stanzaID da mensagem
  // WhatsApp — NÃO como identificador da instância (essa é resolvida pelo
  // header apikey). Reenviar o mesmo "id" faz o WhatsApp descartar a
  // mensagem como duplicata; por isso um stanzaID aleatório novo é gerado a
  // cada envio (mesmo padrão de evolution.provider.ts `sendReq`).
  const stanzaId = crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 20);

  // Único fetch deste arquivo que estava sem deadline — status/reconnect/qr já
  // tinham. E era justo o do caminho quente: o envio roda dentro do lock de
  // conversa do ai-respond e o servidor Evolution é SELF-HOSTED pelo cliente,
  // ou seja, um host que aceita a conexão e nunca responde é cenário realista,
  // não hipótese. Sem teto, o isolate ficava preso até o wall-clock da
  // plataforma e o claim em ai_processing_log (sem TTL, sem delete) condenava a
  // mensagem daquele lead. 15s = mesmo valor de POST de texto do resto do repo.
  const r = await fetch(`${evolutionBaseUrl(cred)}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: instanceToken },
    body: JSON.stringify({ id: stanzaId, number, text: content }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!r.ok) {
    const bodyText = await r.text().catch(() => "");
    // String match é um contrato com o formato de erro atual da Evolution Go
    // (mesmo caso documentado em evolution.provider.ts). Se a mensagem mudar,
    // cai no fallback genérico por status HTTP abaixo.
    if (bodyText.includes("is not registered on WhatsApp")) {
      return { ok: false, error: `O número ${phone} não está registrado no WhatsApp.` };
    }
    return { ok: false, error: friendlyEvolutionHttp(r.status, bodyText) };
  }

  const data = (await r.json().catch(() => ({}) as EvolutionSendResponseBody)) as EvolutionSendResponseBody;

  if (data.error) return { ok: false, error: data.error };

  // Evolution Go retorna falhas como HTTP 200 com { message: "..." } e SEM
  // "data" (ex.: instância desconectada) — não lança erro HTTP, precisa ser
  // checado à parte (mesmo caso documentado em evolution.provider.ts).
  if (!data.data) {
    return { ok: false, error: data.message ?? "Evolution não retornou confirmação de envio." };
  }

  const externalId = data.data.Info?.ID?.trim() || null;
  return { ok: true, external_id: externalId };
}

/**
 * Envia áudio (nota de voz) via Evolution Go (`POST /send/media`, doc oficial
 * https://docs.evolutionfoundation.com.br/evolution-go/send-a-media-message).
 *
 * O corpo documentado do `SendMedia` leva `number`, `type` e `url`. O servidor
 * busca o arquivo nesse endereço; por isso o caller passa um link assinado e de
 * vida curta do bucket privado `ai-audio`. Quando o servidor não consegue
 * buscar o link (rede fechada para fora, por exemplo), o mesmo endpoint é
 * tentado com o áudio embutido como data URI — segunda e última tentativa antes
 * de o despacho cair para texto.
 *
 * Nunca lança por erro do provider: devolve `{ok:false,error}` (mesmo contrato
 * de sendAudioViaProvider).
 */
export async function sendEvolutionAudio(
  cred: EvolutionCredentials,
  phone: string,
  audio: { bytes: ArrayBuffer; mime: string; signedUrl?: string },
): Promise<SendResult> {
  if (!cred.api_url || !cred.instance_name || !(cred.instance_token || cred.api_key)) {
    return { ok: false, error: "Integração Evolution (WhatsApp self-hosted) não configurada." };
  }

  const auth = await resolveEvolutionInstanceToken(cred);
  if (!auth.ok || !auth.token) {
    return { ok: false, error: auth.error ?? "Não foi possível identificar a instância Evolution." };
  }

  // Anti-SSRF no boundary do fetch, igual ao envio de texto.
  const urlCheck = await validatePublicHttpsUrl(cred.api_url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL da integração Evolution inválida." };
  }

  const number = normalizePhoneForEvolution(phone);
  if (!number) return { ok: false, error: "Contato sem telefone cadastrado." };

  const endpoint = `${evolutionBaseUrl(cred)}/send/media`;
  // A Evolution Go aceita em `url` um link http(s) OU o conteúdo em base64
  // PURO. Data URI (`data:audio/mpeg;base64,...`) é recusado com
  // 400 {"error":"invalid base64 encoding"}.
  const rawBase64 = evolutionBase64(audio.bytes);
  // Link assinado primeiro (payload pequeno); base64 como segunda tentativa.
  const candidates = audio.signedUrl ? [audio.signedUrl, rawBase64] : [rawBase64];
  const filename = evolutionAudioFilename(audio.mime);

  let lastError = "Evolution não retornou confirmação de envio do áudio.";
  for (const mediaUrl of candidates) {
    const stanzaId = crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 20);
    let r: Response;
    try {
      r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: auth.token },
        body: JSON.stringify({
          id: stanzaId,
          number,
          type: "audio",
          filename,
          url: mediaUrl,
        }),
        // Mídia é mais pesada que texto: mesmo teto usado nos outros
        // adaptadores de áudio (provider-send.ts).
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error("[evolution] falha de rede em /send/media:", err);
      lastError = "Falha de rede ao enviar o áudio pela Evolution.";
      continue;
    }

    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      if (bodyText.includes("is not registered on WhatsApp")) {
        return { ok: false, error: `O número ${phone} não está registrado no WhatsApp.` };
      }
      lastError = friendlyEvolutionHttp(r.status, bodyText);
      continue;
    }

    const data = (await r.json().catch(() => ({}) as EvolutionSendResponseBody)) as
      EvolutionSendResponseBody;
    if (data.error) {
      lastError = data.error;
      continue;
    }
    if (!data.data) {
      lastError = data.message ?? "Evolution não retornou confirmação de envio do áudio.";
      continue;
    }
    return { ok: true, external_id: data.data.Info?.ID?.trim() || null };
  }

  return { ok: false, error: lastError };
}

/**
 * base64 em blocos — spread de Uint8Array inteiro estoura o stack em áudios de
 * poucos segundos (mesma técnica de provider-send.ts).
 */
function evolutionBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Nome de arquivo exigido pelo schema de /send/media. Sem extensão coerente com
 * o mime, o WhatsApp pode tratar o áudio como documento.
 */
function evolutionAudioFilename(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("ogg")) return "audio.ogg";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "audio.m4a";
  if (m.includes("amr")) return "audio.amr";
  return "audio.mp3";
}



// =============================================================================
// STATUS
// =============================================================================

interface EvolutionStatusResponseBody {
  data?: { Connected?: boolean };
  error?: string;
}

/**
 * Consulta `GET /instance/status` — endpoint realmente usado em produção por
 * evolution-watchdog/index.ts (evoStatus). Diferente de sendEvolutionMessage,
 * captura falha de rede/timeout e devolve `{state:"error"}` em vez de lançar:
 * este cliente é consumido por crons (reconciliação/watchdog) que precisam
 * seguir para o próximo canal mesmo se um servidor Evolution estiver fora do
 * ar — mesmo contrato de evoStatus/evoReconnect no watchdog real (que
 * capturam e devolvem null/false, nunca deixam a exceção subir).
 */
export async function checkEvolutionInstanceStatus(
  cred: EvolutionCredentials,
): Promise<EvolutionInstanceStatus> {
  // Anti-SSRF: valida a api_url (gravável direto em channels.config por admin
  // via PostgREST) antes de qualquer fetch. Ver _shared/validate-http-url.ts.
  const urlCheck = await validatePublicHttpsUrl(cred.api_url);
  if (!urlCheck.ok) {
    return { state: "error", message: urlCheck.error ?? "URL da integração Evolution inválida." };
  }

  // `/instance/status` não recebe o nome da instância: ela é identificada pelo
  // token no header `apikey`. Com a chave global o servidor responde 401.
  const auth = await resolveEvolutionInstanceToken(cred);
  if (!auth.ok || !auth.token) {
    return {
      state: "error",
      message: auth.error ?? "Não foi possível identificar a instância Evolution.",
    };
  }
  const instanceToken = auth.token;

  try {
    const r = await fetch(`${evolutionBaseUrl(cred)}/instance/status`, {
      headers: { apikey: instanceToken },
      signal: AbortSignal.timeout(15_000),
    });

    if (!r.ok) {
      return { state: "error", message: `Evolution respondeu HTTP ${r.status} em /instance/status.` };
    }

    const body = (await r.json().catch(() => ({}) as EvolutionStatusResponseBody)) as EvolutionStatusResponseBody;
    if (body.error) return { state: "error", message: body.error };

    // HTTP 200 sem "error" mas também sem "data" é uma resposta que este
    // cliente não sabe interpretar -- NÃO é o mesmo que a Evolution confirmar
    // "desconectado". Tratar como "disconnected" aqui alimentaria
    // messaging-channels-reconcile/runner.ts (reconcileEvolutionStatus)
    // sobrescrevendo incondicionalmente um canal em `waiting_qr` só porque a
    // API devolveu um corpo malformado/inesperado -- ver a mesma proteção do
    // lado do runner (skip de canais transitórios). Só "connected"/
    // "disconnected" são estados CONFIRMADOS pela API; corpo ambíguo é
    // "error", igual a uma falha HTTP.
    if (body.data === undefined) {
      return {
        state: "error",
        message: "Resposta inesperada da Evolution em /instance/status (sem campo data).",
      };
    }

    return { state: body.data.Connected === true ? "connected" : "disconnected" };
  } catch (err) {
    // A mensagem crua do runtime é em inglês e chega na UI (status_message do
    // canal e erro do "Testar conexão"). Fica no log, não na tela.
    console.error("[evolution] falha de rede em /instance/status:", err);
    return { state: "error", message: "Falha de rede ao consultar status da Evolution." };
  }
}

// =============================================================================
// RECONEXÃO
// =============================================================================

interface EvolutionQrResponseBody {
  data?: { qrcode?: string };
  error?: string;
}

/**
 * Eventos assinados no webhook da instância. Lista explícita (em vez de "ALL")
 * porque só estes têm normalizador no messaging-webhook — assinar o resto só
 * geraria tráfego descartado. Nomes conforme a documentação oficial:
 * https://docs.evolutionfoundation.com.br/evolution-go/webhooks
 */
const EVOLUTION_WEBHOOK_EVENTS = [
  "MESSAGE",
  "SEND_MESSAGE",
  "CONNECTION",
  "QRCODE",
  "READ_RECEIPT",
] as const;

/**
 * Conecta a instância JÁ instalando o webhook desta app nela
 * (`POST /instance/connect`, documentação oficial do Evolution Go).
 *
 * É o único momento em que a Evolution Go aceita configurar `webhookUrl` —
 * sem esta chamada, o dono do remix precisaria colar a URL à mão no painel
 * do servidor Evolution para que o inbound chegasse.
 *
 * Nunca lança: falha de rede/HTTP vira `{ok:false,error}` (mesmo contrato
 * tolerante de reconnectEvolutionInstance).
 */
export async function connectEvolutionInstance(
  cred: EvolutionCredentials,
  webhookUrl: string,
): Promise<EvolutionReconnectResult> {
  // Anti-SSRF: api_url é gravável por admin via PostgREST, valida antes do fetch.
  const urlCheck = await validatePublicHttpsUrl(cred.api_url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL da integração Evolution inválida." };
  }

  try {
    const r = await fetch(`${evolutionBaseUrl(cred)}/instance/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // `apikey` é a GLOBAL_API_KEY do servidor; `instanceId` identifica a
        // instância a conectar (documentação oficial).
        apikey: cred.api_key,
        instanceId: cred.instance_name,
      },
      body: JSON.stringify({
        webhookUrl,
        subscribe: [...EVOLUTION_WEBHOOK_EVENTS],
        immediate: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      console.error(
        `[evolution] /instance/connect respondeu HTTP ${r.status}:`,
        redactSecrets(bodyText).slice(0, 300),
      );
      return { ok: false, error: friendlyEvolutionHttp(r.status, bodyText) };
    }

    const body = (await r.json().catch(() => ({}) as EvolutionQrResponseBody)) as
      EvolutionQrResponseBody;
    const qrCode = body.data?.qrcode;
    return qrCode ? { ok: true, qrCode } : { ok: true };
  } catch (err) {
    console.error("[evolution] falha de rede em /instance/connect:", err);
    return { ok: false, error: "Falha de rede ao conectar a instância Evolution." };
  }
}

/**
 * Dispara reconexão da instância e, se necessário, devolve um QR code novo.
 *
 * Dois passos, cada um fiel a uma fonte real distinta do medflow-v0:
 * 1. `POST /instance/reconnect` — mesmo endpoint/timeout de
 *    evolution-watchdog/index.ts (evoReconnect): reconecta com a sessão já
 *    salva no servidor, sem QR, se a sessão ainda for válida.
 * 2. `GET /instance/qr` — mesmo endpoint de evolution.provider.ts
 *    (getQrCode): só é necessário quando a sessão foi invalidada (logout) e
 *    o reconnect sozinho não bastou. Ausência de QR aqui é o caso de
 *    sucesso mais comum (sessão existente reconectou sem precisar de scan).
 *
 * Nunca lança: falha de rede em qualquer um dos dois passos vira
 * `{ok:false,error}` (passo 1) ou é absorvida como sucesso sem QR (passo 2,
 * já que a reconexão em si já foi confirmada) — mesmo contrato tolerante a
 * falha do watchdog real.
 */
export async function reconnectEvolutionInstance(
  cred: EvolutionCredentials,
): Promise<EvolutionReconnectResult> {
  // Anti-SSRF: valida a api_url (gravável direto em channels.config por admin
  // via PostgREST) antes de qualquer fetch. Ver _shared/validate-http-url.ts.
  const urlCheck = await validatePublicHttpsUrl(cred.api_url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL da integração Evolution inválida." };
  }

  // Reconexão e QR também são por instância — exigem o token da instância.
  const auth = await resolveEvolutionInstanceToken(cred);
  if (!auth.ok || !auth.token) {
    return { ok: false, error: auth.error ?? "Não foi possível identificar a instância Evolution." };
  }
  const instanceToken = auth.token;



  let reconnectOk: boolean;
  try {
    const r = await fetch(`${evolutionBaseUrl(cred)}/instance/reconnect`, {
      method: "POST",
      headers: { apikey: instanceToken, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    reconnectOk = r.ok;
  } catch (err) {
    console.error("[evolution] falha de rede em /instance/reconnect:", err);
    return { ok: false, error: "Falha de rede ao reconectar a instância Evolution." };
  }

  if (!reconnectOk) {
    return { ok: false, error: "Evolution recusou o pedido de reconexão." };
  }

  try {
    const r = await fetch(
      `${evolutionBaseUrl(cred)}/instance/qr?id=${encodeURIComponent(cred.instance_name)}`,
      { headers: { apikey: instanceToken }, signal: AbortSignal.timeout(15_000) },
    );
    if (!r.ok) return { ok: true };

    const body = (await r.json().catch(() => ({}) as EvolutionQrResponseBody)) as EvolutionQrResponseBody;
    const qrCode = body.data?.qrcode;
    return qrCode ? { ok: true, qrCode } : { ok: true };
  } catch {
    // Reconexão já confirmada no passo 1 — falha ao buscar QR não invalida o resultado.
    return { ok: true };
  }
}
