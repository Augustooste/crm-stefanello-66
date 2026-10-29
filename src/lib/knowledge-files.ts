/**
 * Formatos e limites aceitos pela base de conhecimento.
 * Espelha UPLOAD_TYPES/KNOWLEDGE_MAX_BYTES de
 * supabase/functions/_shared/ai/knowledge-ingest.ts — o servidor continua
 * sendo a autoridade; aqui só antecipamos a validação para o usuário.
 */
export const KNOWLEDGE_MAX_BYTES = 25 * 1024 * 1024;
export const KNOWLEDGE_MAX_MB = Math.round(KNOWLEDGE_MAX_BYTES / (1024 * 1024));

export const KNOWLEDGE_EXTENSION_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tiff: "image/tiff",
  tif: "image/tiff",
  heic: "image/heic",
};

export const KNOWLEDGE_EXTENSIONS = Object.keys(KNOWLEDGE_EXTENSION_MIME);

export const KNOWLEDGE_ACCEPT_ATTRIBUTE = KNOWLEDGE_EXTENSIONS.map((ext) => `.${ext}`).join(",");

export const KNOWLEDGE_FORMAT_GROUPS = [
  { label: "Documentos", items: "PDF, DOCX, DOC, PPTX, PPT, RTF, EPUB, TXT, MD" },
  { label: "Planilhas", items: "XLSX, XLS, CSV, TSV, ODS" },
  { label: "Imagens (OCR)", items: "PNG, JPG, WEBP, TIFF, HEIC" },
] as const;

export function knowledgeFileExtension(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

export function knowledgeMimeFor(file: File): string {
  const extension = knowledgeFileExtension(file.name);
  return file.type || KNOWLEDGE_EXTENSION_MIME[extension] || "application/octet-stream";
}

/** Retorna a mensagem de erro, ou null quando o arquivo é aceito. */
export function validateKnowledgeFile(file: File): string | null {
  const extension = knowledgeFileExtension(file.name);
  if (!KNOWLEDGE_EXTENSION_MIME[extension]) {
    return `Formato .${extension || "desconhecido"} não é suportado.`;
  }
  if (file.size < 1) return "O arquivo está vazio.";
  if (file.size > KNOWLEDGE_MAX_BYTES) {
    return `O arquivo deve ter no máximo ${KNOWLEDGE_MAX_MB} MB.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
