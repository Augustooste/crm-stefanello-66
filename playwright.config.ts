import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Carrega .env.e2e (credenciais/URLs de teste, não versionado) antes de ler process.env.
loadEnv({ path: ".env.e2e" });

// Fora do CI, ausência das vars primárias = provável .env.e2e esquecido. Sem elas
// os specs autenticados são PULADOS (requireEnv → test.skip) e a suíte "passa"
// testando quase nada. No CI as vars vêm de secrets (sem arquivo) — só avisa.
if (!process.env.CI && (!process.env.E2E_USER_EMAIL || !process.env.E2E_USER_PASSWORD)) {
  console.warn(
    "\n[e2e] E2E_USER_EMAIL/E2E_USER_PASSWORD ausentes — crie .env.e2e (veja .env.e2e.example).\n" +
      "Sem elas os specs autenticados serão PULADOS e a suíte passa sem testar nada.\n",
  );
}

/**
 * Configuração Playwright para testes E2E do AceleraFlow.
 *
 * Variáveis de ambiente esperadas (definidas em .env.e2e ou no CI):
 *   E2E_BASE_URL              URL da app (default http://localhost:8080)
 *   E2E_USER_EMAIL            e-mail do usuário principal (workspace A, admin)
 *   E2E_USER_PASSWORD         senha do usuário principal
 *   E2E_USER2_EMAIL           e-mail do usuário multi-workspace (opcional)
 *   E2E_USER2_PASSWORD        senha do usuário multi-workspace (opcional)
 *   E2E_NEW_USER_EMAIL        e-mail descartável para fluxo de signup+onboarding
 *   E2E_NEW_USER_PASSWORD     senha do novo usuário
 *
 * NB: os testes assumem contas já provisionadas no ambiente de teste. Para o
 * suite de RLS entre workspaces, use o teste pgTAP correspondente em
 * `supabase/tests/database/e2e_workspace_rls_isolation.sql`.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // specs compartilham contas de teste; serializa p/ evitar contaminação
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "pt-BR",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: process.env.E2E_START_SERVER
    ? {
        command: "pnpm dev",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
