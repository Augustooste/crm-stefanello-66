import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { parseLeadFormFields } from "@/lib/lead-form-fields";
import type { LeadFormField, LeadFormFieldType } from "@/lib/lead-form-fields";

// ─── Tipos ────────────────────────────────────────────────────────────────
// Shape completo (LeadFormField/LeadFormFieldType/LEAD_FORM_FIELD_TYPES) e
// validação (parseLeadFormFields) vivem em src/lib/lead-form-fields.ts --
// única fonte de verdade, compartilhada com a página pública de submissão
// (src/routes/f.$formId.tsx). Reexportados aqui por compatibilidade com os
// call sites existentes deste hook.
export type { LeadFormField, LeadFormFieldType };
export { LEAD_FORM_FIELD_TYPES } from "@/lib/lead-form-fields";

export interface LeadFormRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  success_message: string | null;
  fields: LeadFormField[];
  created_at: string;
  updated_at: string;
}

const LEAD_FORMS_KEY = ["lead-forms"] as const;

interface RawLeadFormRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  success_message: string | null;
  fields: Json;
  created_at: string;
  updated_at: string;
}

async function fetchLeadForms(): Promise<LeadFormRow[]> {
  const { data, error } = await supabase
    .from("lead_forms")
    .select("id, tenant_id, name, slug, is_active, success_message, fields, created_at, updated_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const raw = row as unknown as RawLeadFormRow;
    return { ...raw, fields: parseLeadFormFields(raw.fields) };
  });
}

export function useLeadForms() {
  return useQuery({
    queryKey: LEAD_FORMS_KEY,
    queryFn: fetchLeadForms,
  });
}

function useInvalidateLeadForms() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: LEAD_FORMS_KEY });
}

// ─── Slug ────────────────────────────────────────────────────────────────

/**
 * Gera um slug URL-safe a partir de texto livre: remove acentos (NFD +
 * descarte de diacríticos, senão "Ação" vira slug quebrado), minúsculas,
 * espaços/símbolos viram "-". Pura, sem I/O -- unicidade de verdade é
 * garantida por `unique (tenant_id, slug)` no banco; uma colisão vira erro
 * do Postgres que a mutation de criar/editar repassa pro toast.
 */
/** Monta a URL pública de submissão -- a rota "/f/:formId" em si é implementada por outro agente. */
export function buildPublicFormUrl(formId: string): string {
  return `${window.location.origin}/f/${formId}`;
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Field builder (funções puras, sem I/O -- testáveis isoladas do dialog,
// sempre retornam array novo, nunca mutam o recebido). ──────────────────────

export function addLeadFormField(
  fields: readonly LeadFormField[],
  field: LeadFormField,
): LeadFormField[] {
  return [...fields, field];
}

export function removeLeadFormField(
  fields: readonly LeadFormField[],
  index: number,
): LeadFormField[] {
  return fields.filter((_, i) => i !== index);
}

export function moveLeadFormField(
  fields: readonly LeadFormField[],
  index: number,
  direction: -1 | 1,
): LeadFormField[] {
  const target = index + direction;
  if (index < 0 || index >= fields.length || target < 0 || target >= fields.length) {
    return [...fields];
  }
  const next = [...fields];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

export function updateLeadFormField(
  fields: readonly LeadFormField[],
  index: number,
  patch: Partial<LeadFormField>,
): LeadFormField[] {
  return fields.map((field, i) => (i === index ? { ...field, ...patch } : field));
}

// ─── Mutations (grants + policies liberam INSERT/UPDATE/DELETE direto para
// authenticated admin do próprio tenant -- ver "lead_forms admin write" em
// supabase/migrations/20260711100200_fase4_prb_lead_forms_schema.sql -- ao
// contrário de messaging_templates não existe (nem precisa existir) RPC
// própria, não há versionamento aqui). ──────────────────────────────────────

export interface LeadFormInput {
  name: string;
  slug: string;
  isActive: boolean;
  successMessage: string | null;
  fields: LeadFormField[];
}

export interface CreateLeadFormInput extends LeadFormInput {
  tenantId: string;
}

export function useCreateLeadForm() {
  const invalidate = useInvalidateLeadForms();
  return useMutation({
    mutationFn: async (input: CreateLeadFormInput) => {
      const { error } = await supabase.from("lead_forms").insert({
        tenant_id: input.tenantId,
        name: input.name,
        slug: input.slug,
        is_active: input.isActive,
        success_message: input.successMessage,
        fields: input.fields as unknown as Json,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export interface UpdateLeadFormInput extends LeadFormInput {
  id: string;
}

export function useUpdateLeadForm() {
  const invalidate = useInvalidateLeadForms();
  return useMutation({
    mutationFn: async (input: UpdateLeadFormInput) => {
      const { error } = await supabase
        .from("lead_forms")
        .update({
          name: input.name,
          slug: input.slug,
          is_active: input.isActive,
          success_message: input.successMessage,
          fields: input.fields as unknown as Json,
        })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useToggleLeadFormActive() {
  const invalidate = useInvalidateLeadForms();
  return useMutation({
    mutationFn: async (input: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from("lead_forms")
        .update({ is_active: input.isActive })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteLeadForm() {
  const invalidate = useInvalidateLeadForms();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("lead_forms").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

// ─── custom_field_definitions (entity='contact') p/ popular o seletor de
// mapeamento de cada campo do form -- mesma tabela que Fase 0 introduziu
// como eixo de genericização, aqui só lida em modo leitura. ─────────────────

export interface ContactCustomFieldDefinition {
  id: string;
  key: string;
  label: string;
}

export function useContactCustomFieldDefinitions() {
  return useQuery({
    queryKey: ["custom-field-definitions", "contact"],
    queryFn: async (): Promise<ContactCustomFieldDefinition[]> => {
      const { data, error } = await supabase
        .from("custom_field_definitions")
        .select("id, key, label")
        .eq("entity", "contact")
        .order("position", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}
