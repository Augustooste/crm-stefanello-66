// Configuração do External Request do ManyChat: header x-webhook-secret e
// corpo JSON. A URL do webhook já é exibida pelo SetupView.
//
// O segredo só aparece quando acabou de ser gerado (conexão ou "Gerar novo").
// Depois disso o backend não devolve mais — mostramos só que ele existe.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  FULL_CONTACT_DATA_PLACEHOLDER,
  type ManyChatSlug,
  manyChatRequestTemplate,
  manyChatSurfaceLabel,
} from "@/lib/integrations/manychat";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="w-full sm:w-auto sm:self-start"
      aria-label={copied ? `${label} copiado` : `Copiar ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success(`${label} copiado.`);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="mr-2 h-4 w-4 text-success" /> : <Copy className="mr-2 h-4 w-4" />}
      {copied ? "Copiado" : `Copiar ${label}`}
    </Button>
  );
}

export function ManyChatSetupPanel({
  slug,
  revealedSecret,
}: {
  slug: ManyChatSlug;
  revealedSecret: string | null;
}) {
  const [secret, setSecret] = useState<string | null>(revealedSecret);
  const template = manyChatRequestTemplate(slug);

  const rotate = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("integration-connect", {
        body: { action: "rotate_webhook_secret", slug },
      });
      if (error) throw error;
      if (!data?.ok || typeof data.webhook_secret !== "string") {
        throw new Error(data?.error ?? "Não foi possível gerar um novo segredo.");
      }
      return data.webhook_secret as string;
    },
    onSuccess: (value) => {
      setSecret(value);
      toast.success("Novo segredo gerado. Atualize o header no ManyChat.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="flex flex-col gap-4" data-testid="manychat-setup">
      <div className="flex flex-col gap-2">
        <Label>Header do External Request</Label>
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-3">
          <p className="text-caption text-muted-foreground">
            Nome do header: <code className="font-mono text-foreground">x-webhook-secret</code>
          </p>
          {secret ? (
            <>
              <code
                className="block w-full min-w-0 break-all font-mono text-caption text-foreground"
                data-testid="manychat-secret"
              >
                {secret}
              </code>
              <p className="text-caption text-warning">
                Copie agora: por segurança este valor não aparece de novo.
              </p>
              <CopyButton value={secret} label="segredo" />
            </>
          ) : (
            <p className="text-caption text-muted-foreground" data-testid="manychat-secret-hidden">
              Valor salvo com segurança (••••••••). Perdeu? Gere um novo e troque no ManyChat — o
              antigo para de funcionar na hora.
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full sm:w-auto sm:self-start"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            Gerar novo segredo
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Corpo (JSON) do External Request</Label>
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-3">
          <pre
            className="overflow-x-auto font-mono text-caption text-foreground"
            data-testid="manychat-template"
          >
            {template}
          </pre>
          <p className="text-caption text-muted-foreground">
            Troque <code className="font-mono">{FULL_CONTACT_DATA_PLACEHOLDER}</code> pela variável{" "}
            <strong>Full Contact Data</strong>, inserida pelo seletor de variáveis do ManyChat (sem
            aspas em volta).
          </p>
          <CopyButton value={template} label="JSON" />
        </div>
      </div>

      <ol className="flex list-decimal flex-col gap-1 pl-5 text-caption text-muted-foreground">
        <li>
          No ManyChat, abra a automação do canal {manyChatSurfaceLabel(slug)} que recebe a mensagem
          do contato.
        </li>
        <li>Adicione uma ação: Make External Request, tipo POST.</li>
        <li>Cole a URL do webhook acima.</li>
        <li>
          Em Headers, adicione <code className="font-mono">x-webhook-secret</code> com o segredo.
        </li>
        <li>Em Body, cole o JSON e insira a variável Full Contact Data.</li>
        <li>Na aba Response, escolha um contato e clique em Test Request: espere HTTP 200.</li>
      </ol>
    </section>
  );
}
