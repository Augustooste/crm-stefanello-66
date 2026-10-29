import { test, expect, type Page } from "@playwright/test";
import { signIn, requireEnv, dismissConsent } from "./helpers/auth";

/**
 * Smoke autenticado: visita TODAS as rotas do app logado e falha se alguma
 * cair no error boundary ("Não foi possível carregar essa seção").
 *
 * Nasceu do incidente de 2026-07-31: /app quebrava logo após o login por um
 * 42501 em get_my_capabilities, e nenhum teste percorria as telas com sessão
 * real — o bug só aparecia para o usuário.
 */
const ROTAS = [
  "/app",
  "/inbox",
  "/pipeline",
  "/contatos",
  "/empresas",
  "/produtos",
  "/atividades",
  "/agenda",
  "/agendamentos",
  "/relatorios",
  "/decisions",
  "/templates",
  "/formularios",
  "/digest-semanal",
  "/assistente",
  "/integracoes",
  "/configuracoes",
  "/perfil",
  "/ajuda",
];

const BOUNDARY = "Não foi possível carregar essa seção";

async function visitar(page: Page, rota: string) {
  const erros: string[] = [];
  const onConsole = (msg: { type: () => string; text: () => string }) => {
    if (msg.type() === "error") erros.push(msg.text());
  };
  page.on("console", onConsole);

  await page.goto(rota, { waitUntil: "domcontentloaded" });
  await dismissConsent(page);
  // Dá tempo das queries da rota resolverem antes de julgar a tela.
  await page.waitForLoadState("networkidle").catch(() => {});

  const boundary = page.getByText(BOUNDARY);
  const quebrou = await boundary.isVisible().catch(() => false);
  let referencia: string | null = null;
  if (quebrou) {
    referencia = await page
      .getByTestId("error-reference")
      .innerText()
      .catch(() => null);
  }

  page.off("console", onConsole);
  return { quebrou, referencia, erros };
}

test.describe("Smoke autenticado de rotas", () => {
  test("nenhuma rota do app cai no error boundary", async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");
    test.setTimeout(ROTAS.length * 20_000);

    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);

    const quebradas: string[] = [];
    for (const rota of ROTAS) {
      const { quebrou, referencia } = await visitar(page, rota);
      if (quebrou) quebradas.push(`${rota}${referencia ? ` (${referencia.trim()})` : ""}`);
    }

    expect(quebradas, `Rotas em erro: ${quebradas.join(", ")}`).toEqual([]);
  });

  test("login frio não quebra /app (regressão do 42501 em capabilities)", async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");

    // Contexto novo = storage vazio: a sessão hidrata durante a montagem do
    // layout, que é exatamente a janela onde a RPC saía como `anon`.
    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await expect(page.getByText(BOUNDARY)).toBeHidden();
    await page.reload();
    await dismissConsent(page);
    await expect(page.getByText(BOUNDARY)).toBeHidden();
  });
});
