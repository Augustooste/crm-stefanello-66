// Ajustes de voz da ElevenLabs dentro do modal "Gerenciar" da integração.
//
// Ficavam só na aba IA das Configurações; quem acabou de conectar a chave já
// está aqui, então a voz e o modelo de geração passam a ser editáveis no
// mesmo lugar. Os dois campos gravam em public.ai_settings — a mesma fonte que
// as edge functions (`loadVoiceReplyPreference`) leem na hora de responder.
//
// A lista de vozes vem da própria conta ElevenLabs, via edge function
// `integration-connect` (action `list_voices`) — a chave de API nunca chega
// ao browser. Se a listagem falhar, cai no campo manual de ID para ninguém
// ficar travado.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pause, Play, RefreshCw, Save, Search } from "lucide-react";

import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

/** Precisa espelhar TTS_MODELS em supabase/functions/_shared/ai/voice.ts. */
export const TTS_MODEL_OPTIONS = [
  {
    value: "eleven_multilingual_v2",
    label: "Multilingual v2 (padrão)",
    hint: "Melhor qualidade, cobre PT-BR. Recomendado.",
  },
  {
    value: "eleven_turbo_v2_5",
    label: "Turbo v2.5",
    hint: "Mais rápido e barato, qualidade um pouco menor.",
  },
  { value: "eleven_turbo_v2", label: "Turbo v2", hint: "Geração rápida, só inglês." },
  {
    value: "eleven_flash_v2_5",
    label: "Flash v2.5",
    hint: "Menor latência possível; ideal para respostas curtas.",
  },
  {
    value: "eleven_monolingual_v1",
    label: "Monolingual v1",
    hint: "Modelo antigo, só inglês.",
  },
] as const;

const DEFAULT_MODEL = "eleven_multilingual_v2";

type VoiceRow = { voice_id: string | null; voice_model: string | null };

export type CatalogVoice = {
  voice_id: string;
  name: string;
  gender: "feminina" | "masculina" | "neutra";
  accent: string | null;
  language: string | null;
  category: string | null;
  description: string | null;
  preview_url: string | null;
};

const GENDER_FILTERS = [
  { value: "todas", label: "Todas" },
  { value: "feminina", label: "Femininas" },
  { value: "masculina", label: "Masculinas" },
] as const;

export function ElevenLabsVoiceSettings({
  onVoiceConfigured,
}: {
  onVoiceConfigured?: (configured: boolean) => void;
}) {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  const qc = useQueryClient();
  const [voiceIdDraft, setVoiceIdDraft] = useState("");
  const [modelDraft, setModelDraft] = useState<string>(DEFAULT_MODEL);
  const [gender, setGender] = useState<(typeof GENDER_FILTERS)[number]["value"]>("todas");
  const [search, setSearch] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { data, isLoading, isError, error } = useQuery<VoiceRow>({
    queryKey: ["ai-voice-reply", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_settings")
        .select("voice_id, voice_model")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      const row = (data ?? null) as unknown as Partial<VoiceRow> | null;
      return { voice_id: row?.voice_id ?? null, voice_model: row?.voice_model ?? null };
    },
  });

  const voicesQuery = useQuery<{ voices: CatalogVoice[]; error: string | null }>({
    queryKey: ["elevenlabs-voices", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("integration-connect", {
        body: { action: "list_voices", slug: "elevenlabs" },
      });
      if (error) throw error;
      const res = (data ?? {}) as { ok?: boolean; voices?: CatalogVoice[]; error?: string };
      if (!res.ok) return { voices: [], error: res.error ?? "Não foi possível listar as vozes." };
      return { voices: res.voices ?? [], error: null };
    },
  });

  useEffect(() => {
    setVoiceIdDraft(data?.voice_id ?? "");
    setModelDraft(data?.voice_model ?? DEFAULT_MODEL);
  }, [data?.voice_id, data?.voice_model]);

  useEffect(() => {
    onVoiceConfigured?.(Boolean(data?.voice_id?.trim()));
  }, [data?.voice_id, onVoiceConfigured]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const voices = useMemo(() => voicesQuery.data?.voices ?? [], [voicesQuery.data?.voices]);
  const listError = voicesQuery.isError
    ? "Não foi possível carregar as vozes agora."
    : (voicesQuery.data?.error ?? null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return voices.filter((v) => {
      if (gender !== "todas" && v.gender !== gender) return false;
      if (!term) return true;
      return (
        v.name.toLowerCase().includes(term) ||
        v.voice_id.toLowerCase().includes(term) ||
        (v.accent ?? "").toLowerCase().includes(term) ||
        (v.language ?? "").toLowerCase().includes(term)
      );
    });
  }, [voices, gender, search]);

  const selectedVoice = voices.find((v) => v.voice_id === voiceIdDraft) ?? null;

  function togglePreview(voice: CatalogVoice) {
    if (!voice.preview_url) return;
    if (playingId === voice.voice_id) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(voice.preview_url);
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => {
      setPlayingId(null);
      toast.error("Não foi possível tocar a prévia dessa voz.");
    };
    audioRef.current = audio;
    setPlayingId(voice.voice_id);
    void audio.play().catch(() => {
      setPlayingId(null);
      toast.error("Não foi possível tocar a prévia dessa voz.");
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Sem workspace ativo.");
      const { error } = await supabase.from("ai_settings").upsert(
        {
          tenant_id: tenantId,
          voice_id: voiceIdDraft.trim() || null,
          voice_model: modelDraft,
        } as never,
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai-voice-reply", tenantId] });
      toast.success("Configuração de voz salva.");
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao salvar a configuração de voz."),
  });

  const dirty =
    voiceIdDraft.trim() !== (data?.voice_id ?? "") ||
    modelDraft !== (data?.voice_model ?? DEFAULT_MODEL);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-caption font-semibold text-foreground">Configuração da voz</p>
          <p className="text-caption text-muted-foreground">
            Define qual voz e qual modelo a ElevenLabs usa nos áudios do assistente.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => voicesQuery.refetch()}
          disabled={voicesQuery.isFetching}
          aria-label="Recarregar lista de vozes"
        >
          <RefreshCw className={voicesQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
      </div>

      {isError && (
        <p className="text-caption text-destructive">
          Não foi possível ler a configuração atual{error?.message ? ` (${error.message})` : ""}.
          Salvar aqui vai sobrescrever o que estiver no banco.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="elevenlabs-voice-id">Voz do assistente</Label>
        <p className="text-caption text-muted-foreground">
          No plano free da ElevenLabs, vozes marcadas <strong>Plano pago</strong> falham ao gerar
          áudio — só as sem essa marcação funcionam via API. Com plano pago, todas funcionam.
        </p>

        {voicesQuery.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : listError ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-caption text-destructive">{listError}</p>
            <Input
              id="elevenlabs-voice-id"
              value={voiceIdDraft}
              onChange={(e) => setVoiceIdDraft(e.target.value)}
              placeholder="Ex.: EXAVITQu4vr4xnSDxMaL"
            />
            <p className="text-caption text-muted-foreground">
              Enquanto a lista não carrega, cole o ID da voz manualmente. Copie em{" "}
              <a
                href="https://try.elevenlabs.io/o2c8mt1d8jaa"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Voice Library da ElevenLabs
              </a>
              .
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {GENDER_FILTERS.map((f) => (
                <Button
                  key={f.value}
                  type="button"
                  size="sm"
                  variant={gender === f.value ? "default" : "outline"}
                  onClick={() => setGender(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Buscar voz por nome"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar voz pelo nome…"
                className="pl-8"
              />
            </div>

            <Select value={voiceIdDraft} onValueChange={setVoiceIdDraft}>
              <SelectTrigger id="elevenlabs-voice-id">
                <SelectValue placeholder="Escolha a voz" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {filtered.length === 0 ? (
                  <div className="px-2 py-3 text-caption text-muted-foreground">
                    Nenhuma voz encontrada com esse filtro.
                  </div>
                ) : (
                  filtered.map((v) => (
                    <SelectItem key={v.voice_id} value={v.voice_id}>
                      {/* UMA linha por voz. A segunda linha exibia o voice_id cru
                          (ex.: "Zxr2vdABom9UBVX8c10U") — dado técnico que não ajuda
                          ninguém a escolher voz, dobrava a altura de cada item e,
                          quando o scroll cortava o item de cima, deixava um ID órfão
                          sem nome no topo da lista. O SelectValue reaproveita este
                          mesmo markup, então o campo fechado herdava o defeito. */}
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">
                          {v.name}
                          <span className="ml-1.5 text-caption font-normal text-muted-foreground">
                            {v.gender === "feminina"
                              ? "feminina"
                              : v.gender === "masculina"
                                ? "masculina"
                                : "neutra"}
                            {v.language ? ` · ${v.language}` : ""}
                            {v.accent ? ` · ${v.accent}` : ""}
                          </span>
                        </span>
                        {v.category !== "premade" && (
                          <StatusBadge variant="warning" showDot={false}>
                            Plano pago
                          </StatusBadge>
                        )}
                      </span>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>

            {selectedVoice && (
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="selected-voice-details"
              >
                <Badge variant="secondary" className="max-w-full break-all">
                  ID: {selectedVoice.voice_id}
                </Badge>
                {selectedVoice.category && (
                  <Badge variant="outline">{selectedVoice.category}</Badge>
                )}
                {selectedVoice.category !== "premade" && (
                  <StatusBadge variant="warning" showDot={false}>
                    Plano pago
                  </StatusBadge>
                )}
                {selectedVoice.preview_url && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => togglePreview(selectedVoice)}
                  >
                    {playingId === selectedVoice.voice_id ? (
                      <>
                        <Pause className="mr-2 h-4 w-4" /> Parar prévia
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" /> Ouvir prévia
                      </>
                    )}
                  </Button>
                )}
              </div>
            )}

            <p className="text-caption text-muted-foreground">
              {voiceIdDraft.trim()
                ? dirty
                  ? "Voz selecionada. Salve as alterações para usá-la nos áudios."
                  : "Voz selecionada e salva."
                : "Sem voz escolhida, a IA continua respondendo em texto."}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="elevenlabs-voice-model">Modelo de geração do áudio</Label>
        <Select value={modelDraft} onValueChange={setModelDraft}>
          <SelectTrigger id="elevenlabs-voice-model">
            <SelectValue placeholder="Escolha o modelo" />
          </SelectTrigger>
          <SelectContent>
            {TTS_MODEL_OPTIONS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-caption text-muted-foreground">
          {TTS_MODEL_OPTIONS.find((m) => m.value === modelDraft)?.hint}
        </p>
      </div>

      <Button
        type="button"
        size="sm"
        className="self-start"
        disabled={!dirty || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Save className="mr-2 h-4 w-4" />
        )}
        {save.isPending ? "Salvando…" : "Salvar voz e modelo"}
      </Button>
    </div>
  );
}
