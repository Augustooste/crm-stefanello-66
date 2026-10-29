import { describe, expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route } from "./_app.agentes";
import { AGENTES_IA_HABILITADO } from "@/lib/feature-flags";

// Esconder o item do sidebar não fecha a área: /agentes e /agentes/<id> seguem
// acessíveis por URL digitada, link salvo e refresh. E no SSR uma rota que ficou
// órfã renderiza tela branca em vez de 404 — foi exatamente o que aconteceu com
// /empresas. Por isso o guard vive no `beforeLoad` do layout, e por isso ele
// precisa de teste próprio: é a única coisa entre o deep-link e a área desligada.
describe("guard da área de Agentes", () => {
  // Este par de testes é o contrato. O primeiro fixa o estado da flag hoje; o
  // segundo prova que o guard reage a esse estado. Se alguém ligar a flag sem
  // mexer aqui, o primeiro fica vermelho e obriga a revisitar o segundo — que é
  // o sinal correto, porque com a flag ligada o guard deixa de redirecionar.
  it("a flag está desligada", () => {
    expect(AGENTES_IA_HABILITADO).toBe(false);
  });

  it("com a flag desligada, beforeLoad redireciona para /configuracoes", () => {
    const beforeLoad = Route.options.beforeLoad as () => void;

    let lancado: unknown;
    try {
      beforeLoad();
    } catch (e) {
      lancado = e;
    }

    // O TanStack Router sinaliza redirect LANÇANDO — se `beforeLoad` apenas
    // retornasse, a navegação seguiria para a área desligada em silêncio.
    expect(lancado, "beforeLoad deveria lançar o redirect").toBeDefined();
    expect(isRedirect(lancado), "o que foi lançado deveria ser um redirect").toBe(true);

    // O destino é conferido pelo objeto serializado, não por uma propriedade
    // fixa: a forma interna do redirect já mudou entre versões do router, e o
    // que importa aqui é que o destino seja /configuracoes. Cravar o destino é
    // o que separa este teste de um `toBeDefined()` decorativo — sem ele,
    // qualquer exceção lançada por engano dentro do guard passaria por verde.
    const alvo = lancado as { to?: string; options?: { to?: string } };
    expect(alvo.to ?? alvo.options?.to).toBe("/configuracoes");
  });
});
