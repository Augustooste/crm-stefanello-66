import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Ganhar/Perder saíram do menu de 28px e viraram botões com rótulo no rodapé do
 * card. Helper compartilhado por `_app.pipeline.test.tsx` e
 * `_app.pipeline.gaps.test.tsx` — a cópia idêntica nos dois arquivos ficava
 * dessincronizada a cada mudança de marcação do card.
 */
export async function clickCardAction(dealTitle: string, action: "Ganhar" | "Perder") {
  const user = userEvent.setup();
  const card = screen.getByText(dealTitle).closest("div.group")!;
  await user.click(within(card as HTMLElement).getByRole("button", { name: action }));
  return user;
}
