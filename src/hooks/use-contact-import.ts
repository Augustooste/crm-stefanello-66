import { useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";
import { detectCsvDelimiter, parseCsv, type CsvDelimiter } from "@/lib/csv";
import {
  buildContactHeaderMapping,
  decideContactRowActions,
  normalizePhoneKey,
  parseContactRows,
  type ContactHeaderMapping,
  type ContactImportMode,
  type ContactImportReport,
  type ContactImportRowError,
} from "@/lib/contact-import";

/** Tamanho de lote para insert/upsert em contacts — dentro da faixa 200-500
 * pedida (nem 1 request por linha, nem um payload gigante numa call só). */
const BATCH_SIZE = 300;
/** Página de leitura de contatos existentes (dedup por telefone) — mesmo
 * padrão de chunking do export (`.range()` até `chunk.length < PAGE_SIZE`). */
const EXISTING_CONTACTS_PAGE_SIZE = 1000;

export interface ContactImportPreview {
  delimiter: CsvDelimiter;
  headers: string[];
  mapping: ContactHeaderMapping;
  ignoredHeaders: string[];
  stageHeaderDetected: boolean;
  rows: string[][];
  totalRows: number;
}

/** Faz o parse do arquivo (client-side, sem chamar o Supabase) para a etapa
 * de preview do wizard de import — mostra mapeamento de colunas antes de
 * gravar qualquer coisa. */
export async function parseContactImportFile(file: File): Promise<ContactImportPreview> {
  const text = await file.text();
  const delimiter = detectCsvDelimiter(text);
  const { headers, rows } = parseCsv(text, delimiter);
  const { mapping, ignoredHeaders, stageHeaderDetected } = buildContactHeaderMapping(headers);
  return {
    delimiter,
    headers,
    mapping,
    ignoredHeaders,
    stageHeaderDetected,
    rows,
    totalRows: rows.length,
  };
}

interface ExistingContactIndex {
  /** telefone normalizado -> ids de contatos com aquele telefone (dedup). */
  idsByPhoneKey: Map<string, string[]>;
  /** id -> nome atual — usado para preencher `name` (NOT NULL) num update
   * quando o CSV não mapeou coluna de nome, sem sobrescrever o nome real. */
  nameById: Map<string, string>;
}

async function loadExistingContactIndex(): Promise<ExistingContactIndex> {
  const idsByPhoneKey = new Map<string, string[]>();
  const nameById = new Map<string, string>();
  let page = 0;

  while (true) {
    const from = page * EXISTING_CONTACTS_PAGE_SIZE;
    const to = from + EXISTING_CONTACTS_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("contacts")
      .select("id, phone, name")
      .is("deleted_at", null)
      .not("phone", "is", null)
      .range(from, to);
    if (error) throw error;
    const chunk = data ?? [];
    for (const c of chunk) {
      nameById.set(c.id, c.name);
      const key = normalizePhoneKey(c.phone);
      if (!key) continue;
      const ids = idsByPhoneKey.get(key) ?? [];
      ids.push(c.id);
      idsByPhoneKey.set(key, ids);
    }
    if (chunk.length < EXISTING_CONTACTS_PAGE_SIZE) break;
    page += 1;
  }
  return { idsByPhoneKey, nameById };
}

interface RunImportArgs {
  preview: ContactImportPreview;
  mode: ContactImportMode;
}

/**
 * Hook de import de contatos via CSV. Duas etapas:
 * 1. `parseContactImportFile` (função pura de módulo, sem hook) — preview.
 * 2. `runImport` (mutation) — grava de fato, em lotes, respeitando o modo.
 *
 * Importante: o payload de create/update só inclui as colunas que o CSV
 * mapeou (`preview.mapping`). Uma coluna ausente no CSV nunca sobrescreve o
 * valor existente no banco (ex.: reimportar um CSV sem coluna "tags" não
 * apaga as tags já cadastradas) — apenas colunas presentes no CSV, mesmo que
 * a célula da linha esteja vazia, sobrescrevem (isso é uma decisão consciente,
 * documentada no relatório da tarefa).
 */
export function useContactImport() {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ preview, mode }: RunImportArgs): Promise<ContactImportReport> => {
      const tenantId = profile?.tenant_id;
      if (!tenantId) throw new Error("Perfil do usuário não carregado.");

      const { parsed, errors: parseErrors } = parseContactRows(preview.mapping, preview.rows);
      const errors: ContactImportRowError[] = [...parseErrors];

      const { idsByPhoneKey, nameById } = await loadExistingContactIndex();

      const hasName = preview.mapping.name !== undefined;
      const hasPhone = preview.mapping.phone !== undefined;
      const hasEmail = preview.mapping.email !== undefined;
      const hasTags = preview.mapping.tags !== undefined;
      const hasNotes = preview.mapping.notes !== undefined;

      let ignorados = 0;
      // Ambos os buckets usam TablesInsert (não TablesUpdate): o cliente
      // Supabase tipa `.upsert()` pelo shape de Insert mesmo quando o efeito
      // é um update, então `name` (NOT NULL) precisa estar sempre presente —
      // no update, cai para o nome já existente quando o CSV não mapeou nome.
      const creates: Array<{ rowNumber: number; payload: TablesInsert<"contacts"> }> = [];
      const updates: Array<{ rowNumber: number; payload: TablesInsert<"contacts"> }> = [];

      const actions = decideContactRowActions(mode, parsed, idsByPhoneKey);

      for (let rowIdx = 0; rowIdx < parsed.length; rowIdx++) {
        const row = parsed[rowIdx];
        const action = actions[rowIdx];

        if (action.type === "skip") {
          ignorados += 1;
          continue;
        }

        if (action.type === "create") {
          const payload: TablesInsert<"contacts"> = {
            tenant_id: tenantId,
            // name é NOT NULL em contacts; sem coluna nome mapeada, cai para o
            // telefone como último recurso (nunca inventa um valor arbitrário).
            name: (hasName ? row.name : null) || row.phone || "",
            updated_at: new Date().toISOString(),
          };
          if (hasPhone) payload.phone = row.phone;
          if (hasEmail) payload.email = row.email;
          if (hasTags) payload.tags = row.tags;
          if (hasNotes) payload.notes = row.notes;
          creates.push({ rowNumber: row.rowNumber, payload });
          continue;
        }

        // update
        const existingName = nameById.get(action.contactId) ?? "";
        const payload: TablesInsert<"contacts"> = {
          id: action.contactId,
          tenant_id: tenantId,
          name: (hasName && row.name) || existingName,
          updated_at: new Date().toISOString(),
        };
        if (hasPhone) payload.phone = row.phone;
        if (hasEmail) payload.email = row.email;
        if (hasTags) payload.tags = row.tags;
        if (hasNotes) payload.notes = row.notes;
        updates.push({ rowNumber: row.rowNumber, payload });
      }

      let criados = 0;
      let atualizados = 0;

      for (let i = 0; i < creates.length; i += BATCH_SIZE) {
        const chunk = creates.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from("contacts").insert(chunk.map((c) => c.payload));
        if (error) {
          for (const c of chunk) errors.push({ linha: c.rowNumber, motivo: error.message });
        } else {
          criados += chunk.length;
        }
      }

      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const chunk = updates.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from("contacts").upsert(chunk.map((u) => u.payload));
        if (error) {
          for (const u of chunk) errors.push({ linha: u.rowNumber, motivo: error.message });
        } else {
          atualizados += chunk.length;
        }
      }

      return { criados, atualizados, ignorados, erros: errors };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  return {
    runImport: mutation.mutateAsync,
    isImporting: mutation.isPending,
  };
}
