import { Link } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Âncoras de src/content/webhooks/README.md (readme-consistency.test.ts confere que existem). */
export type WebhooksDocsAnchor = "comece" | "saida" | "assinatura" | "entrada";

const DOCS_PATH = "/documentacao/webhooks";

/** Botão "Ajuda" que abre a documentação de webhooks na seção certa. */
export function WebhooksHelpLink({ hash, topic }: { hash: WebhooksDocsAnchor; topic: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="sm">
            <Link to={DOCS_PATH} hash={hash} aria-label={`Ajuda: ${topic}`}>
              <CircleHelp className="mr-2 h-4 w-4" aria-hidden="true" />
              Ajuda
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Abre a documentação: {topic}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Link discreto para a documentação (lista vazia, topo da aba, rodapé de seção). */
export function WebhooksDocsInlineLink({
  hash,
  children,
}: {
  hash: WebhooksDocsAnchor;
  children: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={DOCS_PATH}
            hash={hash}
            className="rounded text-body font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {children}
          </Link>
        </TooltipTrigger>
        <TooltipContent>Abre a documentação de webhooks e API</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
