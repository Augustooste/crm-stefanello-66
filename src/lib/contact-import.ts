// Lógica pura (sem I/O, sem Supabase) do import CSV de contatos.
// PRD: docs/PRD-CRM-IA-MULTINICHO.md, seção "Fase 1", subseções "User stories
// (Import/Export CSV)" e "Critérios de aceite (Import CSV)".
//
// Mantido separado do hook (src/hooks/use-contact-import.ts) para poder ser
// testado sem mockar Supabase — só recebe headers/linhas já parseadas pelo
// `parseCsv` (src/lib/csv.ts) e devolve decisões puras.

export type ContactImportMode = "criar_apenas" | "upsert_por_telefone" | "pular_duplicados";

/** Campos "core" de contacts que o import sabe mapear. `stage` é reconhecido
 * como sinônimo (PRD lista nome/telefone/email/tags/notas/stage) mas HOJE
 * `contacts` não tem coluna `stage` (stage vive em `deals`/`board_stages") e
 * mapear para `custom_fields` está fora do escopo desta tarefa (depende de
 * `custom_field_definitions`, Fase 0). Por isso `stage` aparece no mapeamento
 * apenas para ser reportado ao usuário ("reconhecida, sem coluna de destino
 * nesta fase") — nunca escrevemos o valor em lugar nenhum.
 */
export type ContactCoreField = "name" | "phone" | "email" | "tags" | "notes" | "stage";

export type ContactHeaderMapping = Partial<Record<ContactCoreField, number>>;

export interface ContactHeaderMappingResult {
  mapping: ContactHeaderMapping;
  /** Headers originais do CSV que não bateram com nenhum sinônimo conhecido. */
  ignoredHeaders: string[];
  /** true quando uma coluna stage/etapa/estágio foi detectada (ver nota acima). */
  stageHeaderDetected: boolean;
}

const HEADER_SYNONYMS: Record<ContactCoreField, string[]> = {
  name: ["nome", "name", "nome completo", "full name"],
  phone: ["telefone", "phone", "celular", "whatsapp", "fone"],
  email: ["email", "e-mail", "e-mail address", "mail"],
  tags: ["tags", "etiquetas", "tag", "etiqueta"],
  notes: ["notas", "notes", "nota", "observacoes", "observações", "obs"],
  stage: ["stage", "etapa", "estagio", "estágio", "pipeline stage"],
};

/** Remove acentos, baixa caixa e trima — usado para casar headers com sinônimos. */
function normalizeHeaderKey(value: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Mapeia os headers de um CSV para os campos core de contacts, via sinônimos
 * PT-BR/EN. Headers sem sinônimo reconhecido voltam em `ignoredHeaders` —
 * nunca viram campo inventado.
 */
export function buildContactHeaderMapping(headers: readonly string[]): ContactHeaderMappingResult {
  const normalizedHeaders = headers.map((h, i) => ({
    index: i,
    key: normalizeHeaderKey(h),
    original: h,
  }));

  const findIndex = (synonyms: readonly string[]): number | undefined => {
    for (const syn of synonyms) {
      const key = normalizeHeaderKey(syn);
      const found = normalizedHeaders.find((h) => h.key === key);
      if (found) return found.index;
    }
    return undefined;
  };

  const mapping: ContactHeaderMapping = {};
  const mappedIndexes = new Set<number>();
  (Object.keys(HEADER_SYNONYMS) as ContactCoreField[]).forEach((field) => {
    const idx = findIndex(HEADER_SYNONYMS[field]);
    if (idx !== undefined) {
      mapping[field] = idx;
      mappedIndexes.add(idx);
    }
  });

  const ignoredHeaders = normalizedHeaders
    .filter((h) => !mappedIndexes.has(h.index))
    .map((h) => h.original);

  return { mapping, ignoredHeaders, stageHeaderDetected: mapping.stage !== undefined };
}

export interface ParsedContactRow {
  /** Número da linha no arquivo original (1 = header, 2 = primeira linha de dados). */
  rowNumber: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  notes: string | null;
}

export interface ContactImportRowError {
  linha: number;
  motivo: string;
}

function getCell(row: readonly string[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const raw = (row[index] ?? "").trim();
  return raw ? raw : null;
}

function parseTagsCell(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Faz o parse das linhas de dados (já tokenizadas pelo `parseCsv`) em
 * `ParsedContactRow`. Linha sem nome E sem telefone vira erro reportado —
 * não interrompe o restante do import.
 */
export function parseContactRows(
  mapping: ContactHeaderMapping,
  rows: readonly (readonly string[])[],
): { parsed: ParsedContactRow[]; errors: ContactImportRowError[] } {
  const parsed: ParsedContactRow[] = [];
  const errors: ContactImportRowError[] = [];

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // +1 header, +1 1-indexado
    const name = getCell(row, mapping.name);
    const phone = getCell(row, mapping.phone);
    const email = getCell(row, mapping.email);
    const notes = getCell(row, mapping.notes);
    const tags = parseTagsCell(getCell(row, mapping.tags));

    if (!name && !phone) {
      errors.push({
        linha: rowNumber,
        motivo: "Linha sem nome e sem telefone (não é possível criar contato).",
      });
      return;
    }

    parsed.push({ rowNumber, name, phone, email, tags, notes });
  });

  return { parsed, errors };
}

/** Normaliza telefone para chave de deduplicação (somente dígitos). Não é
 * E.164 completo — heurística suficiente para casar "(11) 99999-8888" com
 * "11999998888" vindos de fontes diferentes. O valor armazenado no banco
 * continua sendo o texto original da linha, não este normalizado. */
export function normalizePhoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits ? digits : null;
}

export type ContactRowAction =
  { type: "create" } | { type: "update"; contactId: string } | { type: "skip"; motivo: string };

/**
 * Decide o que fazer com uma linha já parseada, dado o modo de import e o
 * índice de contatos existentes por telefone normalizado (tenant atual).
 * Dedup é sempre por telefone (nome do modo é explícito: "upsert_por_telefone")
 * — linhas sem telefone não têm chave de deduplicação e sempre criam.
 */
export function decideContactRowAction(
  mode: ContactImportMode,
  row: Pick<ParsedContactRow, "phone">,
  existingIdsByPhoneKey: ReadonlyMap<string, readonly string[]>,
): ContactRowAction {
  if (mode === "criar_apenas") return { type: "create" };

  const key = normalizePhoneKey(row.phone);
  if (!key) return { type: "create" };

  const existingIds = existingIdsByPhoneKey.get(key) ?? [];
  if (existingIds.length === 0) return { type: "create" };

  if (mode === "pular_duplicados") {
    return { type: "skip", motivo: "Telefone já existe na base." };
  }

  // upsert_por_telefone
  if (existingIds.length > 1) {
    return {
      type: "skip",
      motivo: `Telefone duplicado na base (${existingIds.length} registros) — ambíguo para upsert.`,
    };
  }
  return { type: "update", contactId: existingIds[0] };
}

/**
 * Decide a ação de TODAS as linhas de uma vez, rastreando telefones que já
 * viraram "create" dentro desta mesma rodada — sem isso, `decideContactRowAction`
 * sozinha não "aprende" as linhas já decididas no laço (o índice de
 * `existingIdsByPhoneKey` só reflete o que já existia no banco ANTES do
 * import), e duas linhas com o mesmo telefone novo no mesmo CSV criavam dois
 * contatos duplicados mesmo em `pular_duplicados`/`upsert_por_telefone` —
 * exatamente os dois modos cujo propósito é evitar isso.
 *
 * `criar_apenas` fica de fora deste guard de propósito: o modo já significa
 * "sempre cria, sem checar duplicata nenhuma" (nem contra o banco, nem dentro
 * do arquivo) — mudar isso mudaria a semântica do modo, não corrigiria um bug.
 */
export function decideContactRowActions(
  mode: ContactImportMode,
  rows: readonly Pick<ParsedContactRow, "phone">[],
  existingIdsByPhoneKey: ReadonlyMap<string, readonly string[]>,
): ContactRowAction[] {
  const seenInFile = new Set<string>();
  return rows.map((row) => {
    const key = mode === "criar_apenas" ? null : normalizePhoneKey(row.phone);

    if (key && seenInFile.has(key)) {
      return { type: "skip", motivo: "Telefone duplicado dentro do próprio arquivo importado." };
    }

    const action = decideContactRowAction(mode, row, existingIdsByPhoneKey);
    if (key && action.type === "create") seenInFile.add(key);
    return action;
  });
}

export interface ContactImportReport {
  criados: number;
  atualizados: number;
  ignorados: number;
  erros: ContactImportRowError[];
}
