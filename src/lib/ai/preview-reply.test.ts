import { describe, expect, it } from "vitest";
import { renderPreviewReply } from "./preview-reply";

describe("renderPreviewReply", () => {
  it("traduz o marcador [TRANSFERIR_HUMANO] para a frase de handoff", () => {
    expect(renderPreviewReply("[TRANSFERIR_HUMANO]")).toBe(
      "A IA não soube responder com segurança e transferiria para um humano aqui.",
    );
  });

  it("passa uma resposta normal intacta", () => {
    expect(renderPreviewReply("Claro, posso te ajudar com isso.")).toBe(
      "Claro, posso te ajudar com isso.",
    );
  });
});
