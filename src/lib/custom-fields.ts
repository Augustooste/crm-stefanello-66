// Módulo puro (sem deps) de validação de custom_fields — o "eixo de
// genericização" da Fase 0. Compartilhado entre client e futuras camadas
// (ver PRD §Fase 0: "API estável para ler/validar custom_fields por
// definição, para não reimplementar validação em cada feature").
//
// Não faz I/O nem depende de Supabase — só recebe a definição (linha de
// custom_field_definitions) e o valor candidato, e diz se é válido.

export type CustomFieldEntity = "contact" | "deal";

export type CustomFieldType =
  "text" | "number" | "currency" | "date" | "boolean" | "select" | "multiselect";

export interface CustomFieldOption {
  value: string;
  label: string;
}

export interface CustomFieldDefinition {
  id: string;
  tenantId: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: CustomFieldOption[];
  required: boolean;
  position: number;
}

export type CustomFieldValidationResult = { valid: true } | { valid: false; error: string };

const ok: CustomFieldValidationResult = { valid: true };

function fail(error: string): CustomFieldValidationResult {
  return { valid: false, error };
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function validateOptionValues(
  definition: CustomFieldDefinition,
  values: readonly string[],
): CustomFieldValidationResult {
  const allowed = new Set(definition.options.map((option) => option.value));
  const invalid = values.find((value) => !allowed.has(value));
  if (invalid !== undefined) {
    return fail(`Valor "${invalid}" não está entre as opções de "${definition.label}"`);
  }
  return ok;
}

function validateByType(
  definition: CustomFieldDefinition,
  value: unknown,
): CustomFieldValidationResult {
  switch (definition.fieldType) {
    case "text": {
      if (typeof value !== "string") return fail(`"${definition.label}" deve ser texto`);
      return ok;
    }
    case "number":
    case "currency": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return fail(`"${definition.label}" deve ser numérico`);
      }
      return ok;
    }
    case "boolean": {
      if (typeof value !== "boolean")
        return fail(`"${definition.label}" deve ser verdadeiro/falso`);
      return ok;
    }
    case "date": {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        return fail(`"${definition.label}" deve ser uma data válida`);
      }
      return ok;
    }
    case "select": {
      if (typeof value !== "string") return fail(`"${definition.label}" deve ser uma opção única`);
      return validateOptionValues(definition, [value]);
    }
    case "multiselect": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return fail(`"${definition.label}" deve ser uma lista de opções`);
      }
      return validateOptionValues(definition, value as string[]);
    }
    default: {
      // Exhaustiveness guard — novo field_type adicionado sem atualizar aqui.
      const _never: never = definition.fieldType;
      return fail(`Tipo de campo desconhecido: ${String(_never)}`);
    }
  }
}

/**
 * Valida um valor candidato contra sua definição de custom field.
 * Regras: required, tipo primitivo esperado, e pertencimento a `options`
 * para select/multiselect. Não faz coerção — o valor já deve chegar tipado
 * (ex.: number para "number", não a string "10").
 */
export function validateCustomFieldValue(
  definition: CustomFieldDefinition,
  value: unknown,
): CustomFieldValidationResult {
  if (isEmpty(value)) {
    if (definition.required) {
      return fail(`"${definition.label}" é obrigatório`);
    }
    return ok;
  }

  if (definition.fieldType === "multiselect" && Array.isArray(value) && value.length === 0) {
    return definition.required ? fail(`"${definition.label}" é obrigatório`) : ok;
  }

  return validateByType(definition, value);
}
