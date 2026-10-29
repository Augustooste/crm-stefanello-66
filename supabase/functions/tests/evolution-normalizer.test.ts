// Leitura das mensagens recebidas/ecoadas pelo Evolution Go.
//
// Contexto (2026-09-17): o eco do próprio áudio de diagnóstico caía no caso
// final e virava a bolha "[mensagem não suportada]" no inbox, sem arquivo e
// sem nenhum rastro da estrutura original.
import {
  describeEvolutionMessageShape,
  normalizeEvolutionInbound,
} from "../_shared/messaging/normalizers.ts";
import type { EvolutionInboundPayload } from "../_shared/messaging/evolution-client.ts";

function payload(
  message: Record<string, unknown>,
  info: Record<string, unknown> = {},
): EvolutionInboundPayload {
  return {
    data: {
      Info: {
        ID: "ABC123",
        Chat: "554599022026@s.whatsapp.net",
        IsFromMe: false,
        Type: "media",
        Timestamp: "2026-09-17T15:19:50Z",
        PushName: "Fulano",
        ...info,
      },
      Message: message,
    },
  } as unknown as EvolutionInboundPayload;
}

Deno.test("evolution: eco do áudio enviado não vira '[mensagem não suportada]'", () => {
  const out = normalizeEvolutionInbound(
    payload(
      { audioMessage: { url: "https://mmg.whatsapp.net/a.enc", mimetype: "audio/ogg" } },
      { IsFromMe: true, MediaType: "audio" },
    ),
  );
  if (!out) throw new Error("eco foi descartado");
  if (out.content !== "[áudio enviado]") {
    throw new Error(`rótulo errado: ${out.content}`);
  }
  if (!out.fromMe) throw new Error("eco perdeu a marca de mensagem própria");
});

Deno.test("evolution: áudio recebido com arquivo embutido guarda a mídia", () => {
  const out = normalizeEvolutionInbound(
    payload({
      audioMessage: { mimetype: "audio/ogg; codecs=opus", base64: "QUJD", mediaKey: "k1" },
    }),
  );
  if (!out?.media?.base64) throw new Error("arquivo embutido foi perdido");
  if (out.media.type !== "audio/ogg") throw new Error(`mime errado: ${out.media.type}`);
  if (out.media.key !== "k1") throw new Error("mediaKey perdida");
  if (!out.content.includes("áudio")) throw new Error(`marcador errado: ${out.content}`);
});

Deno.test("evolution: chaves com inicial maiúscula também são reconhecidas", () => {
  const out = normalizeEvolutionInbound(
    payload({ AudioMessage: { Url: "https://x/a.enc", Mimetype: "audio/mp4" } }),
  );
  if (!out?.media) throw new Error("variação de maiúsculas não reconhecida");
  if (out.media.type !== "audio/mp4") throw new Error(`mime errado: ${out.media.type}`);
});

Deno.test("evolution: mensagem ver-uma-vez é descascada", () => {
  const out = normalizeEvolutionInbound(
    payload({ viewOnceMessageV2: { message: { conversation: "oi" } } }),
  );
  if (out?.content !== "oi") throw new Error(`texto perdido: ${out?.content}`);
});

Deno.test("evolution: evento interno do WhatsApp nunca vira bolha", () => {
  for (const key of ["protocolMessage", "senderKeyDistributionMessage", "reactionMessage"]) {
    const out = normalizeEvolutionInbound(payload({ [key]: { x: 1 } }));
    if (out !== null) throw new Error(`${key} virou mensagem`);
  }
});

Deno.test("evolution: texto simples continua funcionando", () => {
  const out = normalizeEvolutionInbound(
    payload({ conversation: "bom dia" }, { Type: "text" }),
  );
  if (out?.content !== "bom dia") throw new Error(`texto errado: ${out?.content}`);
});

Deno.test("evolution: resumo estrutural não vaza conteúdo nem chave de mídia", () => {
  const shape = describeEvolutionMessageShape(
    payload({
      audioMessage: { mediaKey: "segredo", base64: "QUJD", mimetype: "audio/ogg" },
    }),
  );
  const serialized = JSON.stringify(shape);
  if (serialized.includes("segredo") || serialized.includes("QUJD")) {
    throw new Error(`resumo vazou dado sensível: ${serialized}`);
  }
  if (!serialized.includes("audioMessage")) {
    throw new Error(`resumo não lista os campos: ${serialized}`);
  }
});
