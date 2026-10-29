import { test } from "@playwright/test";
import {
  DEFAULT_BASE_URL,
  JOURNEY,
  VIEWPORT,
  assertionProfile,
  signInClinica,
} from "./jornada-helpers.mjs";

const profile = assertionProfile();

// O login ocorre neste spec: nenhum trace, vídeo ou screenshot automático é permitido.
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
  test.skip(!hasCredentials, "Carregue as credenciais da Clínica FT para executar a jornada.");
  await signInClinica(page);
});

test.describe(`Jornada Clínica FT: perfil ${profile}`, () => {
  for (const step of JOURNEY) {
    test(step.title, async ({ page }) => {
      await step.verify(page, profile);
    });
  }
});
