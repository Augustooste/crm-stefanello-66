import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Configuração automática do remix.
 *
 * Um projeto recém-remixado herda o código e o schema, mas o cofre interno do
 * backend nasce vazio — e sem ele as rotinas automáticas (nutrição, SLA, fila
 * da IA) não conseguem chamar nada. Esta função lê o endereço do projeto e a
 * credencial interna do PRÓPRIO ambiente de execução do servidor e grava no
 * cofre. Nenhum segredo trafega pelo navegador: o cliente só recebe "gravado".
 *
 * Segurança: exige sessão válida (middleware) e revalida que o chamador é
 * administrador do tenant antes de qualquer escrita privilegiada.
 */
export const configureEnvironment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Papel é revalidado no banco: bootstrap_status() lança 42501 para quem
    // não é admin, então serve de porteiro antes do trecho privilegiado.
    const { error: guardError } = await context.supabase.rpc(
      "bootstrap_status" as never,
      {} as never,
    );
    if (guardError) {
      throw new Error("Apenas administradores podem preparar o ambiente.");
    }

    const projectUrl = process.env["SUPABASE_URL"];
    const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    if (!projectUrl || !serviceRoleKey) {
      throw new Error(
        "O ambiente do servidor não expõe o endereço do projeto e a credencial interna.",
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc(
      "configure_internal_access" as never,
      {
        p_project_url: projectUrl,
        p_service_role_key: serviceRoleKey,
      } as never,
    );
    if (error) {
      // Nunca ecoar o valor: só o nome da chave e a causa tratada.
      console.error("[bootstrap] falha ao gravar acesso interno:", error.message);
      throw new Error("Não foi possível gravar o acesso interno do backend.");
    }

    return {
      ok: true as const,
      written: ["aceleraflow_project_url", "aceleraflow_service_role_key"],
    };
  });
