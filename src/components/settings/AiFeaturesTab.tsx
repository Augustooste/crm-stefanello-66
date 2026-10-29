import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, Save } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

// 'tenant_admin' = admin do tenant liga/desliga na UI; 'operator' = só
// service_role (operador Acelera IA) grava — a RLS de tenant_ai_features já
// bloqueia UPDATE/INSERT de authenticated para essas linhas, mas a UI nunca
// deve sugerir que dá para editar (ver PRD risco #4: não repetir o
// anti-padrão de "esconder atrás de UI" quando o back já nega).
type ToggleAuthority = "tenant_admin" | "operator";

type FeatureCatalogRow = {
  feature_key: string;
  label: string;
  description: string | null;
  default_enabled: boolean;
  toggle_authority: string;
  tenant_ai_features: { enabled: boolean }[] | null;
};

type AiFeature = {
  featureKey: string;
  label: string;
  description: string | null;
  toggleAuthority: ToggleAuthority | null;
  enabled: boolean;
};

function toToggleAuthority(value: string): ToggleAuthority | null {
  return value === "tenant_admin" || value === "operator" ? value : null;
}

function mapRow(row: FeatureCatalogRow): AiFeature {
  const tenantRow = row.tenant_ai_features?.[0];
  return {
    featureKey: row.feature_key,
    label: row.label,
    description: row.description,
    toggleAuthority: toToggleAuthority(row.toggle_authority),
    enabled: tenantRow?.enabled ?? row.default_enabled,
  };
}

/**
 * Catálogo de feature-flags de IA (Fase 3 — PRD "Feature-flag catalog").
 * Lista ai_feature_catalog com o estado do tenant atual (tenant_ai_features).
 * Só toggle_authority='tenant_admin' recebe um switch interativo; 'operator'
 * mostra o estado como texto — nunca um controle editável, mesmo desabilitado
 * (a RLS já bloqueia a escrita, mas a UI não deve nem sugerir que é possível).
 *
 * TODO(prompt_override): fora de escopo desta rodada — exibir/editar o
 * override de prompt por feature fica para uma tarefa futura.
 */
export function AiFeaturesTab() {
  return (
    <div className="flex flex-col gap-6">
      <AiPersonaSettingsCard />
      <AiFeatureCatalogCard />
    </div>
  );
}

interface PersonaSettingsRow {
  ai_name: string | null;
  ai_avatar_emoji: string | null;
}

/** Card "Persona da IA" — nome/emoji configuráveis (épico D). */
function AiPersonaSettingsCard() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  const qc = useQueryClient();
  const [aiName, setAiName] = useState("");
  const [aiAvatarEmoji, setAiAvatarEmoji] = useState("");
  const [dirty, setDirty] = useState(false);

  const personaQ = useQuery({
    queryKey: ["ai-persona-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<PersonaSettingsRow | null> => {
      const { data, error } = await supabase
        .from("ai_settings")
        .select("ai_name, ai_avatar_emoji")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (personaQ.data && !dirty) {
      setAiName(personaQ.data.ai_name ?? "");
      setAiAvatarEmoji(personaQ.data.ai_avatar_emoji ?? "");
    }
  }, [personaQ.data, dirty]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase.from("ai_settings").upsert(
        {
          tenant_id: tenantId,
          ai_name: aiName.trim() || null,
          ai_avatar_emoji: aiAvatarEmoji.trim() || null,
        },
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["ai-persona-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["ai-persona"] });
      toast.success("Persona da IA salva.");
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Falha ao salvar persona")),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Sparkles className="h-4 w-4" aria-hidden />
          Persona da IA
        </CardTitle>
        <CardDescription>
          Nome e avatar exibidos no inbox, assistente e insights. Sem configuração, usamos um nome
          padrão calculado a partir do nome do seu negócio.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {personaQ.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="ai-persona-name">Nome da IA</Label>
                <Input
                  id="ai-persona-name"
                  value={aiName}
                  onChange={(e) => {
                    setAiName(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Assistente Virtual"
                  maxLength={60}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-persona-emoji">Avatar (emoji)</Label>
                <Input
                  id="ai-persona-emoji"
                  value={aiAvatarEmoji}
                  onChange={(e) => {
                    setAiAvatarEmoji(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="🤖"
                  maxLength={4}
                  className="w-20 text-center"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => saveMut.mutate()} disabled={!dirty || saveMut.isPending}>
                <Save className="mr-2 h-4 w-4" />
                {saveMut.isPending ? "Salvando..." : "Salvar persona"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AiFeatureCatalogCard() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  const qc = useQueryClient();

  const featuresQ = useQuery({
    queryKey: ["ai-feature-catalog", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<AiFeature[]> => {
      const { data, error } = await supabase
        .from("ai_feature_catalog")
        .select(
          "feature_key, label, description, default_enabled, toggle_authority, tenant_ai_features(enabled)",
        )
        .order("feature_key");
      if (error) throw error;
      return ((data ?? []) as FeatureCatalogRow[]).map(mapRow);
    },
  });

  const toggleMut = useMutation({
    mutationFn: async ({ featureKey, enabled }: { featureKey: string; enabled: boolean }) => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase.from("tenant_ai_features").upsert(
        {
          tenant_id: tenantId,
          feature_key: featureKey,
          enabled,
          updated_by: profile?.id ?? null,
        },
        { onConflict: "tenant_id,feature_key" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai-feature-catalog", tenantId] });
      toast.success("Feature de IA atualizada");
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao atualizar feature")),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Sparkles className="h-4 w-4" aria-hidden />
          Features de IA
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {featuresQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (featuresQ.data ?? []).length === 0 ? (
          <EmptyState
            title="Sem features de IA"
            description="Nenhuma feature de IA disponível no catálogo ainda."
          />
        ) : (
          <ul className="divide-y divide-border">
            {featuresQ.data!.map((feature) => (
              <li key={feature.featureKey} className="flex items-center justify-between gap-4 py-3">
                <div className="space-y-0.5">
                  <Label htmlFor={`ai-feature-${feature.featureKey}`}>{feature.label}</Label>
                  {feature.description && (
                    <p className="text-caption text-muted-foreground">{feature.description}</p>
                  )}
                </div>
                {feature.toggleAuthority === "tenant_admin" ? (
                  <Switch
                    id={`ai-feature-${feature.featureKey}`}
                    checked={feature.enabled}
                    disabled={toggleMut.isPending}
                    onCheckedChange={(checked) =>
                      toggleMut.mutate({ featureKey: feature.featureKey, enabled: checked })
                    }
                  />
                ) : (
                  <span className="text-caption text-muted-foreground">
                    {feature.enabled ? "Ligada" : "Desligada"} · Gerenciada pela Acelera IA
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
