import { z } from "zod";

/**
 * Política de senha do produto: mínimo 8 caracteres, barrando as duas formas
 * triviais mais comuns — só dígitos ("12345678") e um único caractere
 * repetido ("aaaaaaaa"). Fonte única: cadastro e redefinição pós-link
 * (auth.tsx) e troca de senha autenticada (_app.perfil.tsx) importam daqui.
 */
export const passwordSchema = z
  .string()
  .min(8, "A senha deve ter pelo menos 8 caracteres")
  .refine((v) => !/^\d+$/.test(v) && !/^(.)\1*$/.test(v), {
    message: "Escolha uma senha mais forte — evite apenas números ou um caractere repetido",
  });
