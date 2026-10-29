import { createHash } from "node:crypto";

export const RUN_KEY = "imersao-clinica-ft/seed-v1";
export const EXPECTED_TENANT_NAME = "Clínica FT | Demonstração Imersão";
export const ANCHOR = "2026-10-15T15:00:00.000Z";
export const STAGE_NAMES = [
  "Novo Paciente",
  "Em Atendimento",
  "Qualificado",
  "Avaliação Agendada",
  "Proposta",
  "Ganho",
  "Perdido",
];
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export function uuidV5(name, namespace = DNS_NAMESPACE) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace))
    throw new Error("Namespace UUID inválido.");
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function seedId(tenantId, table, key) {
  return uuidV5(`${tenantId}|imersao-clinica-ft|seed-v1|${table}|${key}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function changedFields(current, desired, ignored = ["created_at", "updated_at"]) {
  return Object.fromEntries(
    Object.entries(desired).filter(([key, value]) => {
      if (ignored.includes(key)) return false;
      if (
        /_(at|since|until)$/.test(key) &&
        typeof value === "string" &&
        typeof current[key] === "string"
      ) {
        return Date.parse(value) !== Date.parse(current[key]);
      }
      return JSON.stringify(canonical(current[key])) !== JSON.stringify(canonical(value));
    }),
  );
}

const PEOPLE = [
  ["mariana-lopes", "Mariana Lopes", "Avaliação odontológica", 150, 2],
  ["bruno-almeida", "Bruno Almeida", "Limpeza preventiva", 250, 0],
  ["carolina-santos", "Carolina Santos", "Clareamento", 1200, 0],
  ["diego-rocha", "Diego Rocha", "Avaliação ortodôntica", 180, 0],
  ["elisa-martins", "Elisa Martins", "Limpeza preventiva", 250, 1],
  ["fabio-lima", "Fábio Lima", "Avaliação de implante", 200, 1],
  ["gabriela-costa", "Gabriela Costa", "Avaliação odontológica", 150, 1],
  ["henrique-dias", "Henrique Dias", "Clareamento", 1200, 2],
  ["isabela-melo", "Isabela Melo", "Avaliação ortodôntica", 180, 2],
  ["joao-farias", "João Farias", "Limpeza preventiva", 250, 3],
  ["karina-ramos", "Karina Ramos", "Avaliação odontológica", 150, 3],
  ["lucas-nunes", "Lucas Nunes", "Avaliação de implante", 200, 3],
  ["manuela-campos", "Manuela Campos", "Clareamento", 1200, 4],
  ["nicolas-reis", "Nicolas Reis", "Plano ortodôntico", 3200, 4],
  ["olivia-barros", "Olívia Barros", "Reabilitação odontológica", 4500, 4],
  ["paulo-teixeira", "Paulo Teixeira", "Limpeza preventiva", 250, 5],
  ["queila-moura", "Queila Moura", "Clareamento", 1200, 5],
  ["rafael-cardoso", "Rafael Cardoso", "Plano ortodôntico", 3200, 5],
  ["sofia-mendes", "Sofia Mendes", "Clareamento", 1200, 6],
  ["tiago-pinto", "Tiago Pinto", "Avaliação de implante", 200, 6],
  ["ursula-azevedo", "Úrsula Azevedo", "Avaliação odontológica", 150, 6],
  ["vitor-cunha", "Vitor Cunha", "Limpeza preventiva", 250, null],
  ["wanda-brito", "Wanda Brito", "Avaliação odontológica", 150, null],
  ["yara-duarte", "Yara Duarte", "Clareamento", 1200, null],
  ["zeca-tavares", "Zeca Tavares", "Avaliação ortodôntica", 180, null],
];
const LOSS_REASONS = [
  "Preferiu adiar por orçamento",
  "Escolheu clínica mais próxima",
  "Não deseja prosseguir neste momento",
];

export const STAGE_CONFIG = [
  {
    goal: "Acolher o novo paciente e identificar o serviço desejado.",
    criteria: [
      "Paciente informou como prefere ser chamado",
      "Paciente informou qual serviço deseja conhecer",
    ],
  },
  {
    goal: "Responder dúvidas de serviços, horários e valores sem diagnóstico clínico.",
    criteria: [
      "Interesse em avaliação confirmado explicitamente",
      "Preferência de dia e período registrada",
      "Canal de retorno autorizado pelo paciente",
    ],
  },
  {
    goal: "Oferecer uma avaliação compatível com a disponibilidade informada.",
    criteria: [
      "Dia e horário exatos confirmados pelo paciente",
      "Agendamento confirmado pela recepção",
    ],
  },
  {
    goal: "Confirmar comparecimento e encaminhar plano aprovado pelo dentista.",
    criteria: [
      "Recepção confirmou realização da avaliação",
      "Proposta revisada por profissional responsável",
    ],
  },
  {
    goal: "Esclarecer condições do plano e encaminhar aceite para conferência humana.",
    criteria: [
      "Paciente aceitou a proposta explicitamente",
      "Recepção confirmou aceite e condições de pagamento",
    ],
  },
  { goal: "Manter acompanhamento após aceite confirmado pela equipe.", criteria: [] },
  { goal: "Registrar motivo da perda e respeitar a preferência de não prosseguir.", criteria: [] },
];

const MARIANA_MESSAGES = [
  [
    "contact",
    "Olá! Sou Mariana Lopes. Vim pelo WhatsApp e gostaria de marcar uma avaliação odontológica.",
  ],
  [
    "ai",
    "Olá, Mariana! A Clínica FT atende avaliações, limpeza, clareamento e ortodontia. Qual é seu interesse? Esta é uma conversa fictícia de demonstração.",
  ],
  [
    "contact",
    "Quero uma avaliação e saber como funciona a limpeza. Quais dias e horários vocês atendem?",
  ],
  [
    "ai",
    "No cenário demonstrativo, atendemos de segunda a sexta, das 8h às 20h. Qual período funciona melhor para você?",
  ],
  ["contact", "Prefiro terça ou quinta, depois das 18h. Quero receber as opções pelo WhatsApp."],
  [
    "ai",
    "Anotei sua preferência. A avaliação demonstrativa custa R$ 150; procedimentos dependem da avaliação presencial. Posso pedir opções à recepção?",
  ],
  [
    "contact",
    "R$ 150 para a avaliação está dentro do que planejei. Sim, pode pedir as opções, mas ainda não confirme um horário.",
  ],
  [
    "ai",
    "Combinado: avaliação, terça ou quinta após 18h e retorno pelo WhatsApp. Sua ficha foi qualificada com essas informações, sem diagnóstico ou prontuário.",
  ],
  [
    "agent",
    "Mariana, aqui é a recepção da demonstração. Conferi suas preferências e encaminhei seu atendimento para escolha de horário.",
  ],
  ["contact", "Obrigada! Vou aguardar as opções e confirmar por aqui."],
  [
    "agent",
    "Deixei um lembrete interno para retornar com os horários. Nenhum agendamento foi confirmado ainda.",
  ],
  ["contact", "Perfeito, fico no aguardo pelo WhatsApp."],
];

function transcript(person, index) {
  if (index === 0) return MARIANA_MESSAGES;
  const [, name, service, value, stage] = person;
  const human = index === 4 || stage >= 4;
  const responder = human ? "agent" : "ai";
  const final = [
    "Obrigado. Ainda estou conhecendo a clínica; retorno quando decidir.",
    human
      ? "Quero continuar com uma pessoa da recepção, por favor."
      : "Preciso conferir meus horários antes de decidir.",
    "Tenho interesse na avaliação, prefiro o período da manhã e autorizo retorno pelo WhatsApp.",
    "Confirmo o horário que a recepção reservou para minha avaliação.",
    "Recebi a proposta após a avaliação. Quero conversar sobre as condições antes de aceitar.",
    "Aceito a proposta que a recepção conferiu. Obrigado pelo atendimento.",
    stage === 6 ? `Não vou prosseguir: ${LOSS_REASONS[index - 18].toLowerCase()}.` : "",
  ][stage];
  return [
    ["contact", `Olá, sou ${name}. Gostaria de informações sobre ${service.toLowerCase()}.`],
    [
      responder,
      "Bem-vindo à Clínica FT. Este atendimento é fictício, exclusivo da demonstração. Podemos explicar serviços e horários sem substituir uma consulta.",
    ],
    ["contact", "Como funciona a avaliação e qual é o valor neste exemplo?"],
    [
      responder,
      `Neste cenário, o valor de referência de ${service.toLowerCase()} é R$ ${value.toFixed(2).replace(".", ",")}. O plano só é confirmado pela equipe após avaliação presencial.`,
    ],
    ["contact", final],
    [
      responder,
      stage === 6
        ? "Registramos o motivo e respeitaremos sua decisão, sem novos disparos."
        : stage === 5
          ? "Aceite conferido pela recepção. Negócio concluído neste cenário de demonstração."
          : stage === 3
            ? "A recepção confirmou a reserva demonstrativa; o lembrete permanece apenas interno."
            : "Preferências registradas. A recepção dará continuidade neste cenário de demonstração.",
    ],
  ];
}

export function buildDataset({
  tenantId,
  profileId,
  boardId,
  stages,
  providerSlug,
  anchor = ANCHOR,
}) {
  const id = (table, key) => seedId(tenantId, table, key);
  const at = (daysAgo, minutes = 0) =>
    new Date(Date.parse(anchor) - daysAgo * 86400000 + minutes * 60000).toISOString();
  if (!Number.isFinite(Date.parse(anchor))) throw new Error("Data de referência inválida.");
  const stageIds = STAGE_NAMES.map((name) => {
    const stage = stages.find((item) => item.name === name);
    if (!stage) throw new Error(`Estágio obrigatório ausente: ${name}`);
    return stage.id;
  });
  const marker = `[${RUN_KEY}]`;
  // status_message pertence ao reconciliador do provedor; o nome demonstrativo fica em config.
  const dataset = {
    channels: [
      {
        id: id("channels", "demonstracao"),
        tenant_id: tenantId,
        provider_slug: providerSlug,
        type: providerSlug === "simulator" ? "simulator" : "whatsapp",
        status: "disconnected",
        config: {
          _demo_seed: RUN_KEY,
          name: "Demonstração Clínica FT (desconectado)",
          locale: "pt-BR",
          currency: "BRL",
          timezone: "America/Sao_Paulo",
        },
      },
    ],
    custom_field_definitions: [],
    contacts: [],
    conversations: [],
    deals: [],
    messages: [],
    activities: [],
    deal_followups: [],
  };
  dataset.custom_field_definitions = [
    ["servico_interesse", "Serviço de interesse", "text"],
    ["periodo_preferido", "Período preferido", "text"],
    ["canal_preferido", "Canal preferido", "text"],
    ["orcamento_informado", "Valor informado na demonstração (BRL)", "currency"],
  ].map(([key, label, field_type], position) => ({
    id: id("custom_field_definitions", key),
    tenant_id: tenantId,
    entity: "contact",
    key,
    label,
    field_type,
    required: false,
    position,
  }));
  PEOPLE.forEach((person, index) => {
    const [key, name, service, value, stage] = person;
    const created = at(29 - index);
    const contactId = id("contacts", key);
    const preferred = index === 0 ? "Após 18h, terça ou quinta" : "A confirmar com a recepção";
    dataset.contacts.push({
      id: contactId,
      tenant_id: tenantId,
      name,
      phone: `+55119000000${String(index + 1).padStart(2, "0")}`,
      email: `${key}@example.com`,
      source: "demo_seed",
      tags: ["demo_seed", "WhatsApp"],
      status: "lead",
      owner_id: profileId,
      ai_paused: true,
      description: "Pessoa fictícia para demonstração; nenhum dado clínico real.",
      address_city: "São Paulo",
      address_state: "SP",
      address_country: "BR",
      created_at: created,
      updated_at: created,
      custom_fields: {
        _demo_seed: RUN_KEY,
        servico_interesse: service,
        periodo_preferido: preferred,
        canal_preferido: "WhatsApp",
        orcamento_informado: value,
      },
      ai_memory:
        index === 0
          ? {
              personality: "Objetiva e cordial",
              preferences: ["Contato pelo WhatsApp", "Terça ou quinta após 18h"],
              history_summary:
                "Mariana procurou avaliação pelo WhatsApp. Perguntou sobre serviços, horários e valores. Informou disponibilidade e confirmou que R$ 150 para avaliação cabe em seu planejamento. Autorizou retorno, mas ainda aguarda opções; não há consulta confirmada.",
              important_dates: [],
              relationship_notes:
                "Cenário fictício preparado para demonstração; memória semeada, não produzida por consolidação de IA.",
            }
          : null,
    });
    if (stage === null) return;
    const conversationId = id("conversations", key);
    const dealId = id("deals", key);
    const lines = transcript(person, index);
    const messages = lines.map(([sender, content], messageIndex) => ({
      id: id("messages", `${key}:${messageIndex + 1}`),
      tenant_id: tenantId,
      conversation_id: conversationId,
      direction: sender === "contact" ? "in" : "out",
      sender,
      content,
      status: "sent",
      external_id: `demo:${RUN_KEY}:${key}:${messageIndex + 1}`,
      send_attempts: 0,
      audio_status: "not_requested",
      created_at: at(29 - index, 30 + messageIndex * 4),
    }));
    dataset.messages.push(...messages);
    const last = messages.at(-1);
    const closed = stage === 5 || stage === 6;
    // O trigger de handoff controla awaiting_human_since; retroagir esse campo quebra a trilha de SLA.
    dataset.conversations.push({
      id: conversationId,
      tenant_id: tenantId,
      contact_id: contactId,
      channel_id: dataset.channels[0].id,
      subject: `${marker} ${service} | ${name}`,
      status: closed ? "closed" : "open",
      ai_active: false,
      awaiting_human: index === 4,
      last_message_at: last.created_at,
      unread_count: last.direction === "in" && !closed ? 1 : 0,
      created_at: created,
      updated_at: created,
    });
    dataset.deals.push({
      id: dealId,
      tenant_id: tenantId,
      board_id: boardId,
      stage_id: stageIds[stage],
      contact_id: contactId,
      title: `${service} | ${name}`,
      value,
      owner_id: profileId,
      status: stage === 5 ? "won" : stage === 6 ? "lost" : "open",
      closed_at: closed ? last.created_at : null,
      lost_reason: stage === 6 ? LOSS_REASONS[index - 18] : null,
      stage_entered_at: last.created_at,
      automation_mode: "paused",
      custom_fields: {
        _demo_seed: RUN_KEY,
        currency: "BRL",
        origem: "WhatsApp",
        qualificado: stage >= 2 && stage <= 5,
      },
      created_at: created,
      updated_at: created,
    });
    if (index < 16)
      dataset.activities.push({
        id: id("activities", key),
        tenant_id: tenantId,
        contact_id: contactId,
        deal_id: dealId,
        owner_id: profileId,
        type: index === 4 ? "call" : "task",
        title:
          index === 0
            ? "Retornar à Mariana com opções de avaliação após 18h"
            : `Recepção: acompanhar ${name}`,
        metadata: {
          _demo_seed: RUN_KEY,
          note:
            index === 4
              ? "Takeover: atendimento humano solicitado"
              : "Atividade interna da demonstração; não dispara mensagens",
        },
        due_at: at((index % 4) - 1),
        completed_at: index > 10 ? at(1) : null,
        created_at: created,
        updated_at: created,
      });
    if (index < 10)
      dataset.deal_followups.push({
        id: id("deal_followups", key),
        tenant_id: tenantId,
        contact_id: contactId,
        deal_id: dealId,
        created_by: profileId,
        source: "manual",
        ai_suggested: false,
        description: `${marker} ${index === 0 ? "Mariana: apresentar opções terça ou quinta após 18h, pelo WhatsApp, sem confirmar consulta." : `Verificar interesse de ${name} em ${service.toLowerCase()}.`}`,
        scheduled_at: at((index % 5) - 1),
        status: index >= 7 ? "completed" : "pending",
        completed_at: index >= 7 ? at(1) : null,
        completed_by: index >= 7 ? profileId : null,
        created_at: created,
        updated_at: created,
      });
  });
  const sequenceSpecs = [
    {
      key: "confirmacao",
      name: "Confirmação de Avaliação Agendada",
      description:
        "Ao entrar em Avaliação Agendada, envia na primeira janela de atendimento. Não consulta data da agenda nem confirma que a consulta ocorre hoje.",
      trigger_type: "stage_change",
      trigger_stage_id: stageIds[3],
      steps: [
        [
          0,
          "Olá {{contact.name}}, sua avaliação foi agendada pela recepção. Confira a data e o horário combinados na conversa. Precisa ajustar alguma informação?",
        ],
        [
          24,
          "Olá {{contact.name}}, ficou alguma dúvida sobre sua avaliação? A recepção pode conferir os detalhes do agendamento com você.",
        ],
      ],
    },
    {
      key: "reativacao",
      name: "Reativação de Proposta Parada",
      description:
        "Scanner horário: negócio aberto há pelo menos 7 dias no estágio Proposta. Mede stage_entered_at, não tempo desde a última mensagem.",
      trigger_type: "stagnant",
      trigger_stage_id: stageIds[4],
      stagnant_days: 7,
      steps: [
        [
          0,
          "Olá {{contact.name}}, ficou alguma dúvida sobre a proposta apresentada pela equipe? Se desejar, a recepção pode ajudar a esclarecer as condições.",
        ],
        [
          72,
          "{{contact.name}}, você gostaria de conversar com a recepção sobre sua proposta? Se preferir não continuar, avise por aqui.",
        ],
      ],
    },
    {
      key: "recall",
      name: "Recall Periódico de Pacientes Finalizados",
      description:
        "Scanner horário: contato com negócio ganho. Primeira inscrição imediata se não houver histórico; novas inscrições somente 90 dias após completed_at da inscrição anterior, inclusive cancelamento. Negócio ganho não comprova tratamento concluído. Não agenda por data clínica.",
      trigger_type: "periodic",
      periodic_days: 90,
      steps: [
        [
          0,
          "Olá {{contact.name}}, gostaria de conversar com a recepção sobre acompanhamento ou uma nova avaliação? A frequência de retorno depende da orientação do profissional responsável.",
        ],
      ],
    },
  ];
  dataset.nurture_sequences = sequenceSpecs.map(({ key, steps, ...spec }) => ({
    id: id("nurture_sequences", key),
    tenant_id: tenantId,
    channel_id: dataset.channels[0].id,
    ...spec,
    description: `${marker} ${spec.description}`,
    is_active: false,
    notify_owner: false,
    created_at: at(29),
    updated_at: at(29),
  }));
  dataset.nurture_steps = sequenceSpecs.flatMap((spec) =>
    spec.steps.map(([delay_hours, message], index) => ({
      id: id("nurture_steps", `${spec.key}:${index + 1}`),
      sequence_id: id("nurture_sequences", spec.key),
      step_number: index + 1,
      delay_hours,
      message_template: `[Demonstração Clínica FT] ${message}`,
      created_at: at(29),
      updated_at: at(29),
    })),
  );
  return dataset;
}
