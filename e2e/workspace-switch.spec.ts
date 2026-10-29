import { test, expect } from "@playwright/test";
import { signIn, requireEnv } from "./helpers/auth";

/**
 * Este suite valida o WorkspaceSwitcher no topbar quando o usuário pertence a
 * MAIS DE UM tenant. Também verifica indiretamente o isolamento por tenant no
 * cliente: ao trocar de workspace, listas visíveis (contatos/pipeline) mudam.
 *
 * A validação profunda de RLS cross-tenant vive em
 * `supabase/tests/database/e2e_workspace_rls_isolation.sql` (pgTAP), porque só
 * o servidor pode afirmar que uma linha de outro tenant é *inacessível* — o
 * cliente pode no máximo observar que ela não aparece.
 */
test.describe("Alternância de workspaces", () => {
  test("usuário multi-workspace troca de tenant e a UI reflete", async ({ page }) => {
    const env = requireEnv("E2E_USER2_EMAIL", "E2E_USER2_PASSWORD");
    test.skip(!env, "E2E_USER2_EMAIL/PASSWORD não configurados");

    await signIn(page, env!.E2E_USER2_EMAIL, env!.E2E_USER2_PASSWORD);

    const switcher = page.getByRole("button", { name: /trocar empresa/i });
    // `isVisible()` NÃO re-tenta: devolve o estado do instante em que roda. O
    // seletor só renderiza depois de `useCurrentProfile()` + a lista de
    // workspaces resolverem, então local (máquina rápida) o teste passava e no
    // runner ele se auto-pulava — `expected: 5` contra piso 6, job vermelho com
    // zero teste reprovado. Auto-skip escondendo teste é exatamente a classe que
    // o `06 · H2` do code review atacou. `waitFor` espera de verdade; o skip só
    // sobra para o caso legítimo (conta com um workspace só).
    const temSwitcher = await switcher
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!temSwitcher) {
      test.skip(true, "Conta não é membro de múltiplos workspaces");
    }

    const workspaceInicial = (await switcher.textContent())?.trim() ?? "";
    expect(workspaceInicial.length).toBeGreaterThan(0);

    await switcher.click();
    const opcoes = page.getByRole("menuitem");
    const count = await opcoes.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Clica em um workspace diferente do ativo (o ativo tem ícone Check).
    let clicked = false;
    for (let i = 0; i < count; i += 1) {
      const opt = opcoes.nth(i);
      const txt = (await opt.textContent())?.trim() ?? "";
      if (txt && !txt.includes(workspaceInicial)) {
        await opt.click();
        clicked = true;
        break;
      }
    }
    expect(clicked).toBe(true);

    // switch_active_workspace faz refreshSession + window.location.assign("/app").
    await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

    const workspaceAtualEl = page.getByRole("button", { name: /trocar empresa/i });
    await expect(workspaceAtualEl).toBeVisible();
    // `waitForURL` não serve de barreira aqui: a sessão já estava em /app, então
    // `window.location.assign("/app")` navega para a MESMA URL e a espera resolve
    // na hora, antes do reload trocar o DOM. Uma leitura única de textContent
    // pegava o rótulo velho. `expect.poll` mantém a mesma comparação exata
    // (trim, sem normalização de espaço) e só troca leitura única por releitura
    // até o deadline — se a troca de workspace realmente não acontecer, continua
    // vermelho.
    await expect
      .poll(async () => (await workspaceAtualEl.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(workspaceInicial);
  });

  test("permissões seguem o workspace ativo (atendente não vê Configurações)", async ({ page }) => {
    const env = requireEnv("E2E_USER2_EMAIL", "E2E_USER2_PASSWORD");
    test.skip(!env, "E2E_USER2_EMAIL/PASSWORD não configurados");

    await signIn(page, env!.E2E_USER2_EMAIL, env!.E2E_USER2_PASSWORD);

    // O papel do usuário no workspace ativo não é conhecido de antemão (depende
    // de qual tenant a conta E2E_USER2 tem como ativo no momento), então ele é
    // LIDO de um observável antes de assertar: o item "Configurações" do menu é
    // `admin: true` em AppSidebar.tsx. Ler o papel primeiro e assertar depois é
    // o que permite uma expectativa ÚNICA em cada ramo — a versão anterior
    // aceitava `/(app|configuracoes)`, que casa com os dois desfechos possíveis
    // e portanto não podia falhar por nada.
    // Âncora antes de ler: `isVisible()` NÃO re-tenta. Os itens `admin: false`
    // do AppSidebar renderizam de imediato, os `admin: true` só depois que
    // `useCurrentProfile()` resolve — ler "Configurações" cedo devolveria
    // `false` para um admin e o teste falharia no ramo errado. Esperar por
    // "Visão geral" (admin: false) não bastaria; esperar pela conclusão da rede
    // e ancorar num item sempre presente é o que garante que o sidebar já
    // terminou de montar com o papel resolvido.
    await expect(page.getByRole("link", { name: "Visão geral", exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const itemConfig = page.getByRole("link", { name: "Configurações", exact: true });
    const ehAdmin = await itemConfig.isVisible();

    await page.goto("/configuracoes");
    await page.waitForLoadState("networkidle");

    // ATENÇÃO: `/configuracoes` NÃO tem `beforeLoad: requireAdmin` (diferente de
    // /templates, /conectar, /formularios e /relatorios, que têm). Não existe
    // redirect para /app — o comentário anterior aqui descrevia um guard que
    // nunca existiu. A restrição real é por ABA: `ALWAYS_VISIBLE_TABS` libera
    // "Aparência" e "Notificações" para qualquer usuário do tenant, e as demais
    // ficam atrás de `isAdmin`. É isso que este teste crava.
    await expect(page).toHaveURL(/\/configuracoes/);
    await expect(page.getByRole("tab", { name: "Aparência" })).toBeVisible();

    const abaAdmin = page.getByRole("tab", { name: "Equipe" });
    if (ehAdmin) {
      await expect(abaAdmin, "workspace admin: a aba Equipe tem que aparecer").toBeVisible();
    } else {
      await expect(abaAdmin, "workspace de atendente: a aba Equipe NÃO pode aparecer").toHaveCount(
        0,
      );
    }
  });
});
