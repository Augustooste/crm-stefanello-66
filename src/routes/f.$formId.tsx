// Página PÚBLICA de submissão de formulário de captura de lead (PRD Fase 4,
// user story I). Rota de TOPO, irmã de auth.tsx — fora do layout autenticado
// (sem AppSidebar/AppTopbar/OnboardingGate), acessível sem sessão.
//
// Backend: supabase/functions/lead-form-submit/index.ts (contrato completo).
// Schema: supabase/migrations/20260711100200_fase4_prb_lead_forms_schema.sql.
//
// Estilização: neutra (bg-background padrão), NÃO herda a cor de marca do
// tenant — isso exigiria uma lookup pública adicional (tenant_id -> cor) fora
// do escopo desta tarefa. Decisão documentada aqui, não é uma omissão.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm, Controller, type SubmitHandler, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { parseLeadFormFields } from "@/lib/lead-form-fields";
import type { LeadFormField } from "@/lib/lead-form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const Route = createFileRoute("/f/$formId")({
  ssr: false,
  component: PublicLeadFormPage,
  head: () => ({
    meta: [
      { title: "Formulário de contato — CRM IA" },
      { name: "description", content: "Preencha o formulário para entrar em contato." },
    ],
  }),
});

const REQUIRED_MESSAGE = "Campo obrigatório";
const INVALID_NUMBER_MESSAGE = "Informe um número válido";
const GENERIC_SUBMIT_ERROR = "Não foi possível enviar. Tente novamente em instantes.";
const RATE_LIMIT_FALLBACK_MESSAGE =
  "Muitas submissões recebidas. Tente novamente em alguns minutos.";
const DEFAULT_SUCCESS_MESSAGE = "Recebemos sua mensagem! Em breve entraremos em contato.";

interface PublicLeadForm {
  id: string;
  name: string;
  success_message: string | null;
  fields: LeadFormField[];
}

/** Valores do react-hook-form: string p/ text/number/date/select, boolean p/ checkbox. */
type FieldValues = Record<string, string | boolean>;

/**
 * Schema de validação construído a partir de `fields`. Cada branch mantém o
 * tipo de ENTRADA igual ao de SAÍDA (sem `.transform`/`.preprocess`/`.default`)
 * — divergência ali quebra a inferência de tipos entre `zodResolver` e
 * `useForm<FieldValues>`. Conversão de número / remoção de string vazia
 * acontece depois, em `buildSubmissionPayload` (TS simples, não no zod).
 */
function buildFieldsSchema(fields: LeadFormField[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    if (field.type === "boolean") {
      shape[field.key] = field.required
        ? z.boolean().refine((v) => v === true, { message: REQUIRED_MESSAGE })
        : z.boolean();
      continue;
    }
    if (field.type === "number") {
      shape[field.key] = field.required
        ? z
            .string()
            .trim()
            .min(1, REQUIRED_MESSAGE)
            .refine((v) => !Number.isNaN(Number(v)), INVALID_NUMBER_MESSAGE)
        : z
            .string()
            .trim()
            .optional()
            .refine((v) => !v || !Number.isNaN(Number(v)), INVALID_NUMBER_MESSAGE);
      continue;
    }
    // text, date, select — "select" ainda não carrega `options` no schema
    // (ver LeadFormField em src/lib/lead-form-fields.ts); renderizado e
    // validado como texto livre até essa lacuna ser fechada. Decisão de MVP,
    // não uma omissão.
    shape[field.key] = field.required
      ? z.string().trim().min(1, REQUIRED_MESSAGE)
      : z.string().trim().optional();
  }
  return z.object(shape);
}

function buildDefaultValues(fields: LeadFormField[]): FieldValues {
  const values: FieldValues = {};
  for (const field of fields) {
    values[field.key] = field.type === "boolean" ? false : "";
  }
  return values;
}

/** Converte os valores validados no payload que o backend espera: número de
 * verdade p/ campos "number", e omite strings opcionais vazias (não faz
 * sentido sobrescrever um custom field existente com ""). */
function buildSubmissionPayload(
  fields: LeadFormField[],
  values: FieldValues,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.type === "boolean") {
      payload[field.key] = raw === true;
      continue;
    }
    if (typeof raw === "string" && raw.trim() === "") continue;
    payload[field.key] = field.type === "number" ? Number(raw) : raw;
  }
  return payload;
}

interface InvokeErrorContext {
  status?: number;
  json?: () => Promise<unknown>;
}

/**
 * Extrai uma mensagem exibível de um erro de `supabase.functions.invoke`.
 * Tenta ler o corpo JSON real ({error: "..."}) que o edge function sempre
 * devolve; se isso falhar, cai num fallback específico para 429 e um
 * genérico para o resto — nunca vaza o erro cru do Postgres/fetch.
 */
async function extractInvokeErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: InvokeErrorContext } | null)?.context;
  if (context?.json) {
    try {
      const body = await context.json();
      const message =
        body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      if (typeof message === "string" && message.trim()) return message;
    } catch {
      // Corpo não é JSON válido — cai no fallback abaixo.
    }
  }
  if (context?.status === 429) return RATE_LIMIT_FALLBACK_MESSAGE;
  return GENERIC_SUBMIT_ERROR;
}

function PublicLeadFormPage() {
  const { formId } = Route.useParams();

  const formQuery = useQuery({
    queryKey: ["public-lead-form", formId],
    queryFn: async (): Promise<PublicLeadForm | null> => {
      const { data, error } = await supabase
        .rpc("get_public_lead_form", { p_form_id: formId })
        .maybeSingle();
      // formId malformado (ex.: colaram o slug `/f/meu-form` em vez do UUID)
      // faz o Postgres devolver 22P02 (invalid input syntax for type uuid).
      // Isso NÃO é falha de infra — é um id que não corresponde a form algum;
      // tratamos como inexistente (null -> "Formulário indisponível"). Sem
      // isto o erro sobe pro errorComponent global (throwOnError, router.tsx)
      // e o visitante vê "Algo deu errado" numa página pública de captura.
      if (error?.code === "22P02") return null;
      // Erro real (rede/Supabase) propaga pro react-query — marca isError,
      // habilita retry, nunca é confundido com "formulário não existe".
      if (error) throw error;
      // A RPC só devolve linha p/ formulários ativos; ausência (data null)
      // cobre "não existe" e "inativo" sem vazar qual dos dois é o motivo.
      if (!data) return null;
      return { ...data, fields: parseLeadFormFields(data.fields) };
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-lg">
        {formQuery.isLoading ? (
          <CardContent className="py-10 text-center text-body text-muted-foreground">
            Carregando formulário…
          </CardContent>
        ) : formQuery.isError ? (
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CardTitle className="text-card-title">Erro ao carregar</CardTitle>
            <p className="text-body text-muted-foreground">
              Não foi possível carregar este formulário agora.
            </p>
            <Button variant="secondary" onClick={() => formQuery.refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        ) : !formQuery.data ? (
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <CardTitle className="text-card-title">Formulário indisponível</CardTitle>
            <p className="text-body text-muted-foreground">
              Este formulário não existe ou não está mais recebendo submissões.
            </p>
          </CardContent>
        ) : (
          <LeadFormBody formId={formId} form={formQuery.data} />
        )}
      </Card>
    </div>
  );
}

function LeadFormBody({ formId, form }: { formId: string; form: PublicLeadForm }) {
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const schema = buildFieldsSchema(form.fields);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FieldValues>({
    resolver: zodResolver(schema) as unknown as Resolver<FieldValues>,
    defaultValues: buildDefaultValues(form.fields),
  });

  const onSubmit: SubmitHandler<FieldValues> = async (values) => {
    const payload = buildSubmissionPayload(form.fields, values);
    const { data, error } = await supabase.functions.invoke("lead-form-submit", {
      body: { form_id: formId, data: payload },
    });
    if (error) {
      toast.error(await extractInvokeErrorMessage(error));
      return;
    }
    const message = (data as { message?: string } | null)?.message;
    setSuccessMessage(message || form.success_message || DEFAULT_SUCCESS_MESSAGE);
  };

  if (successMessage) {
    return (
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <CardTitle className="text-card-title">Obrigado!</CardTitle>
        <p className="text-body text-muted-foreground">{successMessage}</p>
      </CardContent>
    );
  }

  return (
    <>
      <CardHeader>
        <CardTitle>{form.name}</CardTitle>
        <CardDescription>Preencha os campos abaixo para entrar em contato.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {form.fields.map((field) => (
            <DynamicField
              key={field.key}
              field={field}
              register={register}
              control={control}
              errorMessage={errors[field.key]?.message as string | undefined}
            />
          ))}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Enviando…" : "Enviar"}
          </Button>
        </form>
      </CardContent>
    </>
  );
}

function DynamicField({
  field,
  register,
  control,
  errorMessage,
}: {
  field: LeadFormField;
  register: ReturnType<typeof useForm<FieldValues>>["register"];
  control: ReturnType<typeof useForm<FieldValues>>["control"];
  errorMessage: string | undefined;
}) {
  const fieldId = `lead-field-${field.key}`;
  const labelText = field.required ? `${field.label} *` : field.label;

  if (field.type === "boolean") {
    return (
      <div className="space-y-1.5">
        <Controller
          name={field.key}
          control={control}
          render={({ field: rhf }) => (
            <label htmlFor={fieldId} className="flex items-center gap-2">
              <Checkbox
                id={fieldId}
                checked={rhf.value === true}
                onCheckedChange={(checked) => rhf.onChange(checked === true)}
              />
              <span className="text-body text-foreground">{labelText}</span>
            </label>
          )}
        />
        {errorMessage && <p className="text-caption text-destructive">{errorMessage}</p>}
      </div>
    );
  }

  const inputType = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{labelText}</Label>
      <Input id={fieldId} type={inputType} aria-invalid={!!errorMessage} {...register(field.key)} />
      {errorMessage && <p className="text-caption text-destructive">{errorMessage}</p>}
    </div>
  );
}
