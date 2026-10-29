import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Chrome, KeyRound, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandMark } from "@/components/marketing/BrandMark";
import { ProductSignalPreview } from "@/components/marketing/ProductSignalPreview";
import { toast } from "sonner";
import { assertPublicSupabaseEnv } from "@/lib/env";
import { passwordSchema } from "@/lib/validation/password";
import { setClientAuthTransition } from "@/lib/client-error-telemetry";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    // Sem env pública, não adianta chamar o backend — falha cedo com mensagem clara.
    assertPublicSupabaseEnv();
    const { data } = await supabase.auth.getSession();
    if (data.session && !isPasswordUpdateMode()) throw redirect({ to: "/app" });
  },
  component: AuthPage,
  head: () => ({
    meta: [{ title: "Entrar — Stefanello" }, { name: "robots", content: "noindex" }],
  }),
});

/** Traduz erros de auth (Supabase/Lovable) para PT-BR — a mensagem crua vem em inglês. */
function authErrorPtBr(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;
  const byCode: Record<string, string> = {
    invalid_credentials: "E-mail ou senha incorretos.",
    email_not_confirmed: "Confirme seu e-mail antes de entrar.",
    user_already_exists: "Já existe uma conta com esse e-mail.",
    email_exists: "Já existe uma conta com esse e-mail.",
    weak_password: "Senha muito fraca — use ao menos 6 caracteres.",
    over_request_rate_limit: "Muitas tentativas. Aguarde um instante e tente de novo.",
    over_email_send_rate_limit: "Muitos e-mails enviados. Aguarde um instante.",
    validation_failed: "Dados inválidos. Confira e-mail e senha.",
    // O Supabase não distingue "expirado" de "já utilizado" — otp_expired cobre os dois casos
    // (mesmo código de erro nos dois cenários; ver https://supabase.com/docs/guides/auth/debugging/error-codes).
    otp_expired: "Este link expirou ou já foi utilizado. Solicite um novo para continuar.",
    access_denied: "Você cancelou a autorização ou não tem permissão para continuar.",
  };
  if (e?.code && byCode[e.code]) return byCode[e.code];
  // Fallback por texto (versões do supabase-js sem `code`).
  const t = (e?.message ?? "").toLowerCase();
  if (t.includes("invalid login credentials")) return byCode.invalid_credentials;
  if (t.includes("email not confirmed")) return byCode.email_not_confirmed;
  if (t.includes("already registered") || t.includes("already exists"))
    return byCode.user_already_exists;
  if (t.includes("weak password") || t.includes("at least 6")) return byCode.weak_password;
  if (t.includes("rate limit")) return byCode.over_request_rate_limit;
  if (t.includes("expired")) return byCode.otp_expired;
  if (t.includes("denied")) return byCode.access_denied;
  // Sem match conhecido: mensagem genérica em PT-BR (não vaza texto cru do provedor).
  return "Não foi possível autenticar. Tente novamente.";
}

type AuthMode = "signin" | "signup" | "recovery" | "update";

function isPasswordUpdateMode(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("mode") === "update"
  );
}

/**
 * Lê erro de callback de auth (link de recuperação/magic-link expirado ou já usado,
 * OAuth negado). O GoTrue reporta esses erros no fragmento da URL no fluxo implicit
 * (#error=...) ou na query string no fluxo PKCE (?error=...) — ver
 * https://supabase.com/docs/guides/auth/redirect-urls. Checa os dois porque o cliente
 * não fixa `flowType` explicitamente.
 */
function getAuthCallbackError(): { code?: string; message?: string } | null {
  if (typeof window === "undefined") return null;
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const searchParams = new URLSearchParams(window.location.search);
  const params = hashParams.get("error") ? hashParams : searchParams;
  const error = params.get("error");
  if (!error) return null;
  return {
    code: params.get("error_code") ?? error,
    message: params.get("error_description") ?? undefined,
  };
}

function initialMode(): AuthMode {
  if (isPasswordUpdateMode()) {
    // Link de recuperação expirado/já usado: o formulário de update nunca teria sucesso
    // (sem sessão válida) e não oferece saída — volta para "recovery" pra pedir um novo link.
    return getAuthCallbackError() ? "recovery" : "update";
  }
  if (typeof window === "undefined") return "signin";
  return new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "signin";
}

function AuthPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Ambiente recém-remixado: banco novo, nenhuma conta. Recuperar senha ali não
  // leva a lugar nenhum (não existe conta para receber o link) — o caminho certo
  // é criar a primeira conta, que já nasce administradora do ambiente.
  const [ambienteVazio, setAmbienteVazio] = useState(false);
  const [linkEnviado, setLinkEnviado] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const callbackError = getAuthCallbackError();
    if (callbackError) toast.error(authErrorPtBr(callbackError));
    let navigationStarted = false;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("update");
        return;
      }
      // O Supabase emite INITIAL_SESSION com a sessão temporária do link de
      // recuperação. Nessa rota, manter o formulário aberto é necessário
      // para o usuário conseguir definir a nova senha.
      if (session && !isPasswordUpdateMode() && !navigationStarted) {
        navigationStarted = true;
        // Descarta queries/erros deixados pela sessão anterior antes de montar
        // novamente o layout autenticado. Sem isso, o boundary pode reapresentar
        // um 42501 ocorrido durante o logout como se fosse um erro do novo login.
        void queryClient.cancelQueries().then(() => {
          queryClient.clear();
          setClientAuthTransition("stable");
          return navigate({ to: "/app", replace: true });
        });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate, queryClient]);

  useEffect(() => {
    let cancelado = false;
    // Falha na consulta = comportamento de sempre. A tela nunca trava por isso.
    void (async () => {
      try {
        const { data, error } = await supabase.rpc("tem_alguma_conta");
        if (cancelado || error || data !== false) return;
        setAmbienteVazio(true);
        setMode((atual) => (atual === "signin" ? "signup" : atual));
      } catch {
        // silencioso de propósito
      }
    })();

    return () => {
      cancelado = true;
    };
  }, []);

  if (!hydrated) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "recovery") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth?mode=update`,
        });
        if (error) throw error;
        toast.success("Enviamos um link seguro para redefinir sua senha.");
        // Fica no modo recovery de propósito: o aviso abaixo explica o que fazer
        // se o e-mail não chegar (conta inexistente neste ambiente, por exemplo).
        setLinkEnviado(true);
      } else if (mode === "update") {
        if (password !== confirmation) {
          toast.error("As senhas não conferem.");
          return;
        }
        const passwordCheck = passwordSchema.safeParse(password);
        if (!passwordCheck.success) {
          toast.error(passwordCheck.error.issues[0].message);
          return;
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success("Senha atualizada. Seu ambiente está pronto.");
        navigate({ to: "/app" });
      } else if (mode === "signup") {
        const passwordCheck = passwordSchema.safeParse(password);
        if (!passwordCheck.success) {
          toast.error(passwordCheck.error.issues[0].message);
          return;
        }
        const inviteToken =
          typeof window !== "undefined"
            ? (new URLSearchParams(window.location.search).get("invite") ?? undefined)
            : undefined;
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { name, ...(inviteToken ? { invite_token: inviteToken } : {}) },
            emailRedirectTo: `${window.location.origin}/auth`,
          },
        });
        if (error) {
          // handle_new_user aborta o cadastro quando o invite_token não resolve
          // (inexistente, expirado ou emitido para outro e-mail), mas o GoTrue
          // embrulha exceção de trigger num opaco "Database error saving new
          // user" — medido: HTTP 500, error_code unexpected_failure. A mensagem
          // em PT-BR do banco não atravessa. Quando havia convite em jogo e o
          // erro é justamente esse 500 opaco, dizer a causa provável vale mais
          // que repetir o texto genérico. Qualquer outro erro segue o caminho
          // normal de tradução.
          const falhaOpacaDoTrigger = error.status === 500 || error.code === "unexpected_failure";
          if (inviteToken && falhaOpacaDoTrigger) {
            toast.error(
              "Não foi possível usar este convite. Ele pode ter expirado ou ter sido emitido para outro e-mail — peça um link novo a quem convidou.",
            );
            return;
          }
          throw error;
        }
        toast.success("Conta criada. Verifique seu e-mail se necessário.");
      } else {
        setClientAuthTransition("signing_in");
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setClientAuthTransition("stable");
      toast.error(authErrorPtBr(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    const result = await lovable.auth.signInWithOAuth("google", {
      // O retorno passa novamente pelo guard de /auth, que envia a sessão recém-criada a /app.
      redirect_uri: `${window.location.origin}/auth`,
    });
    if (result.error) toast.error(authErrorPtBr(result.error));
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--neutral-950)] px-4 py-4 text-slate-100 sm:px-6 lg:grid lg:grid-cols-2 lg:gap-8 lg:px-8 lg:py-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(30,99,200,0.2),transparent_42%)]"
      />
      <Link to="/" className="relative z-10 lg:absolute lg:left-8 lg:top-8">
        <BrandMark />
      </Link>

      <aside className="relative z-10 hidden min-h-[calc(100vh-4rem)] flex-col justify-center py-20 lg:flex lg:px-[max(2rem,8vw)]">
        <p className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-caption font-semibold uppercase tracking-[0.13em] text-primary">
          <ShieldCheck className="h-3.5 w-3.5" /> Seu ritmo comercial, visível
        </p>
        <h1 className="max-w-xl [font-family:Lexend,sans-serif] text-h1 font-semibold leading-[1.05] tracking-[-0.055em] text-white">
          Menos ruído entre uma conversa e a próxima venda.
        </h1>
        <p className="mt-5 max-w-lg text-lead leading-8 text-slate-300">
          Pipeline, atendimento e inteligência de operação no mesmo cockpit comercial.
        </p>
        <ProductSignalPreview className="mt-10 max-w-xl" compact />
        <ul className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
          {[
            "Ações sempre priorizadas",
            "Contexto em cada conversa",
            "Dados protegidos por tenant",
            "Automação que respeita o time",
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              {item}
            </li>
          ))}
        </ul>
      </aside>

      <section className="relative z-10 flex min-h-[calc(100vh-5rem)] items-center justify-center py-10 lg:min-h-[calc(100vh-4rem)] lg:py-16">
        <Card className="w-full max-w-md border-white/10 bg-[var(--neutral-950)]/90 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <CardHeader className="space-y-3 pb-5">
            <span className="inline-flex w-fit items-center gap-2 text-caption font-semibold uppercase tracking-[0.14em] text-primary lg:hidden">
              <KeyRound className="h-3.5 w-3.5" /> Stefanello
            </span>
            <CardTitle className="[font-family:Lexend,sans-serif] text-h3 font-semibold leading-tight tracking-[-0.045em] text-white">
              {mode === "signin" && "Entre no seu cockpit"}
              {mode === "signup" &&
                (ambienteVazio ? "Crie a conta do administrador" : "Comece com clareza")}
              {mode === "recovery" && "Recupere seu acesso"}
              {mode === "update" && "Defina uma nova senha"}
            </CardTitle>
            <p className="text-sm leading-6 text-slate-400">
              {mode === "signin" && "Acompanhe o que move sua receita hoje."}
              {mode === "signup" &&
                (ambienteVazio
                  ? "Este ambiente é novo e ainda não tem nenhuma conta."
                  : "Crie seu ambiente e conecte sua operação comercial.")}
              {mode === "recovery" && "Informe seu e-mail e enviaremos um link seguro."}
              {mode === "update" && "Use uma senha forte para proteger o ambiente."}
            </p>
            {ambienteVazio && mode !== "update" && (
              <p
                role="status"
                className="rounded-lg border border-primary/25 bg-primary/10 p-3 text-caption leading-5 text-slate-200"
              >
                As contas do projeto de origem não vêm junto no remix: cada ambiente começa do zero.
                A primeira conta criada aqui vira a administradora.
              </p>
            )}
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name">Nome</Label>
                  <Input
                    className="h-11 text-base"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
              )}
              {mode !== "update" && (
                <div className="space-y-2">
                  <Label htmlFor="email">E-mail</Label>
                  <Input
                    className="h-11 text-base"
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              )}
              {mode !== "recovery" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Senha</Label>
                    {mode === "signin" && !ambienteVazio && (
                      <button
                        type="button"
                        onClick={() => setMode("recovery")}
                        className="text-caption font-medium text-primary hover:text-primary/80"
                      >
                        Esqueci minha senha
                      </button>
                    )}
                  </div>
                  <Input
                    className="h-11 text-base"
                    id="password"
                    type="password"
                    autoComplete={
                      mode === "update"
                        ? "new-password"
                        : mode === "signup"
                          ? "new-password"
                          : "current-password"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
              )}
              {mode === "update" && (
                <div className="space-y-2">
                  <Label htmlFor="confirmation">Confirme a nova senha</Label>
                  <Input
                    className="h-11 text-base"
                    id="confirmation"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
              )}
              <Button type="submit" size="lg" className="h-11 w-full text-base" disabled={loading}>
                {loading
                  ? "Aguarde..."
                  : mode === "signin"
                    ? "Entrar"
                    : mode === "signup"
                      ? "Criar conta"
                      : mode === "recovery"
                        ? "Enviar link seguro"
                        : "Atualizar senha"}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </Button>
            </form>

            {mode === "recovery" && linkEnviado && (
              <p
                role="status"
                className="mt-4 rounded-lg border border-white/10 bg-white/5 p-3 text-caption leading-5 text-slate-300"
              >
                Se o e-mail não chegar em alguns minutos, é provável que esta conta não exista neste
                ambiente ou que o envio de e-mails ainda não esteja ativo aqui. Nesse caso,{" "}
                <button
                  type="button"
                  onClick={() => {
                    setLinkEnviado(false);
                    setMode("signup");
                  }}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  crie uma conta
                </button>{" "}
                com este e-mail.
              </p>
            )}

            {(mode === "signin" || mode === "signup") && (
              <>
                <div className="my-5 flex items-center gap-3 text-caption text-slate-500">
                  <span className="h-px flex-1 bg-white/10" />
                  ou continue com
                  <span className="h-px flex-1 bg-white/10" />
                </div>
                <Button
                  variant="outline"
                  className="h-11 w-full border-white/15 bg-transparent text-slate-100 hover:bg-white/8 hover:text-white"
                  onClick={handleGoogle}
                  type="button"
                >
                  <Chrome className="h-4 w-4" />
                  Entrar com Google
                </Button>
              </>
            )}

            <div className="mt-6 text-center text-sm text-slate-400">
              {mode === "signin" && (
                <button
                  type="button"
                  className="font-medium text-primary hover:text-primary/80"
                  onClick={() => setMode("signup")}
                >
                  Não tem conta? Criar conta
                </button>
              )}
              {mode === "signup" && (
                <button
                  type="button"
                  className="font-medium text-primary hover:text-primary/80"
                  onClick={() => setMode("signin")}
                >
                  Já tem conta? Entrar
                </button>
              )}
              {mode === "recovery" && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary/80"
                  onClick={() => {
                    setLinkEnviado(false);
                    setMode("signin");
                  }}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Voltar para entrar
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
