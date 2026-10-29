import { test, expect } from "@playwright/test";
import { signIn, requireEnv } from "./helpers/auth";

/**
 * Este suite exige uma conta *recém-criada* (tenant sem onboarding concluído)
 * porque `OnboardingGate` só abre o wizard quando `needs_onboarding` é true.
 * Se a conta reutilizada já concluiu o wizard, o teste é pulado.
 */
test.describe("Onboarding wizard", () => {
  test("um novo admin consegue avançar pelos passos iniciais", async ({ page }) => {
    const env = requireEnv("E2E_NEW_USER_EMAIL", "E2E_NEW_USER_PASSWORD");
    test.skip(!env, "E2E_NEW_USER_EMAIL/PASSWORD não configurados");

    await signIn(page, env!.E2E_NEW_USER_EMAIL, env!.E2E_NEW_USER_PASSWORD);

    // Wizard abre automaticamente via OnboardingGate.
    const wizard = page.getByRole("dialog");
    if ((await wizard.count()) === 0) test.skip(true, "Tenant já finalizou onboarding");
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    // Passo 1 — Empresa
    await expect(page.getByText(/Passo 1 de/i)).toBeVisible();
    const empresa = page.getByLabel(/nome da empresa|empresa/i).first();
    if (await empresa.isVisible().catch(() => false)) {
      await empresa.fill("Empresa E2E");
    }
    await page.getByRole("button", { name: /avançar/i }).click();

    // Passo 2 — Nicho: seleciona o primeiro card disponível.
    await expect(page.getByText(/Passo 2 de/i)).toBeVisible();
    const primeiroNicho = page.getByRole("button", { name: /aplicar|selecionar/i }).first();
    if (await primeiroNicho.isVisible().catch(() => false)) {
      await primeiroNicho.click();
    }
    await page.getByRole("button", { name: /avançar/i }).click();

    // A partir daqui os passos variam (canais, perfil, equipe, importar).
    // Validamos apenas que o botão de fechar está disponível — o objetivo é
    // provar que a UI não trava; a corretude semântica de cada step tem
    // cobertura unitária em src/components/onboarding.
    await expect(
      page.getByRole("button", { name: /pular|avançar|concluir/i }).first(),
    ).toBeVisible();
  });
});
