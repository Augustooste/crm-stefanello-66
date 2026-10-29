import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SimulatorResult {
  ok: boolean;
  conversation_id: string;
  error?: string;
}

export function SimulatorComposer({
  channelId,
  tenantId,
  conversationId,
  onSent,
}: {
  channelId: string;
  tenantId: string;
  conversationId?: string;
  onSent?: (conversationId: string) => void;
}) {
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [clientId] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const send = useMutation({
    mutationFn: async () => {
      let media: { storage_path: string; type: string } | undefined;
      if (file) {
        if (file.size > 16 * 1024 * 1024) throw new Error("Anexo acima de 16 MB.");
        const extension =
          file.name
            .split(".")
            .pop()
            ?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
        const path = `${tenantId}/simulator/${channelId}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage
          .from("simulator-media")
          .upload(path, file, { contentType: file.type });
        if (error) throw error;
        media = { storage_path: path, type: file.type };
      }
      const { data, error } = await supabase.functions.invoke<SimulatorResult>(
        "channel-simulator",
        {
          body: {
            action: "send",
            channel_id: channelId,
            ...(conversationId ? { conversation_id: conversationId } : { client_id: clientId }),
            content: content.trim(),
            ...(media ? { media } : {}),
          },
        },
      );
      if (error) {
        const response =
          "context" in error && error.context instanceof Response ? error.context : null;
        const detail = await response?.json().catch(() => null);
        throw new Error(
          detail?.error ??
            "Não foi possível enviar como cliente. Confira o histórico antes de tentar novamente.",
        );
      }
      if (!data?.ok || !data.conversation_id) {
        throw new Error(data?.error ?? "A simulação não foi registrada.");
      }
      return data;
    },
    onSuccess: async (result) => {
      setContent("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] }),
        queryClient.invalidateQueries({ queryKey: ["inbox-messages", result.conversation_id] }),
      ]);
      onSent?.(result.conversation_id);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!send.isPending && (content.trim() || file)) send.mutate();
      }}
    >
      <p className="text-caption font-medium text-foreground">
        Simulação — não entregue no WhatsApp
      </p>
      <Textarea
        aria-label="Mensagem do cliente simulado"
        placeholder="Escreva como se fosse o cliente..."
        value={content}
        maxLength={8000}
        rows={2}
        disabled={send.isPending}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,audio/mpeg,audio/ogg,audio/mp4,audio/aac,audio/amr,audio/wav,audio/webm"
          aria-label="Anexo do cliente simulado"
          className="min-w-0 flex-1 basis-48"
          disabled={send.isPending}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Button type="submit" disabled={send.isPending || (!content.trim() && !file)}>
          {send.isPending ? "Registrando mensagem..." : "Enviar como cliente"}
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">
        A IA usa o modelo e as regras reais, inclusive pausas e atendimento humano. Imagens vão para
        atendimento humano; áudio precisa de transcrição ElevenLabs ativa. Até 16 MB por anexo.
      </p>
    </form>
  );
}

export function SimulatorLauncher({ onSent }: { onSent: (conversationId: string) => void }) {
  const { data: profile } = useCurrentProfile();
  const [open, setOpen] = useState(false);
  const channel = useQuery({
    queryKey: ["simulator-channel", profile?.tenant_id],
    enabled: !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("channels")
        .select("id")
        .eq("tenant_id", profile!.tenant_id)
        .eq("provider_slug", "simulator")
        .eq("type", "simulator")
        .eq("status", "connected")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  if (!profile || !channel.data) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Nova simulação
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova conversa simulada</DialogTitle>
            <DialogDescription>
              Teste o atendimento com IA real, sem credenciais de WhatsApp. Esta ação consome uso de
              IA.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <SimulatorComposer
              tenantId={profile.tenant_id}
              channelId={channel.data.id}
              onSent={(id) => {
                setOpen(false);
                onSent(id);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
