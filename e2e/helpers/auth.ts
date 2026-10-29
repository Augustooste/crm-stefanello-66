import { expect, type Page } from "@playwright/test";

/**
 * Preenche o formulário de login e aguarda o redirecionamento para /app.
 * Reutilizado por múltiplos specs — não persiste storageState em disco de
 * propósito (cada spec começa limpo para evitar contaminação cruzada).
 */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await dismissConsent(page);
}

/**
 * Dispensa o "Aviso de privacidade" (LGPD). Em navegador novo o localStorage está
 * vazio, então o modal abre — como um usuário real que aceita uma vez. O modal
 * (Radix Dialog) aria-esconde o resto do app, deixando o avatar invisível para
 * getByRole; o aceite fica no localStorage e sobrevive ao reload.
 *
 * Só engole o TIMEOUT do waitFor (modal ausente = consentimento já registrado).
 * Uma falha do clique (botão renomeado, coberto, strict-mode) propaga em vez de
 * sumir — senão mascararia um bug real de UI a segundos de distância da causa.
 */
export async function dismissConsent(page: Page) {
  const button = page.getByRole("button", { name: "Entendi", exact: true });
  try {
    await button.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return; // modal não apareceu no prazo — consentimento já registrado, segue
  }
  await button.click();
}

export async function signOut(page: Page) {
  // Menu do avatar → "Sair"
  await page.getByRole("button", { name: /menu de|abrir menu do usuário/i }).click();
  await page.getByRole("menuitem", { name: /sair/i }).click();
  await page.waitForURL(/\/auth(\?|$)/, { timeout: 10_000 });
}

export function requireEnv(...keys: string[]): Record<string, string> | null {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) return null;
  return Object.fromEntries(keys.map((k) => [k, process.env[k]!]));
}

export async function expectAuthenticated(page: Page) {
  await expect(page).toHaveURL(/\/app(\/|$)/);
  // Topbar renderiza o avatar quando autenticado.
  await expect(page.getByRole("button", { name: /menu de|abrir menu do usuário/i })).toBeVisible();
}
