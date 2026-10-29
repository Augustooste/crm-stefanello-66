import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

// ─── Tipos ────────────────────────────────────────────────────────────────

export type TemplateStatus = "pending" | "approved" | "rejected";

// freeform = corpo livre definido pelo tenant; provider_approved = template
// pré-aprovado pelo provedor de mensageria (ex.: template WhatsApp Business
// aprovado pela Meta), usa provider_template_name.
export type TemplateKind = "freeform" | "provider_approved";

export interface MessagingTemplateRow {
  id: string;
  tenant_id: string;
  channel_id: string | null;
  name: string;
  language: string;
  body: string;
  variables: string[];
  tags: string[];
  version: number;
  parent_id: string | null;
  is_draft: boolean;
  status: TemplateStatus;
  kind: TemplateKind;
  provider_template_name: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const TEMPLATES_KEY = ["messaging-templates"] as const;

// A tabela é gerenciada só por admin (RLS: "messaging_templates admin all"
// exige is_admin() para insert/update/delete; select libera is_draft=false
// para todo mundo, mas esta página inteira roda atrás de requireAdmin no
// beforeLoad da rota) -- então o select aqui sempre traz rascunho e
// aprovado juntos, e o componente separa por is_draft no client.
async function fetchMessagingTemplates(): Promise<MessagingTemplateRow[]> {
  const { data, error } = await supabase
    .from("messaging_templates")
    .select(
      "id, tenant_id, channel_id, name, language, body, variables, tags, version, parent_id, is_draft, status, kind, provider_template_name, created_by, approved_by, approved_at, created_at, updated_at",
    )
    .order("name", { ascending: true })
    .order("language", { ascending: true })
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as MessagingTemplateRow[];
}

export function useMessagingTemplates() {
  return useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: fetchMessagingTemplates,
  });
}

function useInvalidateTemplates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
}

// ─── Mutations (RPC-only) ───────────────────────────────────────────────────
//
// create_template_draft/approve_template_version (supabase/migrations/
// 20260710120000_fase3_hitl_decision_queue_schema.sql) já fazem o guard de
// admin + versionamento dentro da própria função; nunca fazer INSERT/UPDATE
// direto em messaging_templates a partir do client.

export interface CreateTemplateDraftInput {
  name: string;
  language: string;
  body: string;
  variables: string[];
  tags: string[];
  parentId?: string | null;
  kind: TemplateKind;
  providerTemplateName?: string | null;
}

export function useCreateTemplateDraft() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: async (input: CreateTemplateDraftInput) => {
      const { data, error } = await supabase.rpc("create_template_draft", {
        p_parent_id: (input.parentId ?? null) as unknown as string,
        p_name: input.name,
        p_body: input.body,
        p_variables: input.variables,
        p_tags: input.tags,
        p_language: input.language,
        p_kind: input.kind,
        p_provider_template_name:
          input.kind === "provider_approved"
            ? (input.providerTemplateName ?? undefined)
            : undefined,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useApproveTemplateVersion() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: async (templateId: string) => {
      const { data, error } = await supabase.rpc("approve_template_version", {
        p_template_id: templateId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}
