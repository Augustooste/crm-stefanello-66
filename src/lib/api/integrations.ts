import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";

export type IntegrationStatus = "disabled" | "pending" | "active" | "error";

export type TenantIntegrationRow = {
  slug: string;
  status: IntegrationStatus;
  config: Record<string, unknown> | null;
  connected_at: string | null;
  last_check_at: string | null;
  last_error: string | null;
  webhook_token: string | null;
};

// Vocabulário de conexão pós-migração 20260712100000_fase5_multicanal_schema.sql
// (não é mais active/inactive/disabled/error — Evolution precisa de
// connecting/waiting_qr pro fluxo de QR code).
export type ChannelStatus =
  "pending" | "connecting" | "connected" | "disconnected" | "error" | "waiting_qr" | "disabled";

export type WebhookHealth = "ok" | "broken" | "unknown" | "silent";

// public.channels — estado de conexão POR CANAL (distinto de tenant_integrations,
// que guarda credenciais/ativação por slug). Um catalog.slug pode ter uma linha em
// channels (provider_slug) além da linha em tenant_integrations.
export type ChannelRow = {
  id: string;
  provider_slug: string;
  status: ChannelStatus;
  config: Record<string, unknown> | null;
  webhook_token: string | null;
  qr_code: string | null;
  webhook_health: WebhookHealth | null;
  last_connected_at: string | null;
  status_message: string | null;
  /** Motivo consolidado do último estado ("codigo: detalhe"), para diagnóstico. */
  last_status_reason?: string | null;
};

export function useTenantIntegrations() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<TenantIntegrationRow[]>({
    queryKey: ["tenant-integrations", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_integrations")
        .select("slug, status, config, connected_at, last_check_at, last_error, webhook_token");
      if (error) throw error;
      return (data as TenantIntegrationRow[]) ?? [];
    },
  });
}

// channels.config/webhook_health/etc. ainda não estão em types.ts (agente de
// sincronização não rodou pra esta migração) — select() + cast, mesmo padrão de
// useIntegrationsCatalog (linha 97 de IntegrationCard.tsx) pra colunas fora do
// tipo gerado.
//
// webhook_token não entra mais no select() direto: a migração
// 20260712110000_fase5_evolution_onboarding.sql revogou o SELECT dessa
// coluna pra `authenticated` (grant coluna-a-coluna sem webhook_token) e
// criou a RPC admin-only get_channel_webhook_tokens() como único jeito
// client-side de ler o valor de volta. Buscamos as duas coisas em paralelo
// e fazemos o merge aqui.
//
// A RPC também não está em types.ts (mesmo motivo do select() acima) --
// mesmo padrão de extensão local de Functions já usado em
// use-phone-suppressions.ts (add_manual_phone_suppression/
// reactivate_phone_suppression), em vez de `as never`/`any` no .rpc().
type ChannelWithoutSecrets = Omit<ChannelRow, "webhook_token" | "qr_code">;
type ChannelWebhookTokenRow = { channel_id: string; webhook_token: string | null };
type ChannelQrCodeRow = { channel_id: string; qr_code: string | null; expires_at: string };

type ChannelFunctions = {
  get_channel_webhook_tokens: {
    Args: Record<string, never>;
    Returns: ChannelWebhookTokenRow[];
  };
  get_channel_qr_codes: {
    Args: Record<string, never>;
    Returns: ChannelQrCodeRow[];
  };
};

type SupabaseWithChannelRpcs = SupabaseClient<
  Database & {
    public: Database["public"] & {
      Functions: Database["public"]["Functions"] & ChannelFunctions;
    };
  }
>;

const channelRpcClient = supabase as unknown as SupabaseWithChannelRpcs;

export function useTenantChannels() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<ChannelRow[]>({
    queryKey: ["tenant-channels", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const [
        { data, error },
        { data: tokens, error: tokenError },
        { data: qrCodes, error: qrCodeError },
      ] = await Promise.all([
        supabase
          .from("channels")
          .select(
            "id, provider_slug, status, config, webhook_health, last_connected_at, status_message, last_status_reason",
          ),
        channelRpcClient.rpc("get_channel_webhook_tokens"),
        channelRpcClient.rpc("get_channel_qr_codes"),
      ]);
      if (error) throw error;
      if (tokenError) throw tokenError;
      if (qrCodeError) throw qrCodeError;

      const tokenByChannel = new Map((tokens ?? []).map((t) => [t.channel_id, t.webhook_token]));
      const qrCodeByChannel = new Map(
        (qrCodes ?? []).map((item) => [item.channel_id, item.qr_code]),
      );
      return ((data ?? []) as unknown as ChannelWithoutSecrets[]).map((row) => ({
        ...row,
        webhook_token: tokenByChannel.get(row.id) ?? null,
        qr_code: qrCodeByChannel.get(row.id) ?? null,
      }));
    },
  });
}

export type ApifyEnrichmentRunRow = {
  id: string;
  actor_id: string;
  status: string;
  cost_usd: number;
  created_at: string;
  contact: { name: string } | null;
};

// Dashboard de custos (Configurações > Integrações e Plugins). Busca só o
// mês corrente -- trigger é manual por contato (teto de custo por design em
// lead-enrich), então o volume é sempre pequeno; sem paginação por ora
// (.limit é só um teto de segurança, não paginação real).
export function useApifyEnrichmentRuns() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<ApifyEnrichmentRunRow[]>({
    queryKey: ["apify-enrichment-runs", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from("apify_enrichment_runs")
        .select("id, actor_id, status, cost_usd, created_at, contact:contacts(name)")
        .gte("created_at", startOfMonth.toISOString())
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as ApifyEnrichmentRunRow[];
    },
  });
}

/** Retorna o status da integração para uso em outras telas (ex.: inbox). */
export function useIntegration(slug: string) {
  const q = useTenantIntegrations();
  // Guarda de shape: `.find` direto num data não-array lança DURANTE O RENDER e
  // derruba a árvore inteira (tela branca), não só este card. Já aconteceu com
  // outros componentes deste app; aqui custa uma linha evitar.
  const row = (Array.isArray(q.data) ? q.data : []).find((r) => r.slug === slug) ?? null;
  return {
    isLoading: q.isLoading,
    status: (row?.status ?? "disabled") as IntegrationStatus,
    isActive: row?.status === "active",
    config: row?.config ?? null,
  };
}
