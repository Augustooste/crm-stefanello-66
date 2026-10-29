import { formatBRL, formatDate } from "@/lib/format";
import type { CustomFieldDefinition } from "@/lib/custom-fields";

/**
 * Formatação de valores de `custom_fields` (jsonb) para exibição em
 * tabela/lista — camada de apresentação separada de `custom-fields.ts`
 * (que é intencionalmente "puro, sem deps" para validação client+edge).
 * Aqui pode depender de `lib/format` (datas/moeda em pt-BR) à vontade.
 */

// Subconjunto de CustomFieldDefinition via Pick (não redeclarado à mão) —
// fica em sincronia automática se o tipo de origem ganhar/perder campos.
export type CustomFieldColumn = Pick<
  CustomFieldDefinition,
  "key" | "label" | "fieldType" | "options"
>;

const PLACEHOLDER = "—";

/**
 * Formata um valor já validado (ver `validateCustomFieldValue`) de acordo
 * com o `fieldType` da definição — não repete o type-narrowing de lá, só
 * decide como o valor aparece pro usuário.
 */
export function formatCustomFieldValue(column: CustomFieldColumn, value: unknown): string {
  if (value === undefined || value === null || value === "") return PLACEHOLDER;
  // multiselect vazio ("nenhuma opção marcada") é vazio pra fins de exibição,
  // mesmo critério de `validateCustomFieldValue` em custom-fields.ts.
  if (Array.isArray(value) && value.length === 0) return PLACEHOLDER;

  switch (column.fieldType) {
    case "boolean":
      return value ? "Sim" : "Não";
    case "currency":
      return typeof value === "number" ? formatBRL(value) : String(value);
    case "date":
      return typeof value === "string" || value instanceof Date ? formatDate(value) : String(value);
    case "select": {
      if (typeof value !== "string") return String(value);
      return column.options.find((o) => o.value === value)?.label ?? value;
    }
    case "multiselect": {
      if (!Array.isArray(value)) return String(value);
      return value
        .map((v) => column.options.find((o) => o.value === v)?.label ?? String(v))
        .join(", ");
    }
    case "text":
    case "number":
      return String(value);
    default: {
      // Exhaustiveness guard — novo field_type adicionado sem atualizar aqui.
      const _never: never = column.fieldType;
      return String(_never);
    }
  }
}
