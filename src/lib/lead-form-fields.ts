// Fonte única do shape de `lead_forms.fields` (jsonb, sem CHECK no banco --
// validado só em aplicação, mesma filosofia "não trava" de
// custom_field_definitions.options -- ver
// supabase/migrations/20260711100200_fase4_prb_lead_forms_schema.sql).
// Consumido pela página pública de submissão (src/routes/f.$formId.tsx) E
// pelo hook de administração (src/hooks/use-lead-forms.ts) -- MESMA
// validação nos dois lugares; nunca duplicar nem recriar um cast cego.
export type LeadFormFieldType = "text" | "number" | "date" | "select" | "boolean";

export interface LeadFormField {
  key: string;
  label: string;
  type: LeadFormFieldType;
  required: boolean;
  maps_to_custom_field_id: string | null;
}

export const LEAD_FORM_FIELD_TYPES: readonly { value: LeadFormFieldType; label: string }[] = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "date", label: "Data" },
  { value: "select", label: "Seleção" },
  { value: "boolean", label: "Sim/Não" },
];

const VALID_FIELD_TYPES: ReadonlySet<string> = new Set(LEAD_FORM_FIELD_TYPES.map((t) => t.value));

function isValidLeadFormField(entry: unknown): entry is LeadFormField {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const obj = entry as Record<string, unknown>;
  return (
    typeof obj.key === "string" &&
    typeof obj.label === "string" &&
    typeof obj.type === "string" &&
    VALID_FIELD_TYPES.has(obj.type) &&
    typeof obj.required === "boolean" &&
    (obj.maps_to_custom_field_id === null || typeof obj.maps_to_custom_field_id === "string")
  );
}

/**
 * Filtra `lead_forms.fields` para as entradas com shape completo válido
 * (key/label string, type na união literal, required boolean,
 * maps_to_custom_field_id string|null). Entradas malformadas são
 * descartadas inteiras, nunca corrigidas parcialmente.
 */
export function parseLeadFormFields(raw: unknown): LeadFormField[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidLeadFormField);
}
