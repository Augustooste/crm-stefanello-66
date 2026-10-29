import { expect, test } from "@playwright/test";
import { requireEnv, signIn } from "./helpers/auth";

test.describe("Pipeline autônomo", () => {
  test("movimento manual usa a política, aparece na auditoria e pode ser desfeito", async ({
    page,
  }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");

    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await page.goto("/pipeline");
    await expect(page.getByRole("heading", { name: "Funil" })).toBeVisible();

    const columns = page.getByTestId("pipeline-column");
    await expect.poll(() => columns.count()).toBeGreaterThanOrEqual(2);

    let sourceColumn = columns.first();
    for (let index = 0; index < (await columns.count()); index += 1) {
      const candidate = columns.nth(index);
      if ((await candidate.locator("[data-deal-id]").count()) > 0) {
        sourceColumn = candidate;
        break;
      }
    }
    const card = sourceColumn.locator("[data-deal-id]").first();
    await expect(card).toBeVisible();

    const dealId = await card.getAttribute("data-deal-id");
    const originalStageName = await sourceColumn.getAttribute("data-stage-name");
    expect(dealId).toBeTruthy();
    expect(originalStageName).toBeTruthy();

    await card.getByRole("button", { name: "Ações do negócio" }).click();
    await page.getByText("Mover para…", { exact: true }).hover();

    const destinations = page
      .getByRole("menuitem")
      .filter({ hasNotText: /Ganhar|Perder|Falar com IA|Mover para/i });
    await expect.poll(() => destinations.count()).toBeGreaterThan(0);

    let destination = destinations.first();
    for (let index = 0; index < (await destinations.count()); index += 1) {
      const candidate = destinations.nth(index);
      const label = (await candidate.textContent())?.trim() ?? "";
      if (label && label !== originalStageName && !/perdid/i.test(label)) {
        destination = candidate;
        break;
      }
    }
    const destinationName = (await destination.textContent())?.trim() ?? "";
    await destination.click();

    const lostDialog = page.getByRole("dialog", { name: "Marcar como perdido" });
    if (await lostDialog.isVisible().catch(() => false)) {
      await lostDialog.getByLabel("Motivo *").fill("Teste E2E de transição auditada");
      await lostDialog.getByRole("button", { name: "Marcar perdido" }).click();
    }

    const movedCard = page.locator(`[data-deal-id="${dealId}"]`);
    await expect(movedCard).toBeVisible();
    await expect(
      movedCard.locator("xpath=ancestor::*[@data-testid='pipeline-column'][1]"),
    ).toHaveAttribute("data-stage-name", destinationName);

    await movedCard.getByRole("button", { name: "Detalhes da IA" }).click();
    const auditDialog = page.getByRole("dialog", { name: "Decisão da IA no funil" });
    // "Kanban" aqui não é rótulo de tela: é o `reason` gravado na auditoria
    // (`_app.pipeline.tsx`), renderizado cru pelo diálogo. Traduzir a string
    // dessincronizaria as linhas históricas já persistidas.
    await expect(auditDialog).toContainText("Movimento manual no Kanban");
    await auditDialog.getByRole("button", { name: "Desfazer movimento" }).click();

    await expect(
      page
        .locator(`[data-deal-id="${dealId}"]`)
        .locator("xpath=ancestor::*[@data-testid='pipeline-column'][1]"),
    ).toHaveAttribute("data-stage-name", originalStageName!);
  });

  test("admin abre políticas e métricas de autonomia", async ({ page }) => {
    const env = requireEnv("E2E_USER_EMAIL", "E2E_USER_PASSWORD");
    test.skip(!env, "E2E_USER_EMAIL/PASSWORD não configurados");

    await signIn(page, env!.E2E_USER_EMAIL, env!.E2E_USER_PASSWORD);
    await page.goto("/pipeline");
    const button = page.getByRole("button", { name: "Autonomia" });
    await expect(button).toBeEnabled();
    await button.click();

    const dialog = page.getByRole("dialog", { name: "Autonomia do funil" });
    await expect(dialog).toContainText("Cada transição começa manual");
    await expect(dialog.getByLabel(/Modo da transição/).first()).toBeVisible();
    await expect(dialog.getByText("Sugestões")).toBeVisible();
  });
});
