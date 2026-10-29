import { test, expect, type Page } from "@playwright/test";
import { signIn, requireEnv, expectAuthenticated } from "./helpers/auth";

/**
 * Smoke da tela de Integrações e Plugins (Configurações → aba "plugins").
 *
 * Existe por causa do restore das 164 migrations históricas: o catálogo, o
 * estado por tenant e a URL de webhook vêm todos do banco, e uma regressão de
 * schema/grant aparece aqui como card sumido ou lista vazia — não como erro de
 * build.
 *
 * READ-ONLY por construção: toda chamada de ESCRITA (a function
 * `integration-connect` e qualquer POST/PATCH/DELETE no PostgREST) é
 * interceptada e ABORTADA antes de sair, e o teste reprova se alguma tiver
 * sido tentada. O banco do projeto é o de produção — não existe staging —
 * então o spec navega e lê, nunca conecta nem desconecta nada de verdade.
 */

const ROTA_CONFIG = "/configuracoes";

/** Intercepta e bloqueia escrita. Devolve a lista do que foi tentado. */
async function bloquearEscritas(page: Page): Promise<string[]> {
  const tentativas: string[] = [];
  await page.route("**/functions/v1/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS" || req.method() === "GET") return route.continue();
    tentativas.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: "bloqueado pelo smoke read-only" }),
    });
  });
  await page.route("**/rest/v1/**", async (route) => {
    const req = route.request();
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return route.continue();
    tentativas.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  return tentativas;
}

async function abrirAbaPlugins(page: Page): Promise<void> {
  await page.goto(ROTA_CONFIG);
  const aba = page.getByRole("tab", { name: /integrações e plugins/i }).first();
  await expect(aba).toBeVisible({ timeout: 20_000 });
  await aba.click();
}

test.describe("Integrações e Plugins (somente leitura)", () => {
  let escritas: string[] = [];

  test.beforeEach(async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");
    escritas = await bloquearEscritas(page);
    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await expectAuthenticated(page);
  });

  test.afterEach(() => {
    expect(escritas, "o smoke não pode tentar escrever no banco").toEqual([]);
  });

  test("catálogo de integrações renderiza com cards e ação de conectar", async ({ page }) => {
    await abrirAbaPlugins(page);

    // O catálogo vem de `integrations` (tabela) filtrado pelos slugs ocultos.
    // Zero cards = grant/policy quebrada ou catálogo não semeado no remix.
    const acoes = page.getByRole("button", { name: /^(conectar|gerenciar)$/i });
    await expect(acoes.first()).toBeVisible({ timeout: 20_000 });
    expect(await acoes.count()).toBeGreaterThan(0);

    // Provedores com assistente passo a passo — os que o produto oferece hoje.
    await expect(page.getByText(/whatsapp/i).first()).toBeVisible();

    // Nenhum estado de erro cru na tela.
    await expect(page.getByText(/permission denied|row-level security|PGRST/i)).toHaveCount(0);
  });

  test("plugins de nicho aparecem como switches, sem alternar nada", async ({ page }) => {
    await abrirAbaPlugins(page);
    const switches = page.getByRole("switch");
    await expect(switches.first()).toBeVisible({ timeout: 20_000 });
    // Só conta: alternar gravaria em business_profile.plugin_overrides.
    expect(await switches.count()).toBeGreaterThan(0);
  });

  test("modal de conexão abre com os campos de segredo e fecha sem salvar", async ({ page }) => {
    await abrirAbaPlugins(page);
    const conectar = page.getByRole("button", { name: /^conectar$/i }).first();
    await expect(conectar).toBeVisible({ timeout: 20_000 });
    await conectar.click();

    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible({ timeout: 10_000 });
    // O formulário é gerado de `required_secrets` do catálogo: sem campo
    // nenhum, o catálogo veio sem a coluna (regressão de schema).
    const campos = dialogo.locator("input:not([type=hidden])");
    expect(await campos.count()).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(dialogo).toBeHidden({ timeout: 10_000 });
  });

  test("integração conectada mostra a URL de webhook com botão copiar", async ({ page }) => {
    await abrirAbaPlugins(page);
    const gerenciar = page.getByRole("button", { name: /^gerenciar$/i }).first();
    const temConectada = await gerenciar.isVisible().catch(() => false);
    test.skip(!temConectada, "nenhuma integração conectada neste tenant");

    await gerenciar.click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible({ timeout: 10_000 });
    await expect(dialogo.getByRole("button", { name: /copiar url do webhook/i })).toBeVisible();
    // O token do webhook faz parte da URL — ela precisa apontar para a function
    // certa, senão o provedor entrega inbound em lugar nenhum.
    await expect(dialogo.getByText(/messaging-webhook/)).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("card ManyChat abre o assistente pedindo só a API Key", async ({ page }) => {
    await abrirAbaPlugins(page);
    // Espera o catálogo renderizar antes de decidir se o card existe.
    const acoes = page.getByRole("button", { name: /^(conectar|gerenciar)$/i });
    await expect(acoes.first()).toBeVisible({ timeout: 20_000 });
    const card = page.locator('[data-integration-card="manychat-whatsapp"]');
    test.skip(
      (await card.count()) === 0,
      "migration 20260929120000 (catálogo ManyChat) não aplicada neste banco",
    );

    await card.getByRole("button", { name: /^(conectar|gerenciar)$/i }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible({ timeout: 10_000 });

    if ((await dialogo.getByTestId("manychat-setup").count()) > 0) {
      // Já conectado: URL, JSON copiável e segredo NUNCA reexibido.
      await expect(dialogo.getByText(/messaging-webhook\/manychat-whatsapp\//)).toBeVisible();
      await expect(dialogo.getByRole("button", { name: /copiar json/i })).toBeVisible();
      await expect(dialogo.getByTestId("manychat-secret")).toHaveCount(0);
    } else {
      await expect(dialogo.getByLabel(/API Key do ManyChat/i)).toBeVisible();
    }
    await page.keyboard.press("Escape");
  });
});
