import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, User } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { passwordSchema } from "@/lib/validation/password";

export const Route = createFileRoute("/_app/perfil")({
  head: () => ({
    meta: [
      { title: "Perfil" },
      { name: "description", content: "Edite seu nome e altere sua senha de acesso." },
    ],
  }),
  component: PerfilPage,
});

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome é obrigatório")
    .max(80, "Nome deve ter no máximo 80 caracteres"),
});
type NameFormValues = z.infer<typeof nameSchema>;

const passwordFormSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(8, "Confirme a nova senha"),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "As senhas não coincidem",
    path: ["confirmPassword"],
  });
type PasswordFormValues = z.infer<typeof passwordFormSchema>;

function PersonalDataCard() {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<NameFormValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: profile?.name ?? "" },
  });

  // Preenche o campo assim que o perfil chega (a query é assíncrona e pode
  // resolver depois do primeiro render, quando defaultValues já rodou).
  useEffect(() => {
    reset({ name: profile?.name ?? "" });
  }, [profile?.name, reset]);

  const mutation = useMutation({
    mutationFn: async (data: NameFormValues) => {
      if (!profile) throw new Error("Sessão inválida");
      const { error } = await supabase
        .from("profiles")
        .update({ name: data.name })
        .eq("id", profile.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["current-profile", profile?.id] });
      toast.success("Perfil atualizado");
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao atualizar perfil"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <User className="h-4 w-4" aria-hidden />
          Dados pessoais
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="perfil-name">Nome</Label>
            <Input id="perfil-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const mutation = useMutation({
    mutationFn: async (data: PasswordFormValues) => {
      const { error } = await supabase.auth.updateUser({ password: data.password });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Senha atualizada");
      reset({ password: "", confirmPassword: "" });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao atualizar senha"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <KeyRound className="h-4 w-4" aria-hidden />
          Alterar senha
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="perfil-password">Nova senha</Label>
              <Input
                id="perfil-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.password}
                {...register("password")}
              />
              {errors.password && (
                <p className="text-caption text-destructive">{errors.password.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perfil-confirm-password">Confirme a nova senha</Label>
              <Input
                id="perfil-confirm-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.confirmPassword}
                {...register("confirmPassword")}
              />
              {errors.confirmPassword && (
                <p className="text-caption text-destructive">{errors.confirmPassword.message}</p>
              )}
            </div>
          </div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PerfilPage() {
  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader title="Meu perfil" description="Gerencie seus dados de acesso." />
      <PersonalDataCard />
      <PasswordCard />
    </div>
  );
}
