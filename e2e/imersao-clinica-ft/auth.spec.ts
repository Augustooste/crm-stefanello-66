import { test, expect } from "@playwright/test";
import {
  DEFAULT_BASE_URL,
  VIEWPORT,
  expectHealthyPage,
  expectWorkspace,
  openAiSettings,
  signInClinica,
} from "./jornada-helpers.mjs";

// Nem falhas de login podem produzir artefatos contendo senha ou sessão.
test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  baseURL: process.env.IMERSAO_BASE_URL ?? DEFAULT_BASE_URL,
  viewport: VIEWPORT,
});

test.beforeEach(async ({ page }) => {
  const hasCredentials = !!process.env.CLINICA_FT_EMAIL && !!process.env.CLINICA_FT_PASSWORD;
  if (process.env.IMERSAO_E2E === "1" && !hasCredentials) {
    throw new Error("IMERSAO_E2E=1 exige CLINICA_FT_EMAIL e CLINICA_FT_PASSWORD.");
  }
  test.skip(!hasCredentials, "Carregue as credenciais da Clínica FT para executar o login real.");
  await signInClinica(page);
});

test.describe("Autenticação da Clínica FT", () => {
  test("[REAL] Login pela UI abre o dashboard do workspace correto", async ({ page }) => {
    await expect(page).toHaveURL(/\/app(?:[/?#]|$)/);
    await expectWorkspace(page);
    await expect(
      page.getByRole("button", { name: /menu de|abrir menu do usuário/i }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Visão Geral", exact: true })).toBeVisible();
    await expectHealthyPage(page);
  });

  test("[REAL] Administrador acessa configuração da IA sem alterar valores", async ({ page }) => {
    await openAiSettings(page);
    await expect(page).toHaveURL(/\/configuracoes(?:[?#]|$)/);
    await expect(page.getByLabel("Prompt base do assistente", { exact: true })).toHaveValue(
      /assistente da equipe da \{\{empresa\}\}, clínica odontológica/i,
    );
    await expect(page.getByRole("tab", { name: "Equipe", exact: true })).toBeVisible();
    await expectHealthyPage(page);
  });
});
