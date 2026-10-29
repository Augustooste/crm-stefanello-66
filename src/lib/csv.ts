/**
 * Utilitários mínimos de CSV (zero dependência externa).
 *
 * Objetivos:
 * - Funciona em browser + server (sem APIs exclusivas de Node)
 * - Suporta delimitadores vírgula/ponto-e-vírgula/tab
 * - Suporta campos entre aspas com aspas escapadas ("")
 * - Tolerante a CRLF/LF e newline final
 *
 * NOTA: Intencionalmente pequeno; para CSVs muito grandes considere um parser em streaming.
 *
 * Porte de clientes/pedro/medflow-v0/lib/utils/csv.ts (somente leitura, não modificar a origem).
 */
export type CsvDelimiter = "," | ";" | "\t";

/**
 * Detecta o delimitador mais provável a partir da primeira linha da amostra.
 * Conta ocorrências de `,` `;` e tab; em empate prefere `;` (comum em exports
 * do Excel pt-BR).
 *
 * @param sample - Texto CSV (ou apenas a primeira linha) para inspecionar.
 * @returns O delimitador detectado, ou `,` como fallback quando nenhum ocorre.
 */
export function detectCsvDelimiter(sample: string): CsvDelimiter {
  const firstLine = (sample || "").split(/\r?\n/)[0] || "";
  const counts: Record<CsvDelimiter, number> = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  // Prefere ; em empate com , (comum em exports do Excel pt-BR)
  const entries = (Object.entries(counts) as Array<[CsvDelimiter, number]>).sort(
    (a, b) => b[1] - a[1] || (a[0] === ";" ? -1 : 1),
  );
  return entries[0][1] > 0 ? entries[0][0] : ",";
}

/**
 * Faz o parse de um texto CSV para headers + linhas de dados.
 * Suporta campos entre aspas (estilo RFC 4180), aspas escapadas (""),
 * e é tolerante a CRLF/LF.
 *
 * @param input - Texto CSV bruto.
 * @param delimiter - Delimitador a usar (ver `detectCsvDelimiter`).
 * @returns `{ headers, rows }` — headers trimados, linhas totalmente vazias descartadas.
 */
export function parseCsv(
  input: string,
  delimiter: CsvDelimiter,
): { headers: string[]; rows: string[][] } {
  const text = (input ?? "").replace(/^\uFEFF/, ""); // remove BOM UTF-8 se presente
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    // Remove linha vazia final causada pelo newline final
    const isAllEmpty = row.length === 1 && row[0] === "" && rows.length === 0;
    if (!isAllEmpty) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === delimiter) {
      pushField();
      i += 1;
      continue;
    }

    if (c === "\n" || c === "\r") {
      // Trata CRLF
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i += 1;

      pushField();
      pushRow();
      continue;
    }

    field += c;
    i += 1;
  }

  // Descarrega último campo/linha
  pushField();
  pushRow();

  const headers = (rows.shift() || []).map((h) => (h ?? "").trim());
  const dataRows = rows
    .filter((r) => r.some((cell) => (cell ?? "").trim() !== ""))
    .map((r) => r.map((cell) => cell ?? ""));

  return { headers, rows: dataRows };
}

/** Caracteres que iniciam fórmulas/DDE em Excel/LibreOffice (OWASP CSV injection). */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Valores compostos apenas de dígitos e pontuação numérica/telefônica
 * (ex.: "-12.5", "+5511999990000", "+55 11 99999-9999"). Sem letras, pipe ou
 * `!`, não conseguem formar fórmula nem payload DDE — e prefixá-los com aspa
 * corromperia dados legítimos (telefones com +, valores negativos).
 */
const NUMERIC_OR_PHONE_LIKE = /^[+-]?[\d\s().,-/]*$/;

function escapeCsvCell(value: string, delimiter: CsvDelimiter, escapeFormulas: boolean): string {
  let v = value ?? "";
  // Proteção contra formula injection (OWASP): célula iniciando com = + - @
  // \t \r executaria como fórmula/DDE ao abrir o CSV numa planilha. Prefixo
  // com aspa simples força texto literal. Exceção: valores numéricos/telefone
  // (heurística segura — não há vetor de ataque sem letras/pipe/`!`).
  if (escapeFormulas && FORMULA_PREFIX.test(v) && !NUMERIC_OR_PHONE_LIKE.test(v)) {
    v = `'${v}`;
  }
  const mustQuote =
    v.includes('"') || v.includes("\n") || v.includes("\r") || v.includes(delimiter);
  if (!mustQuote) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

export interface StringifyCsvOptions {
  /**
   * Neutraliza CSV formula injection prefixando células perigosas com aspa
   * simples. Default `true` (seguro por padrão — exports abertos em planilha).
   * Usar `false` APENAS em transporte máquina-a-máquina (ex.: remap de CSV
   * enviado de volta à API de import), onde o prefixo corromperia os dados.
   */
  escapeFormulas?: boolean;
}

/**
 * Serializa linhas de dados para texto CSV, com quoting RFC 4180 e proteção
 * contra CSV formula injection.
 *
 * @param rows - Matriz de linhas (cada linha é um array de células).
 * @param delimiter - Delimitador a usar (default `,`).
 * @param options - `{ escapeFormulas }` (default `true`).
 * @returns Texto CSV (sem newline final).
 */
export function stringifyCsv(
  rows: string[][],
  delimiter: CsvDelimiter = ",",
  options: StringifyCsvOptions = {},
): string {
  const escapeFormulas = options.escapeFormulas ?? true;
  return rows
    .map((r) =>
      r.map((cell) => escapeCsvCell(String(cell ?? ""), delimiter, escapeFormulas)).join(delimiter),
    )
    .join("\n");
}

/**
 * Prefixa o texto com o BOM UTF-8, garantindo que Excel abra acentos/pt-BR
 * corretamente ao invés de mojibake.
 *
 * @param text - Texto CSV a prefixar.
 * @returns Texto com o BOM UTF-8 no início.
 */
export function withUtf8Bom(text: string): string {
  return `\uFEFF${text ?? ""}`;
}
