import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Avatar de iniciais — o padrão único para representar pessoa sem foto.
 *
 * Existia em seis combinações diferentes de cor espalhadas por sete arquivos,
 * uma delas sem cor nenhuma (herdava `--foreground` sobre `bg-primary`, 2.75:1).
 * Cada tela também trazia a própria cópia de `initials()`: eram seis
 * implementações da mesma função.
 *
 * As três variantes abaixo são as que existiam de fato — nenhuma foi inventada.
 * Todas têm o par cor/fundo do DS, então o contraste não depende de quem
 * escreve a `className`.
 */
const VARIANTES = {
  /** Identidade do usuário: topbar e cabeçalho de contato. */
  brand: "bg-primary text-primary-foreground",
  /** Pessoa numa lista, onde o avatar não deve competir com o conteúdo. */
  muted: "bg-muted text-muted-foreground",
  /** Interlocutor de conversa — o realce do Inbox. */
  accent: "bg-accent text-accent-foreground",
} as const;

/** Dimensão e texto andam em par: quem passa só um dos dois produz avatar desproporcional. */
const TAMANHOS = {
  xs: { caixa: "h-6 w-6", texto: "text-caption" },
  sm: { caixa: "h-7 w-7", texto: "text-caption" },
  md: { caixa: "h-8 w-8", texto: "text-caption" },
  lg: { caixa: "h-9 w-9", texto: "text-caption" },
  xl: { caixa: "h-10 w-10", texto: "text-body" },
  "2xl": { caixa: "h-14 w-14", texto: "text-body" },
} as const;

export type InitialsAvatarVariant = keyof typeof VARIANTES;
export type InitialsAvatarSize = keyof typeof TAMANHOS;

/**
 * Primeira letra do primeiro e do último nome, em caixa alta.
 *
 * Havia duas regras concorrentes: a topbar usava primeira+última e as cinco
 * listas usavam as duas primeiras palavras. "João Pedro Silva" aparecia como
 * "JS" no topo e "JP" na lista, para a mesma pessoa. Ficou primeira+última, que
 * é a convenção de nome+sobrenome e o que o usuário já via no lugar mais
 * visível da tela.
 *
 * Nome vazio vira "?" em vez de avatar em branco: um círculo vazio parece
 * carregamento travado, e essa função recebe dado de contato que o usuário
 * digitou.
 */
export function iniciaisDe(nome?: string | null): string {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  const primeira = partes[0][0];
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : "";
  return (primeira + ultima).toUpperCase();
}

export function InitialsAvatar({
  name,
  variant = "muted",
  size = "md",
  className,
}: {
  name?: string | null;
  variant?: InitialsAvatarVariant;
  size?: InitialsAvatarSize;
  /** Só para posicionamento (ring, margin). Cor e dimensão vêm da variante e do tamanho. */
  className?: string;
}) {
  const { caixa, texto } = TAMANHOS[size];
  return (
    <Avatar className={cn(caixa, className)}>
      <AvatarFallback className={cn(texto, VARIANTES[variant], "font-semibold")}>
        {iniciaisDe(name)}
      </AvatarFallback>
    </Avatar>
  );
}
