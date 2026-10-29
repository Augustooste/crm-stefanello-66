// Renderizador de Markdown mínimo e seguro (subconjunto usado em src/content/**).
// Nunca usa dangerouslySetInnerHTML: todo texto vira nó React (escapado pelo React), e
// HTML cru aparece como texto. Única exceção sintática: a linha `<a id="slug"></a>`,
// que só define a âncora do título seguinte (id validado) e não gera elemento.
// shortcut: sem listas aninhadas, imagens nem HTML; trocar por lib de markdown se o
// conteúdo precisar disso.
import { Fragment, type ReactNode } from "react";

import { CopySnippet } from "@/components/common/CopySnippet";
import { cn } from "@/lib/utils";

type Align = "left" | "center" | "right" | null;

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { type: "quote"; paragraphs: string[] }
  | { type: "code"; lang: string; code: string }
  | { type: "hr" };

export type TocItem = { id: string; text: string };

const ANCHOR_RE = /^<a id="([^"]*)"><\/a>$/;
const VALID_ID_RE = /^[a-z0-9-]+$/;
const COMMENT_RE = /^<!--.*-->$/;
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^```\s*([\w+-]*)\s*$/;
const LIST_RE = /^([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
// Allowlist ancorada: https/http, caminho do app (sem // nem /\, que o navegador lê como //),
// âncora local e mailto. Nada de trim.
const SAFE_HREF_RE = /^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s]*|#[a-z0-9-]+|mailto:[^\s]+)$/i;

export function isSafeHref(href: string): boolean {
  return SAFE_HREF_RE.test(href);
}

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "secao";
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : null;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    LIST_RE.test(line) ||
    line.startsWith(">") ||
    HR_RE.test(line) ||
    ANCHOR_RE.test(line) ||
    COMMENT_RE.test(line) ||
    (line.startsWith("|") && next !== undefined && TABLE_SEP_RE.test(next.trim()))
  );
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  const used = new Set<string>();
  let pendingId: string | null = null;
  const uniqueId = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || COMMENT_RE.test(line)) {
      i++;
      continue;
    }
    const anchor = ANCHOR_RE.exec(line);
    if (anchor && VALID_ID_RE.test(anchor[1])) {
      // Âncora explícita repetida viraria "x-2" em silêncio e o link #x iria para outra seção.
      if (used.has(anchor[1])) throw new Error(`âncora duplicada no markdown: #${anchor[1]}`);
      pendingId = anchor[1];
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "```") code.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[1], code: code.join("\n") });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = heading[2];
      const id = uniqueId(pendingId ?? slugify(text));
      pendingId = null;
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4, text, id });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (line.startsWith("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1].trim())) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ type: "table", header, align, rows });
      continue;
    }
    if (line.startsWith(">")) {
      const paragraphs: string[] = [];
      let current: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        const text = lines[i++].trim().replace(/^>\s?/, "").trim();
        if (text) current.push(text);
        else if (current.length) {
          paragraphs.push(current.join(" "));
          current = [];
        }
      }
      if (current.length) paragraphs.push(current.join(" "));
      blocks.push({ type: "quote", paragraphs });
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      const ordered = /^\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const current = LIST_RE.exec(lines[i].trim());
        if (current && /^\d/.test(current[1]) === ordered) {
          items.push(current[2]);
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else break;
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const text: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i].trim(), lines[i + 1])) {
      text.push(lines[i++].trim());
    }
    blocks.push({ type: "paragraph", text: text.join(" ") });
  }
  return blocks;
}

export function tocFromBlocks(blocks: MdBlock[]): TocItem[] {
  return blocks.flatMap((b) =>
    b.type === "heading" && b.level === 2 ? [{ id: b.id, text: b.text }] : [],
  );
}

// code | link [texto](href, com 1 nível de parênteses) | **negrito** | *itálico* | _itálico_
// Linear: o conteúdo de link e itálico não contém o próprio delimitador ([, * ou _), então
// cada tentativa para no delimitador seguinte em vez de varrer até o fim (era O(n²)).
const INLINE_RE =
  /`([^`]+)`|\[([^[\]]+)\]\(((?:[^()\s]|\([^()\s]*\))*)\)|\*\*(.+?)\*\*|(?<![\w*])\*(?![\s*])([^*]+?)(?<![\s*])\*(?![\w*])|(?<![\p{L}\p{N}_])_(?![\s_])([^_]+?)(?<![\s_])_(?![\p{L}\p{N}_])/gu;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const k = key++;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] break-words">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      const href = m[3];
      const label = renderInline(m[2]);
      if (!isSafeHref(href)) {
        out.push(<Fragment key={k}>{label}</Fragment>);
      } else {
        const external = /^https?:\/\//i.test(href);
        out.push(
          <a
            key={k}
            href={href}
            className="font-medium text-primary underline underline-offset-2 break-words hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {label}
            {/* Espaço fora do span: o nome acessível concatena sem espaço o texto do sr-only. */}
            {external && (
              <>
                {" "}
                <span className="sr-only">(abre em nova aba)</span>
              </>
            )}
          </a>,
        );
      }
    } else if (m[4] !== undefined) {
      out.push(
        <strong key={k} className="font-semibold text-foreground">
          {renderInline(m[4])}
        </strong>,
      );
    } else {
      out.push(<em key={k}>{renderInline(m[5] ?? m[6] ?? "")}</em>);
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "text-page-title font-semibold tracking-tight",
  // text-h5 (20px): o token text-section-title não existe em styles.css.
  2: "mt-6 border-b border-border pb-2 text-h5 font-semibold",
  3: "mt-4 text-card-title font-semibold",
  4: "mt-2 text-body font-semibold",
};

const ALIGN_CLASS: Record<Exclude<Align, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function renderBlock(block: MdBlock, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as const;
      return (
        <Tag
          key={key}
          id={block.id}
          className={cn("scroll-mt-20 break-words text-foreground", HEADING_CLASS[block.level])}
        >
          {renderInline(block.text)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="break-words text-body text-foreground">
          {renderInline(block.text)}
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={cn(
            "flex flex-col gap-1 pl-5 text-body text-foreground",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, i) => (
            <li key={i} className="break-words">
              {renderInline(item)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div
          key={key}
          tabIndex={0}
          role="region"
          aria-label="Tabela (role para ver mais)"
          className="min-w-0 max-w-full overflow-x-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Largura mínima: em 390 px a tabela rola em vez de espremer as colunas. */}
          <table className="w-full min-w-[32rem] border-collapse text-body">
            <thead className="bg-muted">
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    scope="col"
                    className={cn(
                      "border-b border-border px-3 py-2 text-left font-semibold text-foreground",
                      block.align[i] && ALIGN_CLASS[block.align[i] as Exclude<Align, null>],
                    )}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-b-0">
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className={cn(
                        "px-3 py-2 align-top text-foreground",
                        block.align[c] && ALIGN_CLASS[block.align[c] as Exclude<Align, null>],
                      )}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      return (
        <aside
          key={key}
          role="note"
          className="flex flex-col gap-2 rounded-md border border-border border-l-4 border-l-primary bg-muted p-3 text-body text-foreground"
        >
          {block.paragraphs.map((p, i) => (
            <p key={i} className="break-words">
              {renderInline(p)}
            </p>
          ))}
        </aside>
      );
    case "code":
      return (
        <CopySnippet
          key={key}
          label={
            block.lang && block.lang !== "text" ? `Copiar código (${block.lang})` : "Copiar código"
          }
          code={block.code}
        />
      );
    case "hr":
      return <hr key={key} className="border-border" />;
  }
}

export function MarkdownLite({ blocks, className }: { blocks: MdBlock[]; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>{blocks.map(renderBlock)}</div>
  );
}
