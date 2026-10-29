import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { assertPublicSupabaseEnv } from "@/lib/env";
import { cn } from "@/lib/utils";
import { MarkdownLite, parseMarkdown, tocFromBlocks, type MdBlock } from "@/lib/markdown-lite";
import readme from "@/content/webhooks/README.md?raw";

const TITLE = "Documentação de webhooks";
const DESCRIPTION =
  "Como usar webhooks de saída, regras de entrada (Stripe, Asaas, Hotmart, n8n e Make) e a API pública do CRM.";
// Sem canonical/og:url: a página é autenticada e o app é template de remix (domínio varia).
export const Route = createFileRoute("/_app/documentacao/webhooks")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
  }),
  component: WebhooksDocsPage,
});

/** O h1 é o do PageHeader e o índice é a navegação lateral: os dois saem do corpo. */
function pageBlocks(all: MdBlock[]): MdBlock[] {
  const out: MdBlock[] = [];
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (b.type === "heading" && b.level === 1) continue;
    if (b.type === "heading" && b.text === "Índice") {
      if (all[i + 1]?.type === "list") i++;
      continue;
    }
    out.push(b);
  }
  return out;
}

const BLOCKS = pageBlocks(parseMarkdown(readme));
const TOC = tocFromBlocks(BLOCKS);
const TOC_IDS = TOC.map((item) => item.id);

/** URL da spec na API pública do projeto; null se o ambiente não tiver a URL do backend. */
function openApiUrl(): string | null {
  try {
    const { url } = assertPublicSupabaseEnv();
    return `${url.replace(/\/+$/, "")}/functions/v1/public-api/v1/openapi.json`;
  } catch {
    return null;
  }
}

/**
 * Linha de ativação, em px do topo da janela: header (h-14 = 56) + folga. A folga cobre o
 * scroll-mt-20 (80) dos títulos e mais 8: o h2 levado pelo índice para em 56 + 80 = 136 e
 * precisa contar como ativo, senão o clique marcaria a seção anterior.
 */
const ACTIVE_TOP_PX = 56 + 80 + 8;

/** Margem (px) para considerar a rolagem "no fim". */
const END_SLACK_PX = 2;

/** Rolado até o fim de um contêiner com rolagem vertical real (ignora blocos que só rolam na horizontal). */
function isScrolledToEnd(el: Element | null): boolean {
  return (
    !!el &&
    el.scrollHeight > el.clientHeight &&
    el.scrollTop + el.clientHeight >= el.scrollHeight - END_SLACK_PX
  );
}

/**
 * Último h2 do índice (ordem do documento) cujo topo já passou da linha de ativação; no fim da
 * página, o último h2. Nenhum passou (topo da página): o primeiro, para o índice nunca ficar sem item ativo.
 */
function lastPassedSection(ids: string[], scroller: Element | null): string | null {
  if (isScrolledToEnd(scroller)) return ids[ids.length - 1] ?? null;
  let current: string | null = ids[0] ?? null;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top <= ACTIVE_TOP_PX) current = id;
  }
  return current;
}

/** Recalcula no scroll (no máximo 1 vez por frame). Captura: quem rola é o contêiner do app, não a janela. */
function useActiveSection(ids: string[]): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    let scroller: Element | null = document.scrollingElement;
    const update = () => {
      frame = 0;
      setActive(lastPassedSection(ids, scroller));
    };
    const onScroll = (e: Event) => {
      const target = e.target instanceof Element ? e.target : document.scrollingElement;
      if (target && target.scrollHeight > target.clientHeight) scroller = target;
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      cancelAnimationFrame(frame);
    };
  }, [ids]);
  return [active, setActive];
}

function TocList({
  activeId,
  onNavigate,
}: {
  activeId: string | null;
  onNavigate: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {TOC.map((item) => {
        const isActive = item.id === activeId;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={isActive ? "location" : undefined}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "block rounded px-2 py-1 text-body hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "bg-muted font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {item.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function WebhooksDocsPage() {
  const specUrl = openApiUrl();
  const [activeId, setActiveId] = useActiveSection(TOC_IDS);
  const tocDetails = useRef<HTMLDetailsElement>(null);

  // Entrada direta com #âncora: o conteúdo só existe depois do render, então rola aqui.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    try {
      document.getElementById(decodeURIComponent(id))?.scrollIntoView();
    } catch {
      // Hash malformado (#%E0): decodeURIComponent lança URIError; ignora em vez de quebrar a rota.
    }
  }, []);

  return (
    <div className="col-span-12 flex min-w-0 flex-col gap-6">
      <PageHeader
        title={TITLE}
        description="Webhooks de saída, regras de entrada e API pública, passo a passo."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/configuracoes" hash="desenvolvedores">
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Voltar para configurações
              </Link>
            </Button>
            {specUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={specUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                  Especificação OpenAPI
                  <span className="sr-only"> (abre em nova aba)</span>
                </a>
              </Button>
            )}
          </>
        }
      />

      <details
        ref={tocDetails}
        className="rounded-md border border-border bg-surface p-3 lg:hidden"
      >
        <summary className="cursor-pointer text-body font-semibold text-foreground">
          Nesta página
        </summary>
        <nav aria-label="Nesta página" className="mt-2">
          <TocList
            activeId={activeId}
            onNavigate={(id) => {
              setActiveId(id);
              // No celular o índice é um <details>: fecha ao escolher uma seção.
              if (tocDetails.current) tocDetails.current.open = false;
            }}
          />
        </nav>
      </details>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <article aria-label={TITLE} className="min-w-0 max-w-3xl">
          <MarkdownLite blocks={BLOCKS} />
        </article>
        <aside className="hidden lg:block">
          <nav
            aria-label="Nesta página"
            className="sticky top-0 flex max-h-[calc(100svh-8rem)] flex-col gap-2 overflow-y-auto"
          >
            <p className="px-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              Nesta página
            </p>
            <TocList activeId={activeId} onNavigate={setActiveId} />
          </nav>
        </aside>
      </div>
    </div>
  );
}
