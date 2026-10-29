import { expect } from "@playwright/test";
import { EXPECTED_TENANT_NAME, STAGE_NAMES } from "../../scripts/imersao-clinica-ft/dataset.mjs";

export const DEFAULT_BASE_URL = "https://aceleraflow-remix.lovable.app";
export const VIEWPORT = { width: 1440, height: 900 };
export const MARIANA = "Mariana Lopes";
const PROD_MARIANA = {
  conversationId: "a924c735-15c3-4cf5-b1d4-0a89a7b96b2d",
  contactId: "5ffc5ce7-db42-4b64-9851-bee047951a7b",
};

export function assertionProfile(value = process.env.IMERSAO_PROFILE ?? "prod") {
  if (value !== "prod" && value !== "branch") {
    throw new Error("Perfil inválido: use prod ou branch.");
  }
  return value;
}

export function requiredCredentials() {
  const email = process.env.CLINICA_FT_EMAIL;
  const password = process.env.CLINICA_FT_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "CLINICA_FT_EMAIL e CLINICA_FT_PASSWORD são obrigatórios; carregue credentials.env sem exibir seu conteúdo.",
    );
  }
  return { email, password };
}

export function safeError(error) {
  let message = error instanceof Error ? error.message : "Falha na captura.";
  for (const key of ["CLINICA_FT_PASSWORD", "SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"]) {
    if (process.env[key]) message = message.replaceAll(process.env[key], "[SEGREDO OMITIDO]");
  }
  return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[TOKEN OMITIDO]");
}

/** @param {import('@playwright/test').Page} page */
export async function expectWorkspace(page) {
  await expect(
    page.getByText(EXPECTED_TENANT_NAME, { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
export async function expectHealthyPage(page) {
  await expect(page).not.toHaveURL(/\/(auth|onboarding)(?:[/?#]|$)/);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(
    page.locator(
      '[data-testid="skeleton"]:visible, [aria-busy="true"]:visible, .animate-pulse:visible, .animate-spin:visible',
    ),
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(
    page.getByRole("status").filter({ hasText: /^(Carregando|Consultando)/ }),
  ).toHaveCount(0);
  await expect(
    page
      .getByText(
        /^(404|Not Found|Página não encontrada|Algo deu errado|Erro ao carregar.*|Não foi possível (carregar|ler|consultar).*)$/i,
      )
      .filter({ visible: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: /erro|falha|não foi possível|error|failed/i }),
  ).toHaveCount(0);
  await expectWorkspace(page);
}

/** @param {import('@playwright/test').Page} page */
export async function openPage(page, route) {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });
  if (!response || response.status() >= 400) {
    throw new Error(`Navegação recusada: ${route} (HTTP ${response?.status() ?? "ausente"}).`);
  }
  await expect(page).toHaveURL(
    (url) => url.pathname === new URL(route, "https://captura.invalid").pathname,
  );
  await expectWorkspace(page);
}

/** Login sem trace, vídeo, HAR ou screenshot; tokens permanecem apenas no contexto. */
export async function signInClinica(page) {
  const { email, password } = requiredCredentials();
  try {
    await page.goto("/auth", { waitUntil: "domcontentloaded" });
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    const field = page.getByLabel("Senha", { exact: true });
    await expect(field).toHaveAttribute("type", "password");
    // O valor não entra no título de uma ação fill nem em um artefato do reporter.
    await field.evaluate((input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:[/?#]|$)/, { timeout: 30_000 });
  } catch {
    throw new Error(
      "Login da Clínica FT falhou; detalhes de autenticação omitidos para proteger credenciais.",
    );
  }
  // O contexto é novo; o aviso só aparece depois que o perfil termina de carregar.
  const consent = page.getByRole("dialog", { name: "Aviso de privacidade", exact: true });
  await consent.getByRole("button", { name: "Entendi", exact: true }).click({ timeout: 30_000 });
  await expect(consent).toBeHidden();
  await expectWorkspace(page);
}

export async function openAiSettings(page) {
  await openPage(page, "/configuracoes");
  await page.getByRole("tab", { name: "IA", exact: true }).click();
  await page.getByRole("tab", { name: "Assistente", exact: true }).click();
  await page.getByRole("tab", { name: "Configuração", exact: true }).click();
}

export async function verifyOnboarding(page) {
  // Estado aplicado, não execução do wizard: reaplicar o template apagaria a configuração da demonstração.
  await verifyKanban(page);
  await openPage(page, "/configuracoes");
  await page.getByRole("tab", { name: "Empresa", exact: true }).click();
  await expect(page.getByLabel("Nome da empresa", { exact: true })).toHaveValue(
    EXPECTED_TENANT_NAME,
  );
  await expect(
    page.getByRole("dialog").filter({ hasText: /onboarding|bem-vindo|configuração inicial/i }),
  ).toHaveCount(0);
  await expectHealthyPage(page);
}

export async function verifyAiSettings(page) {
  await openAiSettings(page);
  const prompt = page.getByLabel("Prompt base do assistente", { exact: true });
  // O editor guarda o template; o nome da Clínica FT é interpolado apenas ao usar o prompt.
  await expect(prompt).toHaveValue(
    /assistente da equipe da \{\{empresa\}\}, clínica odontológica/i,
  );
  await expect(page.getByRole("radio", { name: "Automático", exact: true })).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Rascunho para aprovação", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('#send-mode-auto[aria-checked="true"], #send-mode-draft[aria-checked="true"]'),
  ).toHaveCount(1);
  const stage = page.getByRole("button", { name: /^Em Atendimento\b/ });
  await stage.getByText("Em Atendimento", { exact: true }).click();
  await expect(page.getByLabel("Objetivo do estágio", { exact: true })).toHaveValue(/\S/);
  await expect(page.getByLabel("Prompt do estágio", { exact: true })).toHaveValue(/\S/);
  await expect(page.getByText("Proposta", { exact: true }).filter({ visible: true })).toBeVisible();
  await expectHealthyPage(page);
  await prompt.scrollIntoViewIfNeeded();
}

// O comportamento por tenant foi publicado em produção em 16/10/2026: os dois perfis
// verificam o mesmo card.
export async function verifyBehavior(page, profile) {
  await openAiSettings(page);
  const heading = page.getByRole("heading", { name: "Comportamento das respostas", exact: true });
  await expect(heading).toBeVisible();
  const blocks = page.getByLabel("Máximo de blocos por resposta", { exact: true });
  await expect(blocks).toBeEnabled();
  await expect(blocks).toHaveValue(/^[1-5]$/);
  await expect(page.getByLabel("Intervalo entre blocos (ms)", { exact: true })).toHaveValue(
    /^\d+$/,
  );
  await expect(page.getByLabel("Janela de agrupamento (ms)", { exact: true })).toHaveValue(/^\d+$/);
  if (profile === "prod") {
    await expect(blocks).toHaveValue("3");
    await expect(page.getByLabel("Intervalo entre blocos (ms)", { exact: true })).toHaveValue(
      "1500",
    );
    await expect(page.getByLabel("Janela de agrupamento (ms)", { exact: true })).toHaveValue(
      "3000",
    );
  }
  for (const name of ["Sempre em texto", "Espelhar o cliente", "Sempre em áudio"]) {
    await expect(page.getByRole("radio", { name, exact: true })).toBeVisible();
  }
  await expectHealthyPage(page);
  await heading.scrollIntoViewIfNeeded();
}

export async function selectDatasetPeriod(page) {
  await page.getByRole("combobox", { name: "Selecionar período do filtro global" }).click();
  await page.getByRole("option", { name: "Últimos 90 dias", exact: true }).click();
}

export async function verifyInbox(page, profile) {
  await openPage(
    page,
    profile === "prod"
      ? `/inbox?mode=lista&conversationId=${PROD_MARIANA.conversationId}`
      : "/inbox?mode=lista",
  );
  await selectDatasetPeriod(page);
  await page.getByRole("textbox", { name: "Buscar conversa", exact: true }).fill(MARIANA);
  const conversation = page
    .getByRole("listbox", { name: "Lista de conversas" })
    .getByRole("button", {
      name: /Mariana Lopes SIMULAÇÃO/,
    });
  await expect(conversation).toHaveCount(1);
  await conversation.click();
  await expect(page.getByRole("heading", { name: MARIANA, exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Nova mensagem", exact: true })).toBeVisible();
  if (profile === "branch") {
    await expect(
      page
        .getByRole("heading", { name: MARIANA, exact: true })
        .locator("..")
        .getByText("Simulação — não entregue no WhatsApp", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/^Para mim, quinta-feira, 22 de outubro, às 18h30 funciona\./),
    ).toBeVisible();
    await expect(
      page.getByText(
        /^Mariana, aqui é a recepção da Clínica FT\. Seu agendamento está confirmado:/,
      ),
    ).toBeVisible();
  } else {
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("conversationId") === PROD_MARIANA.conversationId,
    );
    await expect(
      page
        .getByRole("heading", { name: MARIANA, exact: true })
        .locator("..")
        .getByText("Simulação — não entregue no WhatsApp", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Moro em Campinas e prefiro marcar a avaliação na terça ou quinta depois das 18h.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Meu e-mail é mariana.lopes.demo@example.com. Prefiro que a recepção retorne pelo WhatsApp para combinar o agendamento.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole("heading", { name: MARIANA, exact: true })
        .locator("..")
        .getByText("IA pausada", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reativar IA", exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Oi, Mariana! Aqui é a recepção da Clínica FT. Temos quinta às 18h30 para a avaliação. Posso confirmar?",
        { exact: true },
      ),
    ).toBeVisible();
  }
  await expectHealthyPage(page);
}

export async function verifyContact(page, profile) {
  if (profile === "prod") {
    await openPage(page, `/contatos/${PROD_MARIANA.contactId}`);
    await expect(page.getByRole("heading", { name: MARIANA, exact: true })).toBeVisible();
  } else {
    await openPage(page, "/contatos");
    await page.getByRole("textbox", { name: "Buscar contatos", exact: true }).fill(MARIANA);
    await page
      .getByRole("row")
      .filter({ hasText: MARIANA })
      .getByText(MARIANA, { exact: true })
      .click();
  }
  await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]+(?:[?#]|$)/i);
  await page.getByRole("tab", { name: "Memória IA", exact: true }).click();
  if (profile === "branch") {
    await expect(
      page.getByRole("heading", { name: "Perfil consolidado", exact: true }),
    ).toBeVisible();
    const memory = page
      .getByRole("heading", { name: "Perfil consolidado", exact: true })
      .locator("..")
      .locator("+ div");
    await expect(memory).toContainText("Mariana Lopes");
    await expect(memory).toContainText(/avaliação odontológica/i);
    await expect(memory).toContainText(/terças?.*quintas?.*18h/i);
    await expect(memory).toContainText("WhatsApp");
    await expectHealthyPage(page);
    // A homologação mantém o negócio anterior e posterior ao avanço real registrado no GIF.
    await expect(
      page.getByText(
        /^Avaliação odontológica \| Mariana Lopes · (Qualificado|Avaliação Agendada)$/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Informações extraídas pela IA", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^Ver mensagem-fonte / }).first()).toBeVisible();
    await expect(
      page
        .getByRole("heading", { name: "Resumos de interações recentes", exact: true })
        .locator("..")
        .locator("+ div")
        .getByRole("listitem")
        .first(),
    ).toBeVisible();
    const qualification = page
      .getByRole("region", { name: "Qualificação por IA", exact: true })
      .getByRole("article", { name: "Avaliação odontológica | Mariana Lopes", exact: true });
    await expect(qualification).toBeVisible();
    await expect(qualification.getByText(/^Confiança: \d{1,3}%$/)).toBeVisible();
    await expect(qualification.getByText(/^Baseada em [1-9]\d* mensagens?$/)).toBeVisible();
    await expect(
      qualification.getByRole("heading", { name: "Resumo executivo", exact: true }).locator("+ p"),
    ).toHaveText(/\S/);
  } else {
    const extractionsHeading = page.getByRole("heading", {
      name: "Informações extraídas pela IA",
      exact: true,
    });
    await expect(extractionsHeading).toBeVisible();
    const extractions = extractionsHeading.locator("..").locator("+ div");
    await expect(extractions).toContainText("Campinas");
    await expect(extractions).toContainText(/terça.*quinta.*18h/i);
    await expect(extractions).toContainText("WhatsApp");
    const email = extractions
      .getByRole("listitem")
      .filter({ hasText: "mariana.lopes.demo@example.com" })
      .first();
    await expect(email.getByText("Aplicado à ficha", { exact: true })).toBeVisible();
    await email
      .getByRole("link", { name: /^Ver mensagem-fonte / })
      .first()
      .click();
    const source = page.getByRole("region", { name: "Mensagem-fonte", exact: true });
    await expect(source.locator("blockquote")).toContainText("mariana.lopes.demo@example.com");
    await expect(source.getByRole("link", { name: "Abrir conversa", exact: true })).toHaveAttribute(
      "href",
      new RegExp(`conversationId=${PROD_MARIANA.conversationId}`),
    );
    // Sem negócio criado artificialmente: o card pode mostrar ausência legítima de qualificação.
    await expect(
      page.getByRole("region", { name: "Qualificação por IA", exact: true }),
    ).toBeVisible();
  }
  await expectHealthyPage(page);
  await page.getByRole("tab", { name: "Memória IA", exact: true }).scrollIntoViewIfNeeded();
}

export async function verifyKanban(page) {
  await openPage(page, "/pipeline");
  for (const name of STAGE_NAMES) {
    await expect(
      page.locator(`[data-testid="pipeline-column"][data-stage-name="${name}"]`),
    ).toBeVisible();
  }
  const mariana = page
    .locator("[data-deal-id]")
    .filter({ hasText: "Avaliação odontológica | Mariana Lopes" });
  await expect(mariana).toHaveCount(1);
  await expect(mariana).toBeVisible();
  await expectHealthyPage(page);
  await mariana.scrollIntoViewIfNeeded();
}

export async function verifyDecisions(page, profile) {
  await openPage(page, "/decisions");
  await expect(page.getByRole("heading", { name: "Decisões", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Nenhuma decisão pendente", exact: true })
      .or(page.getByRole("button", { name: "Aprovar", exact: true }))
      .first(),
  ).toBeVisible();
  await expectHealthyPage(page);
  // A fila pode estar vazia; a evidência desta etapa é a política persistida, sem aprovar nada.
  await verifyKanban(page);
  await page.getByRole("button", { name: "Autonomia", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Autonomia do funil", exact: true });
  await expect(dialog).toBeVisible();
  const confidence = dialog.getByRole("spinbutton", {
    name: "Confiança da transição Em Atendimento → Qualificado",
    exact: true,
  });
  await expect(confidence).toHaveValue("80");
  await expect(
    dialog.getByRole("combobox", {
      name: "Modo da transição Em Atendimento → Qualificado",
      exact: true,
    }),
  ).toHaveText("Autônomo");
  const agent = dialog.getByRole("switch", {
    name: "Agente de pipeline neste workspace",
    exact: true,
  });
  await expect(agent).toBeEnabled();
  if (profile === "prod") {
    await expect(agent).toBeChecked();
  }
  await expectHealthyPage(page);
  await confidence.scrollIntoViewIfNeeded();
}

export async function verifyNurture(page) {
  await openPage(page, "/nurture");
  await expect(
    page.getByRole("heading", { name: "Acompanhamento automático", exact: true }),
  ).toBeVisible();
  for (const name of [
    "Confirmação de Avaliação Agendada",
    "Reativação de Proposta Parada",
    "Recall Periódico de Pacientes Finalizados",
  ]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expectHealthyPage(page);
}

export async function verifyDashboard(page, profile) {
  await openPage(page, "/app");
  await selectDatasetPeriod(page);
  await expect(page.getByRole("heading", { name: "Visão Geral", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saúde da Carteira", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Performance de Mensagens", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Carteira vazia", { exact: true })).toHaveCount(0);
  for (const label of ["Aguardando humano", "Auto-avanços"]) {
    await expect(page.getByText(label, { exact: true }).locator("+ div")).toHaveText(/^\d+$/);
  }
  await expect(page.getByText("Sugestões pendentes", { exact: true }).locator("+ div")).toHaveText(
    /^\d+$/,
  );
  await expect(
    page.getByText(/^\d+ aprovados \(\d+ sem edição · \d+ editados\) · \d+ rejeitados$/),
  ).toBeVisible();
  await expectHealthyPage(page);
  await page
    .getByRole("heading", { name: "Performance da IA (revisão humana)", exact: true })
    .scrollIntoViewIfNeeded();
}

export const JOURNEY = [
  {
    name: "onboarding",
    title: "[VISUAL] F1: Onboarding aplicado, sem reexecutar o wizard",
    verify: verifyOnboarding,
  },
  {
    name: "configuracao-ia",
    title: "[REAL] F2: Prompt base, prompts por estágio e modo de envio",
    verify: verifyAiSettings,
  },
  {
    name: "comportamento-ia",
    title: "[REAL] F3: Preferências de resposta e voz do perfil escolhido",
    verify: verifyBehavior,
  },
  {
    name: "whatsapp-chat",
    title: "[INTEGRAÇÃO SIMULADA] F4: Conversa demonstrativa da Mariana",
    verify: verifyInbox,
  },
  {
    name: "ficha-cliente",
    title: "[REAL] F5: Mariana, memória e qualificação persistidas",
    verify: verifyContact,
  },
  {
    name: "kanban-automatico",
    title: "[VISUAL] F6: Estágios e negócio da Mariana no Kanban",
    verify: verifyKanban,
  },
  {
    name: "autonomia-aprovacao",
    title: "[REAL] F7: Decisões e autonomia com confiança 0,80",
    verify: verifyDecisions,
  },
  {
    name: "followup-automatico",
    title: "[REAL] F8: Três sequências demonstrativas de acompanhamento",
    verify: verifyNurture,
  },
  {
    name: "dashboard",
    title: "[REAL] F9: Indicadores numéricos do dashboard",
    verify: verifyDashboard,
  },
];
