import { CopySnippet } from "@/components/common/CopySnippet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiKeysSection } from "./ApiKeysSection";
import { InboundRulesSection } from "./InboundRulesSection";
import { NODE_VERIFY_SNIPPET, PYTHON_VERIFY_SNIPPET } from "./verify-snippets";
import { WebhookEndpointsSection } from "./WebhookEndpointsSection";
import { WebhooksDocsInlineLink, WebhooksHelpLink } from "./WebhooksHelpLink";

const OPENAPI_PATH = "/v1/openapi.json";

export function DeveloperTab() {
  return (
    <div className="flex flex-col gap-8">
      <p className="text-body text-muted-foreground">
        Primeira vez por aqui?{" "}
        <WebhooksDocsInlineLink hash="comece">
          Veja a documentação de webhooks e API
        </WebhooksDocsInlineLink>
        .
      </p>
      <ApiKeysSection />
      <WebhookEndpointsSection />
      <InboundRulesSection />
      <VerifySignatureHelp />
    </div>
  );
}

function VerifySignatureHelp() {
  return (
    <section aria-labelledby="verify-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="verify-title" className="text-section-title font-semibold text-foreground">
          Como verificar a assinatura
        </h2>
        <WebhooksHelpLink hash="assinatura" topic="verificar a assinatura" />
      </div>
      <div className="flex flex-col gap-1 text-body text-muted-foreground">
        <p>
          Cada requisição traz o cabeçalho{" "}
          <code className="font-mono">X-Aceleraflow-Signature</code> no formato{" "}
          <code className="font-mono">t=&lt;unix&gt;,v1=&lt;hex&gt;</code>. Calcule o HMAC-SHA256 de{" "}
          <code className="font-mono">&lt;t&gt;.&lt;corpo&gt;</code> com o segredo do webhook e
          compare com cada <code className="font-mono">v1</code>.
        </p>
        <p>
          Use o corpo cru, exatamente como chegou, sem converter para JSON e serializar de novo.
          Rejeite requisições com <code className="font-mono">t</code> a mais de 5 minutos do
          horário atual (tolerância de 300 segundos).
        </p>
        <p>
          A referência completa da API está em <code className="font-mono">{OPENAPI_PATH}</code>,
          relativo à URL base da API pública (rota aberta, sem chave).
        </p>
      </div>
      <Tabs defaultValue="node">
        <TabsList>
          <TabsTrigger value="node">Node</TabsTrigger>
          <TabsTrigger value="python">Python</TabsTrigger>
        </TabsList>
        <TabsContent value="node">
          <CopySnippet label="Copiar exemplo em Node" code={NODE_VERIFY_SNIPPET} />
        </TabsContent>
        <TabsContent value="python">
          <CopySnippet label="Copiar exemplo em Python" code={PYTHON_VERIFY_SNIPPET} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
