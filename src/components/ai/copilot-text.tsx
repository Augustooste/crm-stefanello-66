import { Fragment, type ReactNode } from "react";

/**
 * Formatação mínima das respostas do Copiloto. O modelo escreve em markdown
 * leve (`**negrito**`, listas com `*`/`-`) e o painel mostrava os asteriscos
 * crus. Aqui só isso vira elemento — sem HTML do modelo, sem lib de markdown.
 */
export function formatCopilotText(text: string): ReactNode {
  return text.split("\n").map((raw, i, lines) => {
    const bullet = /^\s*[*-]\s+/.exec(raw);
    const line = bullet ? raw.slice(bullet[0].length) : raw;
    return (
      <Fragment key={i}>
        {bullet && "• "}
        {bold(line)}
        {i < lines.length - 1 && "\n"}
      </Fragment>
    );
  });
}

function bold(line: string): ReactNode[] {
  // Partes ímpares estão entre `**`. Um `**` sem par é descartado.
  return line.split("**").map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}
