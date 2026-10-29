import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Bot, Check, Layers3, MessageCircleMore, Sparkles, Target } from "lucide-react";

import { BrandMark } from "@/components/marketing/BrandMark";
import { ProductSignalPreview } from "@/components/marketing/ProductSignalPreview";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CRM IA — Receita em movimento" },
      {
        name: "description",
        content:
          "Funil, conversas e inteligência artificial para equipes que querem transformar conversas em receita previsível.",
      },
      { property: "og:title", content: "CRM IA — Receita em movimento" },
      {
        property: "og:description",
        content:
          "O painel comercial para equipes que não querem perder o momento de avançar uma venda.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/" },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/" }],
  }),
  component: LandingPage,
});

const capabilities = [
  {
    icon: Layers3,
    title: "Funil que mostra o próximo passo",
    description: "Visualize onde a receita está travada e mova o negócio certo no momento certo.",
  },
  {
    icon: MessageCircleMore,
    title: "Conversas com contexto comercial",
    description:
      "Transforme cada atendimento em histórico útil, prioridade clara e ação registrada.",
  },
  {
    icon: Bot,
    title: "IA que ajuda a operar",
    description: "Sugestões e automações orientadas ao fluxo da equipe, não uma IA solta na tela.",
  },
];

function LandingPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[var(--neutral-950)] text-slate-100">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(30,99,200,0.18),transparent_42%)]"
      />
      <div className="relative mx-auto max-w-[1280px] px-4 pb-12 pt-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 backdrop-blur-sm sm:px-5">
          <span className="sm:hidden" aria-label="CRM IA">
            <BrandMark compact />
          </span>
          <span className="hidden sm:block">
            <BrandMark />
          </span>
          <nav aria-label="Navegação principal" className="flex items-center gap-2 sm:gap-3">
            <a
              href="#produto"
              className="hidden px-2 text-sm text-slate-300 transition-colors hover:text-white md:inline"
            >
              O produto
            </a>
            <a
              href="#fluxo"
              className="hidden px-2 text-sm text-slate-300 transition-colors hover:text-white md:inline"
            >
              Como funciona
            </a>
            <Link
              to="/auth"
              className="hidden px-2 text-sm font-medium text-slate-100 transition-colors hover:text-primary sm:inline sm:px-3"
            >
              Entrar
            </Link>
            <Button asChild size="lg" className="h-10 px-4 text-sm sm:px-5">
              <Link to="/auth" search={{ mode: "signup" } as never}>
                Começar agora <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </nav>
        </header>

        <section className="grid items-center gap-12 pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:pb-28 lg:pt-24">
          <div className="max-w-3xl">
            <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-caption font-semibold uppercase tracking-[0.12em] text-primary">
              <Sparkles className="h-3.5 w-3.5" /> CRM com IA para equipes em movimento
            </p>
            <h1 className="max-w-3xl [font-family:Lexend,sans-serif] text-h2 font-semibold leading-[1.06] tracking-[-0.055em] text-white sm:text-h1 lg:text-display">
              O painel comercial para transformar conversas em receita previsível.
            </h1>
            <p className="mt-6 max-w-2xl text-lead leading-8 text-slate-300">
              Capte sinais, organize o funil e dê ao time a próxima melhor ação — sem alternar entre
              planilhas, chats e achismos.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="h-12 px-6 text-base">
                <Link to="/auth" search={{ mode: "signup" } as never}>
                  Criar conta <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-12 border-white/15 bg-white/[0.035] px-6 text-base text-white hover:bg-white/10 hover:text-white"
              >
                <Link to="/auth">Acessar ambiente</Link>
              </Button>
            </div>
            <ul className="mt-9 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
              {["Funil visível", "Conversas unificadas", "IA em contexto"].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-primary/15 text-primary">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative lg:pl-4">
            <div aria-hidden className="absolute -inset-8 rounded-full bg-primary/12 blur-3xl" />
            <ProductSignalPreview className="relative" />
          </div>
        </section>

        <section id="produto" className="border-y border-white/10 py-16 sm:py-20">
          <div className="max-w-xl">
            <p className="text-caption font-semibold uppercase tracking-[0.16em] text-primary">
              Operação, não complicação
            </p>
            <h2 className="mt-3 [font-family:Lexend,sans-serif] text-h3 font-semibold tracking-[-0.045em] text-white sm:text-h2">
              Uma fonte de verdade para vender melhor todos os dias.
            </h2>
          </div>
          <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3">
            {capabilities.map(({ icon: Icon, title, description }) => (
              <article key={title} className="bg-[var(--neutral-950)] p-6 sm:p-7">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-8 text-lead font-semibold tracking-[-0.025em] text-white">
                  {title}
                </h3>
                <p className="mt-3 leading-6 text-slate-400">{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="fluxo"
          className="grid gap-10 py-16 sm:py-20 lg:grid-cols-[0.8fr_1.2fr] lg:items-start"
        >
          <div>
            <p className="text-caption font-semibold uppercase tracking-[0.16em] text-primary">
              Do sinal à ação
            </p>
            <h2 className="mt-3 [font-family:Lexend,sans-serif] text-h3 font-semibold tracking-[-0.045em] text-white sm:text-h2">
              Menos ruído. Mais avanço real.
            </h2>
          </div>
          <ol className="grid gap-3">
            {[
              [
                "01",
                "Centralize o que acontece",
                "Leads, conversas e oportunidades chegam ao mesmo fluxo.",
              ],
              [
                "02",
                "Encontre o que importa",
                "A visão geral destaca onde o time precisa agir primeiro.",
              ],
              [
                "03",
                "Execute com contexto",
                "Funil, Conversas e automações mantêm o próximo passo visível.",
              ],
            ].map(([number, title, description]) => (
              <li
                key={number}
                className="grid grid-cols-[auto_1fr] gap-4 rounded-xl border border-white/10 bg-white/[0.025] p-5 sm:p-6"
              >
                <span className="pt-0.5 font-mono text-caption font-semibold text-primary">
                  {number}
                </span>
                <div>
                  <h3 className="font-semibold text-white">{title}</h3>
                  <p className="mt-1.5 leading-6 text-slate-400">{description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-2xl border border-primary/25 bg-primary/10 px-6 py-10 text-center sm:px-12 sm:py-14">
          <Target className="mx-auto h-6 w-6 text-primary" />
          <h2 className="mx-auto mt-4 max-w-2xl [font-family:Lexend,sans-serif] text-h3 font-semibold tracking-[-0.045em] text-white">
            Sua operação comercial merece uma visão clara do que move a receita.
          </h2>
          <Button asChild size="lg" className="mt-7 h-12 px-6 text-base">
            <Link to="/auth" search={{ mode: "signup" } as never}>
              Começar agora <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </section>
      </div>
    </main>
  );
}
