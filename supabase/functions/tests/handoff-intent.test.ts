// Testa matchHandoffReason (supabase/functions/_shared/ai/handoff-intent.ts).
// Função pura, sem I/O — não precisa de mock de rede/env.
//
// O `reason` devolvido depende do array de keywords, então todo caso aqui usa
// DEFAULT_KEYWORDS (cópia fiel de DEFAULT_HANDOFF_KEYWORDS em
// _shared/ai/gates.ts, o valor de fábrica de ai_settings.handoff_default_keywords)
// ou uma extensão explícita simulando keyword configurada pelo tenant. Testar
// com uma lista inventada mediria ficção: em ai-respond/index.ts a chamada real
// é matchHandoffReason(texto, [...stageHandoffKeywords, ...defaultKeywords]).
//
// Asserção é sempre o reason EXATO (nunca "!== null"): trocar
// "keyword:human_handoff" por "keyword:atendente" é regressão de roteamento
// (muda o motivo gravado na conversa) e precisa quebrar aqui.
import { matchHandoffReason } from "../_shared/ai/handoff-intent.ts";

// Espelha gates.ts:31-37. Se aquele array mudar, este teste passa a medir outra
// coisa — atualizar os dois juntos.
const DEFAULT_KEYWORDS = [
  "falar com humano",
  "atendente",
  "pessoa real",
  "agendar",
  "marcar",
];

function expectReason(text: string, keywords: string[], expected: string | null): void {
  const actual = matchHandoffReason(text, keywords);
  if (actual !== expected) {
    throw new Error(
      `matchHandoffReason(${JSON.stringify(text)}) => ${JSON.stringify(actual)}, esperado ${
        JSON.stringify(expected)
      }`,
    );
  }
}

Deno.test("matchHandoffReason — pedido explícito de humano", async (t) => {
  await t.step('"Quero falar com uma pessoa" → human_handoff', () => {
    // Nenhuma keyword configurada é HUMAN_KEYWORD contida no texto ("atendente"
    // e "pessoa real" não aparecem), então cai no reason genérico.
    expectReason("Quero falar com uma pessoa", DEFAULT_KEYWORDS, "keyword:human_handoff");
  });

  await t.step('"Me passa para um atendente" → keyword:atendente', () => {
    // Aqui a keyword configurada "atendente" ESTÁ no texto e é HUMAN_KEYWORD,
    // então o reason nomeia a keyword em vez do genérico.
    expectReason("Me passa para um atendente", DEFAULT_KEYWORDS, "keyword:atendente");
  });

  await t.step("caixa alta e acento não escapam da detecção", () => {
    // normalizeMessagingText (lowercase + NFD sem marcas) é o único motivo dos
    // patterns, todos sem flag /i e sem acento, casarem aqui.
    expectReason("QUERO FALAR COM UMA PESSOA", DEFAULT_KEYWORDS, "keyword:human_handoff");
    expectReason("Não quero falar com robô", DEFAULT_KEYWORDS, "keyword:human_handoff");
  });

  await t.step("recusa explícita de IA/bot dispara handoff", () => {
    expectReason("nao quero conversar com uma ia", DEFAULT_KEYWORDS, "keyword:human_handoff");
    expectReason("Não quero mais conversar com robô", DEFAULT_KEYWORDS, "keyword:human_handoff");
  });

  await t.step("pedido curto e transferência também casam", () => {
    expectReason("gostaria de falar com um humano", DEFAULT_KEYWORDS, "keyword:human_handoff");
    expectReason("me transfere para um agente", DEFAULT_KEYWORDS, "keyword:human_handoff");
  });
});

Deno.test("matchHandoffReason — negativos de controle", async (t) => {
  await t.step("menção histórica a atendente NÃO transfere", () => {
    // "atendente" é keyword configurada E está no texto, mas o loop pula
    // HUMAN_KEYWORD sem intenção explícita. Se este caso voltar a casar, toda
    // conversa que cita atendimento passado vira handoff.
    expectReason("o atendente me disse ontem que...", DEFAULT_KEYWORDS, null);
  });

  await t.step("'marcar' sem contexto de agendamento NÃO transfere", () => {
    // "marcar" é keyword configurada e está no texto, mas SCHEDULING_CONTEXT
    // não bate (nenhum de agenda/horario/consulta/reuniao/...).
    expectReason("já tentei marcar e não consegui", DEFAULT_KEYWORDS, null);
  });

  await t.step("sem keyword configurada, só o pedido explícito sobrevive", () => {
    // Controle positivo do controle negativo: prova que o null acima vem da
    // regra, não de o texto simplesmente nunca casar nada.
    expectReason("Quero falar com uma pessoa", [], "keyword:human_handoff");
    expectReason("quero agendar uma consulta", [], null);
  });
});

Deno.test("matchHandoffReason — keyword de agendamento exige contexto", async (t) => {
  await t.step('"quero agendar uma consulta" casa agendamento, não handoff', () => {
    // "consulta" satisfaz SCHEDULING_CONTEXT, então "agendar" passa. O reason
    // NÃO pode ser human_handoff: agendar é fluxo da IA, não transferência.
    expectReason("quero agendar uma consulta", DEFAULT_KEYWORDS, "keyword:agendar");
  });
});

// Os 5 exemplos de intenção do escopo do MVP, verbatim. Nenhum depende de
// keyword configurada pelo tenant: todos precisam disparar com os defaults de
// fábrica, senão um tenant novo não transfere ninguém.
Deno.test("matchHandoffReason — os 5 exemplos do escopo disparam com os defaults", async (t) => {
  // O reason é "human_handoff" quando nenhuma keyword configurada aparece no
  // texto, e a própria keyword quando aparece — "atendente" está nos defaults,
  // então a frase 2 grava keyword:atendente. Ambos transferem; o que muda é o
  // motivo registrado na conversa.
  const EXEMPLOS_DO_ESCOPO: Array<[string, string]> = [
    ["Quero falar com uma pessoa.", "keyword:human_handoff"],
    ["Me passa para um atendente.", "keyword:atendente"],
    ["Não quero continuar falando com a IA.", "keyword:human_handoff"],
    ["Preciso falar com o comercial.", "keyword:human_handoff"],
    ["Quero conversar com alguém responsável.", "keyword:human_handoff"],
  ];

  for (const [frase, esperado] of EXEMPLOS_DO_ESCOPO) {
    await t.step(frase, () => {
      expectReason(frase, DEFAULT_KEYWORDS, esperado);
    });
  }
});

// Variações da recusa de IA que o pattern antigo deixava passar: artigo
// definido ("com A ia"), gerúndio ("falando") e verbo interposto ("continuar").
Deno.test("matchHandoffReason — variações da recusa de IA", async (t) => {
  await t.step("artigo definido antes de ia/bot", () => {
    expectReason("Não quero falar com a IA", DEFAULT_KEYWORDS, "keyword:human_handoff");
    expectReason("Não quero mais falar com o bot", DEFAULT_KEYWORDS, "keyword:human_handoff");
    expectReason("nao quero falar com o chatbot", DEFAULT_KEYWORDS, "keyword:human_handoff");
  });

  await t.step("gerúndio e verbo interposto", () => {
    expectReason("Não quero continuar falando com a IA", DEFAULT_KEYWORDS, "keyword:human_handoff");
    expectReason(
      "não desejo seguir conversando com o robô",
      DEFAULT_KEYWORDS,
      "keyword:human_handoff",
    );
  });

  await t.step("palavra que TERMINA em ia não é a IA", () => {
    // Sem \b antes do "ia" em "familia"/"gestoria"/"dia" — é justamente por
    // isso que "ia" vive no pattern e não na lista de keywords por substring.
    expectReason("nao quero falar com a familia dele", DEFAULT_KEYWORDS, null);
    expectReason("nao quero falar com a gestoria hoje", DEFAULT_KEYWORDS, null);
  });
});

// Papel humano citado de passagem, sem verbo de intenção, NÃO transfere — é o
// que separa "quero falar com o gerente" de "o gerente já sabe disso".
Deno.test("matchHandoffReason — cargo sem pedido não transfere", async (t) => {
  await t.step("menção a comercial/responsável sem intenção", () => {
    expectReason("o comercial já me mandou a proposta ontem", DEFAULT_KEYWORDS, null);
    expectReason("quem é o responsável por esse setor mesmo?", DEFAULT_KEYWORDS, null);
  });

  await t.step("cargo sem verbo de fala NÃO transfere", () => {
    // Estes são o motivo de HUMAN_ROLE (cargos) e HUMAN_TARGET (papéis de
    // atendimento) serem listas diferentes: o padrão curto "quero <alvo>"
    // aceita só HUMAN_TARGET. Se alguém unificar as duas, estes viram handoff.
    expectReason("quero vendedor com experiência", DEFAULT_KEYWORDS, null);
    expectReason("quero gerente de projeto", DEFAULT_KEYWORDS, null);
    expectReason("preciso do gerente aprovar o desconto", DEFAULT_KEYWORDS, null);
    expectReason("quero um plano comercial mais barato", DEFAULT_KEYWORDS, null);
    // ...mas com verbo de fala ou de transferência, transfere.
    expectReason("me passa para o gerente", DEFAULT_KEYWORDS, "keyword:human_handoff");
  });

  await t.step("keyword do tenant continua devolvendo o reason dela", () => {
    // Quando o tenant configura o próprio termo, o reason gravado é a keyword
    // (normalizada, sem acento) — não o genérico human_handoff.
    expectReason(
      "preciso do financeiro",
      [...DEFAULT_KEYWORDS, "financeiro"],
      "keyword:financeiro",
    );
  });
});
