import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Save, X, Info, Send, Pencil, AlertTriangle } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { AiPersonaBadge } from "@/components/ai/ai-persona-badge";
import { EmptyState } from "@/components/common/EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/format";
import { useCurrentProfile } from "@/lib/api/session";
import { useIntegration, useTenantChannels } from "@/lib/api/integrations";
import { renderPreviewReply } from "@/lib/ai/preview-reply";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import {
  useTenantAiEnabled,
  useSetTenantAiEnabled,
  useAiSettings,
  useUpdateAiSettings,
  useStagesWithConfig,
  useUpsertStageConfig,
  useAiResponseBehavior,
  useUpdateAiResponseBehavior,
  aiResponseBehaviorSchema,
  playgroundChat,
  aiResponseTimingSchema,
  type StageWithConfig,
} from "@/lib/api/ai-config";
import { useRecentAiFailureCount } from "@/lib/api/ai-failure-logs";
import type { AiResponseBehavior } from "@/lib/api/ai-config";

/**
 * Corpo da antiga rota /assistente, agora aba "Assistente IA" dentro de
 * Configurações (gate de admin já é feito por ConfiguracoesPage). Rota
 * antiga vira redirect (ver _app.assistente.tsx).
 */
export function AiAssistantTab() {
  // Controlado (era defaultValue) só para o diálogo de ativação conseguir
  // levar o operador até a área de teste sem sair da página.
  const [aba, setAba] = useState("config");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AiPersonaBadge size="sm" />
        <div className="flex flex-wrap items-center gap-2">
          <RecentAiFailuresLink />
          <EditPersonaLink />
          <GeneralToggle onIrParaAreaDeTeste={() => setAba("playground")} />
        </div>
      </div>

      <Tabs value={aba} onValueChange={setAba} className="flex flex-col gap-4">
        <TabsList className="w-full max-w-md">
          <TabsTrigger value="config" className="flex-1">
            Configuração
          </TabsTrigger>
          <TabsTrigger value="playground" className="flex-1">
            Área de teste
          </TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-0 flex flex-col gap-6">
          <PromptCard />
          <SendModeCard />
          <VoiceReplyCard />
          <HandoffDefaultsCard />
          <StagesCard />
        </TabsContent>

        <TabsContent value="playground" className="mt-0">
          <PlaygroundCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Atalho pro editor de nome/emoji da persona -- mora numa aba IRMÃ ("Features
 * de IA" / AiFeaturesTab, chave `ia/features`), não nesta mesma aba, por isso
 * não é auto-referencial: o card "Persona da IA" vive lá, prompt/comportamento
 * vivem aqui.
 *
 * A chave tem que ser `ia/features` inteira: "ia" sozinho é resolvido por
 * AiSettingsTab para a sub-aba padrão (assistente), que é justamente esta.
 */
function EditPersonaLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/configuracoes" hash="ia/features">
        <Pencil className="mr-2 h-4 w-4" />
        Editar persona
      </Link>
    </Button>
  );
}

/** Espelha o badge de atenção da Inbox (AppSidebar.tsx, item /inbox) para falhas recentes da IA. */
function RecentAiFailuresLink() {
  const count = useRecentAiFailureCount();
  if (count <= 0) return null;

  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <Link to="/configuracoes" hash="ia/falhas">
        <AlertTriangle className="mr-2 h-4 w-4" />
        {count} falha{count === 1 ? "" : "s"} recente{count === 1 ? "" : "s"}
      </Link>
    </Button>
  );
}

/**
 * Ligar é o único sentido que muda a vida do cliente: do clique em diante a
 * IA responde sozinha a quem chegar. Por isso só o LIGAR pede confirmação —
 * desligar continua imediato, porque desligar nunca piora a situação.
 *
 * O diálogo mostra apenas sinais que existem de verdade no sistema: canal
 * conectado (`channels.status`) e modo de envio (`ai_settings.send_mode`).
 * "Já testou na área de teste" NÃO é gravado em lugar nenhum — a área de
 * teste chama a edge function `ai-playground`, que só lê configuração e não
 * escreve nada. Então isso entra como recomendação com atalho, nunca como
 * bloqueio: prometer uma checagem que não existe seria pior que não checar.
 */
function GeneralToggle({ onIrParaAreaDeTeste }: { onIrParaAreaDeTeste: () => void }) {
  const { data: enabled, isLoading } = useTenantAiEnabled();
  const mutation = useSetTenantAiEnabled();
  const channels = useTenantChannels();
  const { data: sendMode } = useSendMode();
  const [confirmandoAtivacao, setConfirmandoAtivacao] = useState(false);

  const temCanalConectado = (channels.data ?? []).some((c) => c.status === "connected");

  const aplicar = (ligado: boolean) =>
    mutation.mutate(ligado, {
      onSuccess: () => toast.success(ligado ? "IA ativada." : "IA desativada."),
      onError: (e: Error) => toast.error(e.message || "Falha ao atualizar."),
    });

  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
        <div className="text-right">
          <Label htmlFor="ai-toggle" className="cursor-pointer text-body font-medium">
            Assistente de IA ativa
          </Label>
          <p className="text-caption text-muted-foreground">
            Responde leads automaticamente nos canais conectados.
          </p>
        </div>
        <Switch
          id="ai-toggle"
          checked={!!enabled}
          disabled={isLoading || mutation.isPending}
          onCheckedChange={(v) => {
            if (v) {
              setConfirmandoAtivacao(true);
              return;
            }
            aplicar(false);
          }}
          aria-label="Ativar assistente de IA"
        />
      </div>

      <AlertDialog open={confirmandoAtivacao} onOpenChange={setConfirmandoAtivacao}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ligar a IA para conversas de verdade?</AlertDialogTitle>
            <AlertDialogDescription>
              A partir de agora ela responde sozinha a quem entrar em contato. Confira como está
              hoje:
            </AlertDialogDescription>
          </AlertDialogHeader>

          <ul className="flex flex-col gap-2 text-body">
            <li className="rounded-lg border border-border bg-card px-3 py-2">
              {temCanalConectado
                ? "Você tem um canal conectado — as respostas vão sair de verdade para o cliente."
                : "Nenhum canal conectado ainda. A IA só vai começar a responder depois que você conectar o WhatsApp."}
            </li>
            <li className="rounded-lg border border-border bg-card px-3 py-2">
              {sendMode === "draft"
                ? "Modo rascunho: cada resposta fica esperando alguém do time aprovar antes de sair."
                : "Modo automático: cada resposta vai direto para o cliente, sem ninguém revisar antes."}
            </li>
            <li className="rounded-lg border border-border bg-card px-3 py-2">
              Ainda não sabemos se você já conversou com ela na área de teste — lá nada é enviado
              para ninguém.{" "}
              <button
                type="button"
                onClick={() => {
                  setConfirmandoAtivacao(false);
                  onIrParaAreaDeTeste();
                }}
                className="underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Testar antes
              </button>
            </li>
          </ul>

          <AlertDialogFooter>
            <AlertDialogCancel>Agora não</AlertDialogCancel>
            <AlertDialogAction onClick={() => aplicar(true)}>Ligar a IA</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PromptCard() {
  const { data: settings, isLoading } = useAiSettings();
  const updateSettings = useUpdateAiSettings();
  // Tamanho RECOMENDADO, não teto. Truncar aqui apagava conteúdo já salvo: o
  // prompt vinha do banco com 4440 caracteres, a primeira tecla digitada cortava
  // para 4000 e o Salvar seguinte destruía 440 caracteres sem avisar. Nada no
  // banco nem em useUpdateAiSettings jamais validou isso — o número só existia
  // para destruir o que outra porta deixou entrar.
  //
  // Por que 8000 e não 4000: os 5 tenants de produção já estavam ACIMA do teto
  // antigo (6091, 4440, 4440, 4098, 4098), porque o prompt é gerado no
  // onboarding, não digitado — o padrão de fábrica tem só 126 caracteres. 8000
  // cobre o maior prompt real com ~30% de folga para editar sem estourar.
  //
  // Por que continua existindo um número: é um empurrão, não uma trava. O custo
  // real está em escala diferente — o prompt final é
  // `base + estágio + guarda de escopo + contexto adaptativo + RAG`
  // (pipeline.ts:247), e só o trecho de RAG chega a 8 chunks de 3200 caracteres.
  // O prompt base não é o termo dominante; passar de 8000 é sinal de que ele
  // virou documentação, não instrução.
  const max = 8000;
  const [prompt, setPrompt] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const overLimit = prompt.length > max;

  useEffect(() => {
    if (settings && !dirty) setPrompt(settings.base_system_prompt);
  }, [settings, dirty]);

  const save = () => {
    updateSettings.mutate(
      { base_system_prompt: prompt },
      {
        onSuccess: () => {
          setDirty(false);
          setSavedFlash(true);
          toast.success("Prompt base salvo.");
          setTimeout(() => setSavedFlash(false), 2500);
        },
        onError: (e: Error) => toast.error(e.message || "Falha ao salvar o prompt."),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompt base</CardTitle>
        <CardDescription>
          Instruções gerais que a IA segue em todas as conversas. Use frases curtas e diretas.
          Variáveis como{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-caption">{"{{empresa}}"}</code> são
          preenchidas com dados do perfil do negócio.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Textarea
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setDirty(true);
            }}
            rows={10}
            className="font-mono text-body leading-relaxed"
            aria-label="Prompt base do assistente"
          />
        )}
        <div className="flex items-center justify-between">
          <span
            className={
              overLimit ? "text-caption text-warning" : "text-caption text-muted-foreground"
            }
          >
            {prompt.length} / {max} caracteres
            {overLimit && " — prompt longo encarece cada mensagem"}
          </span>
          <div className="flex items-center gap-2">
            {savedFlash && <StatusBadge variant="success">Salvo</StatusBadge>}
            <Button onClick={save} disabled={!dirty || updateSettings.isPending}>
              <Save className="mr-2 h-4 w-4" />
              {updateSettings.isPending ? "Salvando..." : "Salvar prompt"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

type VoiceReplyMode = AiResponseBehavior["voice_reply_mode"];
type VoiceSettingsRow = Pick<AiResponseBehavior, "voice_reply_mode" | "voice_id">;

const RESPONSE_TIMING_FIELDS = [
  { key: "max_response_blocks", label: "Máximo de blocos por resposta", min: 1, max: 5 },
  { key: "response_block_delay_ms", label: "Intervalo entre blocos (ms)", min: 0, max: 10000 },
  { key: "message_coalesce_window_ms", label: "Janela de agrupamento (ms)", min: 0, max: 120000 },
] as const;

type TimingDraft = Record<(typeof RESPONSE_TIMING_FIELDS)[number]["key"], string>;

/** Voz padrão da ElevenLabs (Sarah) usada ao ligar a resposta em áudio. */
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

const VOICE_MODE_OPTIONS: { value: VoiceReplyMode; label: string; hint: string }[] = [
  {
    value: "off",
    label: "Sempre em texto",
    hint: "A IA nunca responde em áudio. Não consome créditos da ElevenLabs.",
  },
  {
    value: "on_audio",
    label: "Espelhar o cliente",
    hint: "Responde em áudio só quando o cliente mandou áudio; no resto, texto.",
  },
  {
    value: "always",
    label: "Sempre em áudio",
    hint: "Toda resposta vira áudio. É a opção que mais consome créditos da sua conta ElevenLabs.",
  },
];

function VoiceReplyCard() {
  const [timingDraft, setTimingDraft] = useState<TimingDraft | null>(null);
  const elevenlabs = useIntegration("elevenlabs");
  const [voiceIdDraft, setVoiceIdDraft] = useState("");

  const { data: voice, isLoading, isError, error } = useAiResponseBehavior();

  useEffect(() => {
    setVoiceIdDraft(voice?.voice_id ?? "");
  }, [voice?.voice_id]);

  const mutation = useUpdateAiResponseBehavior();
  const saveVoice = (patch: Partial<VoiceSettingsRow>) =>
    mutation.mutate(patch, {
      onSuccess: () => toast.success("Preferência de voz atualizada."),
      onError: (e: Error) => toast.error(e.message || "Falha ao atualizar a preferência de voz."),
    });
  const timing = timingDraft ?? {
    max_response_blocks: String(voice?.max_response_blocks ?? 1),
    response_block_delay_ms: String(voice?.response_block_delay_ms ?? 1200),
    message_coalesce_window_ms: String(voice?.message_coalesce_window_ms ?? 3000),
  };
  const timingValidation = aiResponseTimingSchema.safeParse({
    max_response_blocks: Number(timing.max_response_blocks),
    response_block_delay_ms: Number(timing.response_block_delay_ms),
    message_coalesce_window_ms: Number(timing.message_coalesce_window_ms),
  });
  const invalidTiming =
    RESPONSE_TIMING_FIELDS.some(({ key }) => timing[key].trim() === "") ||
    !timingValidation.success;
  const budgetIssue = timingValidation.success
    ? undefined
    : timingValidation.error.issues.find((issue) => issue.code === "custom")?.message;
  const saveTiming = () => {
    if (invalidTiming || !timingDraft || !timingValidation.success) return;
    mutation.mutate(timingValidation.data, {
      onSuccess: () => {
        setTimingDraft(null);
        toast.success("Comportamento das respostas salvo.");
      },
      onError: (e: Error) => toast.error(e.message || "Falha ao salvar o comportamento."),
    });
  };

  const mode = voice?.voice_reply_mode ?? "off";
  const precisaVoz = mode !== "off" && !voiceIdDraft.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comportamento das respostas</CardTitle>
        <CardDescription>
          Ajuste os blocos, a espera para agrupar mensagens e o formato. Áudio e rascunhos continuam
          em uma única mensagem. A voz usa créditos da sua conta ElevenLabs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {RESPONSE_TIMING_FIELDS.map(({ key, label, min, max }) => {
                const invalid =
                  timing[key].trim() === "" ||
                  !aiResponseBehaviorSchema.shape[key].safeParse(Number(timing[key])).success;
                return (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`ai-${key}`}>{label}</Label>
                    <Input
                      id={`ai-${key}`}
                      type="number"
                      min={min}
                      max={max}
                      step={1}
                      value={timing[key]}
                      disabled={isError || mutation.isPending}
                      aria-invalid={invalid}
                      aria-describedby={`ai-${key}-range`}
                      onChange={(e) => setTimingDraft({ ...timing, [key]: e.target.value })}
                    />
                    <p id={`ai-${key}-range`} className="text-caption text-muted-foreground">
                      Inteiro de {min} a {max}.
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-caption text-muted-foreground">
              O máximo é um limite, não uma meta: trechos curtos ficam juntos. A janela de
              agrupamento só espera quando chegam várias mensagens em sequência; zero remove a
              espera. O prazo do turno inclui transcrição, geração, áudio e cada envio. Se o tempo
              restante não for suficiente, a espera é reduzida ou os próximos blocos são
              interrompidos, e a conversa fica sinalizada para revisão humana.
            </p>
            {budgetIssue && (
              <Alert variant="destructive" aria-labelledby="ai-timing-budget-title">
                <AlertTitle id="ai-timing-budget-title">Tempo de espera excedido</AlertTitle>
                <AlertDescription>{budgetIssue}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end">
              <Button
                onClick={saveTiming}
                disabled={!timingDraft || invalidTiming || isError || mutation.isPending}
              >
                {mutation.isPending ? "Salvando..." : "Salvar comportamento"}
              </Button>
            </div>
            {!elevenlabs.isLoading && !elevenlabs.isActive && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>ElevenLabs não conectada</AlertTitle>
                <AlertDescription>
                  Sem a integração ativa a IA continua respondendo em texto, mesmo com uma opção de
                  áudio marcada aqui.{" "}
                  <Link to="/configuracoes" hash="integracoes" className="underline">
                    Conectar agora
                  </Link>
                </AlertDescription>
              </Alert>
            )}

            {/* Sem isto, uma falha de LEITURA renderiza mode="off" e o operador lê
                "Sempre em texto" como se fosse a configuração salva — inclusive no
                cenário que a própria queryFn prevê (migration ainda não aplicada).
                A mutation tem toast de erro; a query não tinha nada, e não há
                QueryCache.onError global. */}
            {isError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Não foi possível ler o comportamento da IA</AlertTitle>
                <AlertDescription>
                  Os valores exibidos neste card <strong>não</strong> são os valores salvos.
                  Recarregue a página; se persistir, avise o suporte.
                  {error?.message ? ` (${error.message})` : ""}
                </AlertDescription>
              </Alert>
            )}

            <RadioGroup
              value={mode}
              onValueChange={(v) => {
                const nextMode = v as VoiceReplyMode;
                // Ligar a voz sem voice_id deixava a resposta em áudio quebrada
                // silenciosamente: já sai com a voz padrão (Sarah) preenchida.
                const patch: Partial<VoiceSettingsRow> = { voice_reply_mode: nextMode };
                if (nextMode !== "off" && !voiceIdDraft.trim() && !voice?.voice_id) {
                  patch.voice_id = DEFAULT_VOICE_ID;
                  setVoiceIdDraft(DEFAULT_VOICE_ID);
                }
                saveVoice(patch);
              }}
              disabled={mutation.isPending || isError}
              className="gap-3"
            >
              {VOICE_MODE_OPTIONS.map((opt) => (
                <div
                  key={opt.value}
                  className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <RadioGroupItem
                    value={opt.value}
                    id={`voice-mode-${opt.value}`}
                    className="mt-0.5"
                  />
                  <div>
                    <Label
                      htmlFor={`voice-mode-${opt.value}`}
                      className="cursor-pointer text-body font-medium"
                    >
                      {opt.label}
                    </Label>
                    <p className="text-caption text-muted-foreground">{opt.hint}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>

            {mode !== "off" && (
              <div className="space-y-2">
                <Label htmlFor="voice-id" className="text-body font-medium">
                  Voz da ElevenLabs
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="voice-id"
                    value={voiceIdDraft}
                    onChange={(e) => setVoiceIdDraft(e.target.value)}
                    placeholder="ID da voz (ex.: 21m00Tcm4TlvDq8ikWAM)"
                    aria-invalid={precisaVoz}
                  />
                  <Button
                    onClick={() => saveVoice({ voice_id: voiceIdDraft.trim() || null })}
                    disabled={mutation.isPending || voiceIdDraft.trim() === (voice?.voice_id ?? "")}
                  >
                    <Save className="mr-1.5 h-4 w-4" />
                    Salvar
                  </Button>
                </div>
                <p className="text-caption text-muted-foreground">
                  Copie o ID em{" "}
                  <a
                    href="https://try.elevenlabs.io/o2c8mt1d8jaa"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Voice Library da ElevenLabs
                  </a>
                  . {precisaVoz && "Sem uma voz escolhida, a resposta continua saindo em texto."}
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

type SendMode = "auto" | "draft";

/**
 * Fonte única do modo de envio: o card abaixo e o diálogo de ativação leem a
 * mesma query, então não conseguem discordar sobre o que vai acontecer com a
 * resposta.
 */
function useSendMode() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;

  return useQuery<SendMode>({
    queryKey: ["ai-send-mode", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_settings")
        .select("send_mode")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data?.send_mode === "draft" ? "draft" : "auto";
    },
  });
}

function SendModeCard() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  const qc = useQueryClient();

  const { data: sendMode, isLoading } = useSendMode();

  const mutation = useMutation({
    mutationFn: async (mode: SendMode) => {
      if (!tenantId) throw new Error("Sem tenant.");
      const { error } = await supabase
        .from("ai_settings")
        .upsert({ tenant_id: tenantId, send_mode: mode }, { onConflict: "tenant_id" });
      if (error) throw error;
      return mode;
    },
    onSuccess: (mode) => {
      qc.invalidateQueries({ queryKey: ["ai-send-mode", tenantId] });
      toast.success(mode === "draft" ? "Modo rascunho ativado." : "Modo automático ativado.");
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao atualizar o modo de envio."),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modo de envio</CardTitle>
        <CardDescription>
          Defina se as respostas geradas pela IA são enviadas na hora ou ficam aguardando aprovação
          do time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <RadioGroup
            value={sendMode ?? "auto"}
            onValueChange={(v) => mutation.mutate(v as SendMode)}
            disabled={mutation.isPending}
            className="gap-3"
          >
            <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <RadioGroupItem value="auto" id="send-mode-auto" className="mt-0.5" />
              <div>
                <Label htmlFor="send-mode-auto" className="cursor-pointer text-body font-medium">
                  Automático
                </Label>
                <p className="text-caption text-muted-foreground">
                  A IA responde e envia direto ao lead pelo canal conectado.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <RadioGroupItem value="draft" id="send-mode-draft" className="mt-0.5" />
              <div>
                <Label htmlFor="send-mode-draft" className="cursor-pointer text-body font-medium">
                  Rascunho para aprovação
                </Label>
                <p className="text-caption text-muted-foreground">
                  A IA gera a resposta como rascunho e a conversa fica aguardando um humano revisar
                  antes do envio.
                </p>
              </div>
            </div>
          </RadioGroup>
        )}
        <p className="mt-4 text-caption text-muted-foreground">
          Os limiares de confiança e a aprovação humana das mudanças de estágio são configurados por
          transição em{" "}
          <Link to="/pipeline" className="text-primary underline underline-offset-4">
            Pipeline → Autonomia
          </Link>
          . O modo acima controla o envio das mensagens, não a movimentação do funil.
        </p>
      </CardContent>
    </Card>
  );
}

function HandoffDefaultsCard() {
  const { data: settings, isLoading } = useAiSettings();
  const updateSettings = useUpdateAiSettings();
  const [chip, setChip] = useState("");
  const [local, setLocal] = useState<string[] | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const kws = local ?? settings?.handoff_default_keywords ?? [];

  const addChip = () => {
    const v = chip.trim();
    if (!v) return;
    if (kws.some((k) => k.toLowerCase() === v.toLowerCase())) {
      setChip("");
      return;
    }
    setLocal([...kws, v]);
    setChip("");
  };
  const remove = (w: string) => setLocal(kws.filter((k) => k !== w));

  const dirty = local !== null;
  const save = () => {
    if (!local) return;
    updateSettings.mutate(
      { handoff_default_keywords: local },
      {
        onSuccess: () => {
          setLocal(null);
          setSavedFlash(true);
          toast.success("Palavras de transferência atualizadas.");
          setTimeout(() => setSavedFlash(false), 2500);
        },
        onError: (e: Error) => toast.error(e.message || "Falha ao salvar."),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Palavras de transferência (padrão)</CardTitle>
        <CardDescription>
          Se o lead usar qualquer uma destas palavras em qualquer estágio, a IA pausa e transfere a
          conversa para humano.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {kws.length === 0 ? (
                <span className="text-caption text-muted-foreground">
                  Nenhuma palavra configurada.
                </span>
              ) : (
                kws.map((w) => (
                  <span
                    key={w}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-caption"
                  >
                    {w}
                    <button
                      type="button"
                      onClick={() => remove(w)}
                      aria-label={`Remover ${w}`}
                      className="rounded text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={chip}
                onChange={(e) => setChip(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addChip();
                  }
                }}
                placeholder="Digite uma palavra e pressione Enter"
                className="max-w-sm"
              />
              <Button type="button" variant="secondary" onClick={addChip}>
                Adicionar
              </Button>
              <div className="ml-auto flex items-center gap-2">
                {savedFlash && <StatusBadge variant="success">Salvo</StatusBadge>}
                <Button onClick={save} disabled={!dirty || updateSettings.isPending}>
                  <Save className="mr-2 h-4 w-4" />
                  Salvar
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StagesCard() {
  const { data: stages, isLoading } = useStagesWithConfig();
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const upsert = useUpsertStageConfig();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comportamento por estágio do funil</CardTitle>
        <CardDescription>
          Defina objetivo, prompt do estágio, critérios de avanço e palavras que transferem para
          humano em cada etapa.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : !stages || stages.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Info}
              title="Nenhum estágio no funil"
              description="Configure o funil de vendas em Configurações → Funil para editar o comportamento da IA por estágio."
            />
          </div>
        ) : (
          <>
            <div className="hidden grid-cols-[1fr_1.5fr_1.5fr_1.5fr_auto] items-center gap-4 border-b border-border bg-surface px-4 py-2 text-caption font-medium uppercase tracking-wide text-muted-foreground md:grid">
              <span>Estágio</span>
              <span>Objetivo</span>
              <span>Critérios de avanço</span>
              <span>Palavras de transferência</span>
              <span className="text-center">Ativo</span>
            </div>
            <ul>
              {stages.map((s) => {
                const open = openStageId === s.stage_id;
                return (
                  <li key={s.stage_id} className="border-b border-border last:border-b-0">
                    <Collapsible
                      open={open}
                      onOpenChange={(v) => setOpenStageId(v ? s.stage_id : null)}
                    >
                      <CollapsibleTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          aria-expanded={open}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setOpenStageId(open ? null : s.stage_id);
                            }
                          }}
                          className={cn(
                            "grid w-full cursor-pointer grid-cols-1 md:grid-cols-[1fr_1.5fr_1.5fr_1.5fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent focus:outline-none focus-visible:bg-accent",
                            open && "bg-accent",
                          )}
                        >
                          <span className="text-body font-medium text-foreground">
                            {s.stage_name}
                          </span>
                          <span className="line-clamp-2 text-body text-muted-foreground">
                            {s.stage_goal || "—"}
                          </span>
                          <span className="line-clamp-2 text-body text-muted-foreground">
                            {s.advancement_criteria.length === 0
                              ? "—"
                              : s.advancement_criteria.join(" · ")}
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {s.handoff_keywords.length === 0 ? (
                              <span className="text-caption text-muted-foreground">Nenhuma</span>
                            ) : (
                              s.handoff_keywords.map((w) => (
                                <StatusBadge key={w} variant="neutral">
                                  {w}
                                </StatusBadge>
                              ))
                            )}
                          </span>
                          <span
                            className="flex justify-center"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            role="presentation"
                          >
                            <Switch
                              checked={s.enabled}
                              onCheckedChange={(v) =>
                                upsert.mutate(
                                  {
                                    stage_id: s.stage_id,
                                    enabled: v,
                                    stage_goal: s.stage_goal,
                                    system_prompt: s.system_prompt,
                                    advancement_criteria: s.advancement_criteria,
                                    handoff_keywords: s.handoff_keywords,
                                  },
                                  {
                                    onSuccess: () =>
                                      toast.success(
                                        v
                                          ? `IA ativada em "${s.stage_name}".`
                                          : `IA pausada em "${s.stage_name}".`,
                                      ),
                                    onError: (e: Error) =>
                                      toast.error(e.message || "Falha ao atualizar."),
                                  },
                                )
                              }
                              aria-label={`Ativar IA no estágio ${s.stage_name}`}
                            />
                          </span>
                        </div>
                      </CollapsibleTrigger>

                      <CollapsibleContent className="border-t border-border bg-surface px-4 py-4">
                        <StageEditor stage={s} />
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StageEditor({ stage }: { stage: StageWithConfig }) {
  const [goal, setGoal] = useState(stage.stage_goal);
  const [systemPrompt, setSystemPrompt] = useState(stage.system_prompt);
  const [criteria, setCriteria] = useState<string[]>(stage.advancement_criteria);
  const [keywords, setKeywords] = useState<string[]>(stage.handoff_keywords);
  const [newCriterion, setNewCriterion] = useState("");
  const [newKeyword, setNewKeyword] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const upsert = useUpsertStageConfig();

  useEffect(() => {
    setGoal(stage.stage_goal);
    setSystemPrompt(stage.system_prompt);
    setCriteria(stage.advancement_criteria);
    setKeywords(stage.handoff_keywords);
  }, [
    stage.stage_id,
    stage.stage_goal,
    stage.system_prompt,
    stage.advancement_criteria,
    stage.handoff_keywords,
  ]);

  const addCriterion = () => {
    const v = newCriterion.trim();
    if (!v || criteria.includes(v)) return;
    setCriteria([...criteria, v]);
    setNewCriterion("");
  };
  const addKeyword = () => {
    const v = newKeyword.trim();
    if (!v || keywords.some((k) => k.toLowerCase() === v.toLowerCase())) return;
    setKeywords([...keywords, v]);
    setNewKeyword("");
  };

  const save = () => {
    upsert.mutate(
      {
        stage_id: stage.stage_id,
        enabled: stage.enabled,
        stage_goal: goal,
        system_prompt: systemPrompt,
        advancement_criteria: criteria,
        handoff_keywords: keywords,
      },
      {
        onSuccess: () => {
          toast.success("Estágio salvo.");
          setSavedFlash(true);
          setTimeout(() => setSavedFlash(false), 2500);
        },
        onError: (e: Error) => toast.error(e.message || "Falha ao salvar."),
      },
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`goal-${stage.stage_id}`}>Objetivo do estágio</Label>
        <Textarea
          id={`goal-${stage.stage_id}`}
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="O que a IA deve fazer neste estágio."
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`prompt-${stage.stage_id}`}>Prompt do estágio</Label>
        <Textarea
          id={`prompt-${stage.stage_id}`}
          rows={3}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Instruções adicionais que a IA aplica quando o lead está neste estágio."
          className="font-mono text-body leading-relaxed"
        />
      </div>

      <div className="flex flex-col gap-1.5 md:col-span-2">
        <Label>Critérios de avanço</Label>
        <p className="text-caption text-muted-foreground">
          A IA só move o negócio para o próximo estágio quando <strong>todos</strong> os critérios
          abaixo estiverem cumpridos na conversa.
        </p>
        <ul className="flex flex-col gap-1">
          {criteria.map((c, idx) => (
            <li
              key={`${c}-${idx}`}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1"
            >
              <span className="flex-1 text-body">{c}</span>
              <button
                type="button"
                onClick={() => setCriteria(criteria.filter((_, i) => i !== idx))}
                aria-label={`Remover critério ${c}`}
                className="rounded text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Input
            value={newCriterion}
            onChange={(e) => setNewCriterion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCriterion();
              }
            }}
            placeholder="Ex.: Lead confirmou orçamento e prazo"
          />
          <Button type="button" variant="secondary" onClick={addCriterion}>
            Adicionar
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 md:col-span-2">
        <Label>Palavras que transferem para humano neste estágio</Label>
        <div className="flex flex-wrap gap-1.5">
          {keywords.length === 0 && (
            <span className="text-caption text-muted-foreground">Nenhuma.</span>
          )}
          {keywords.map((w) => (
            <span
              key={w}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-caption"
            >
              {w}
              <button
                type="button"
                onClick={() => setKeywords(keywords.filter((k) => k !== w))}
                aria-label={`Remover ${w}`}
                className="rounded text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKeyword();
              }
            }}
            placeholder="Digite uma palavra e pressione Enter"
            className="max-w-sm"
          />
          <Button type="button" variant="secondary" onClick={addKeyword}>
            Adicionar
          </Button>
        </div>
      </div>

      <div className="md:col-span-2 flex items-center justify-end gap-2">
        {savedFlash && <StatusBadge variant="success">Salvo</StatusBadge>}
        <Button onClick={save} disabled={upsert.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {upsert.isPending ? "Salvando..." : "Salvar estágio"}
        </Button>
      </div>
    </div>
  );
}

interface PlayMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

function PlaygroundCard() {
  const { data: stages } = useStagesWithConfig();
  const [stageId, setStageId] = useState<string>("none");
  const [messages, setMessages] = useState<PlayMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const clearConversation = () => {
    setMessages([]);
    setDraft("");
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const now = new Date().toISOString();
    const userMsg: PlayMsg = { id: `u-${Date.now()}`, role: "user", text, at: now };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setDraft("");
    setSending(true);
    try {
      const payload = {
        stage_id: stageId === "none" ? null : stageId,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.text })),
      };
      const { reply } = await playgroundChat(payload);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: renderPreviewReply(reply),
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      toast.error((e as Error).message || "Falha ao gerar resposta.");
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const list = useMemo(() => messages, [messages]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Área de teste</CardTitle>
        <CardDescription>Teste como a IA responderia antes de publicar mudanças.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Ambiente de teste</AlertTitle>
          <AlertDescription>
            Nada aqui é enviado por WhatsApp ou e-mail. A conversa não vira negócio, não cria
            atividades e some ao limpar.
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="stage-select" className="text-body">
            Estágio simulado
          </Label>
          <Select value={stageId} onValueChange={setStageId}>
            <SelectTrigger id="stage-select" className="w-64">
              <SelectValue placeholder="Sem estágio (apenas prompt base)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sem estágio (apenas prompt base)</SelectItem>
              {(stages ?? []).map((s) => (
                <SelectItem key={s.stage_id} value={s.stage_id}>
                  {s.stage_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={clearConversation}
              disabled={messages.length === 0}
            >
              Limpar conversa
            </Button>
          </div>
        </div>

        <div className="flex h-[420px] flex-col overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {list.length === 0 && (
              <p className="text-center text-caption text-muted-foreground">
                Envie a primeira mensagem como se você fosse o lead.
              </p>
            )}
            {list.map((m) => (
              <div
                key={m.id}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[75%] rounded-lg border px-3 py-2 shadow-sm",
                    m.role === "user"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-card-foreground",
                  )}
                >
                  {m.role === "assistant" && (
                    <div className="mb-1 inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-caption font-medium text-accent-foreground">
                      <AiPersonaBadge size="xs" />
                    </div>
                  )}
                  <p className="whitespace-pre-wrap text-body">{m.text}</p>
                  <p
                    className={cn(
                      "mt-1 text-right text-caption",
                      m.role === "user" ? "text-primary-foreground/75" : "text-muted-foreground",
                    )}
                  >
                    {formatTime(m.at)}
                  </p>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg border border-border bg-card px-3 py-2 text-body text-muted-foreground">
                  <AiPersonaBadge size="xs" className="mr-1" /> está pensando...
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border bg-card p-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                placeholder="Digite como se fosse um lead..."
                className="max-h-32 min-h-[44px] resize-none"
                rows={1}
                aria-label="Mensagem de teste"
              />
              <Button onClick={send} disabled={!draft.trim() || sending}>
                <Send className="h-4 w-4" />
                <span className="ml-2 hidden sm:inline">Enviar</span>
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
