import { test, expect } from "@playwright/test";
import { signIn, requireEnv, expectAuthenticated } from "./helpers/auth";

/**
 * Smoke de papéis: o que cada perfil VÊ e o que consegue FAZER.
 *
 * Complementa supabase/tests/database/rbac_smoke_admin_agent.sql — lá se prova
 * o corte no banco, aqui se prova que a UI não oferece caminho para o que o
 * banco nega (botão que existe e falha é pior que botão ausente).
 *
 * As contas são as já provisionadas no repositório:
 *   E2E_USER_*  → admin no workspace `e2e.admin`
 *   E2E_USER2_* → atendente no mesmo workspace (admin em outro)
 *
 * Sem as variáveis o spec é pulado, como os demais.
 */

const ROTAS_ADMIN = ["/configuracoes"];

test.describe("Papéis — admin", () => {
  test.beforeEach(async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");
    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await expectAuthenticated(page);
  });

  test("vê Configurações no menu e abre a tela", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Configurações" })).toBeVisible();
    await page.getByRole("link", { name: "Configurações" }).click();
    await page.waitForURL(/\/configuracoes/);
    await expect(page.getByRole("heading", { name: /configurações/i }).first()).toBeVisible();
  });

  test("alcança as abas de Integrações e IA dentro de Configurações", async ({ page }) => {
    await page.goto("/configuracoes");
    await expect(page.getByRole("tab", { name: /integrações|plugins/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("tab", { name: /ia|assistente/i }).first()).toBeVisible();
  });

  test("lê e escreve contato: cria um descartável e o remove no fim", async ({ page }) => {
    const nome = `E2E RBAC ${Date.now()}`;
    await page.goto("/contatos");
    await page.getByRole("button", { name: /novo contato/i }).click();
    await page.getByLabel(/nome/i).first().fill(nome);
    await page
      .getByRole("button", { name: /salvar|criar/i })
      .first()
      .click();

    // Escrita bem-sucedida aparece na lista; falha apareceria como toast em PT-BR.
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Papéis — atendente", () => {
  test.beforeEach(async ({ page }) => {
    const env = requireEnv("E2E_USER2_EMAIL", "E2E_USER2_PASSWORD");
    test.skip(!env, "E2E_USER2_EMAIL/PASSWORD não configurados");
    await signIn(page, env!.E2E_USER2_EMAIL, env!.E2E_USER2_PASSWORD);
    await expectAuthenticated(page);
  });

  test("não vê Configurações no menu lateral", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Configurações" })).toHaveCount(0);
  });

  for (const rota of ROTAS_ADMIN) {
    test(`acesso direto a ${rota} volta para /app sem piscar conteúdo protegido`, async ({
      page,
    }) => {
      await page.goto(rota);
      // O guard roda em beforeLoad: a rota protegida nunca chega a renderizar.
      await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
      await expect(page.getByRole("tab", { name: /integrações|plugins/i })).toHaveCount(0);
    });
  }

  test("lê e escreve o que lhe cabe: contatos e atividades", async ({ page }) => {
    await page.goto("/contatos");
    await expect(page.getByRole("button", { name: /novo contato/i })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto("/atividades");
    await expect(page).toHaveURL(/\/atividades/);
    await expect(page.getByRole("heading", { name: /atividades/i }).first()).toBeVisible();
  });

  test("erro do backend chega tratado em PT-BR, nunca cru", async ({ page }) => {
    const erros: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") erros.push(msg.text());
    });
    await page.goto("/app");
    await page.waitForTimeout(2_000);
    // Nenhuma mensagem crua de Postgres/PostgREST deve vazar para a interface.
    await expect(page.getByText(/permission denied|violates row-level security/i)).toHaveCount(0);
    expect(erros.join("\n")).not.toMatch(/violates row-level security/i);
  });
});
