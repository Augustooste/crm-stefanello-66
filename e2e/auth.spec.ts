import { test, expect } from "@playwright/test";
import { signIn, signOut, expectAuthenticated, requireEnv } from "./helpers/auth";

test.describe("Autenticação", () => {
  test("rota protegida redireciona anônimo para /auth", async ({ page }) => {
    await page.goto("/app");
    await page.waitForURL(/\/auth(\?|$)/);
    await expect(page.getByLabel("E-mail")).toBeVisible();
  });

  test("credenciais inválidas mostram mensagem em PT-BR", async ({ page }) => {
    await page.goto("/auth");
    await page.getByLabel("E-mail").fill("naoexiste@aceleraflow.test");
    await page.getByLabel("Senha").fill("senhaerrada123");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(
      page.getByText(/E-mail ou senha incorretos|Não foi possível autenticar/i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/auth/);
  });

  test("login válido leva ao /app e logout retorna para /auth", async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");
    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await expectAuthenticated(page);

    await signOut(page);
    // Após logout, rota protegida deve reencaminhar de volta.
    await page.goto("/app");
    await page.waitForURL(/\/auth(\?|$)/);
  });

  test("sessão persiste após reload", async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");
    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await page.reload();
    await expectAuthenticated(page);
  });
});
