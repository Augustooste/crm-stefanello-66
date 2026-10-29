import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2,
  Check,
  ChevronsUpDown,
  Plus,
  Upload,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import {
  uploadContactAvatar,
  removeContactAvatar,
  useContactAvatarUrl,
} from "@/lib/api/contact-avatar";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { usePluginActive } from "@/lib/api/plugins";
import { cn } from "@/lib/utils";
import { CompanyFormDialog, type CompanyRow } from "@/components/companies/CompanyFormDialog";

export type ContactRow = {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  tags: string[];
  notes: string | null;
  ai_paused: boolean;
  created_at: string;
  company_id?: string | null;
  status?: string | null;
  job_title?: string | null;
  department?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_zip?: string | null;
  address_country?: string | null;
  birthday?: string | null;
  website?: string | null;
  instagram?: string | null;
  linkedin?: string | null;
  description?: string | null;
  avatar_url?: string | null;
};

type CompanyOption = Pick<CompanyRow, "id" | "name">;
type StatusOption = { slug: string; label: string; color: string };

const origins = ["Site", "Indicação", "WhatsApp", "Instagram", "Evento", "Outro"] as const;
const suggestedTags = ["Quente", "Frio", "Indicação", "Site", "VIP"];

const schema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  phone: z.string().optional(),
  email: z.string().email("E-mail inválido").optional().or(z.literal("")),
  source: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
  job_title: z.string().optional(),
  department: z.string().optional(),
  address_street: z.string().optional(),
  address_city: z.string().optional(),
  address_state: z.string().optional(),
  address_zip: z.string().optional(),
  address_country: z.string().optional(),
  birthday: z.string().optional(),
  website: z.string().url("URL inválida").optional().or(z.literal("")),
  instagram: z.string().optional(),
  linkedin: z.string().url("URL inválida").optional().or(z.literal("")),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export function ContactFormDialog({
  open,
  onOpenChange,
  contact,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact?: ContactRow;
}) {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const companiesActive = usePluginActive("companies");
  const [tags, setTags] = useState<string[]>(contact?.tags ?? []);
  const [customTag, setCustomTag] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(contact?.company_id ?? null);
  const [companyPopoverOpen, setCompanyPopoverOpen] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [openNewCompany, setOpenNewCompany] = useState(false);
  const [avatarPath, setAvatarPath] = useState<string | null>(contact?.avatar_url ?? null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editing = !!contact;
  const savedAvatarQuery = useContactAvatarUrl(
    !avatarRemoved && !avatarPreview ? avatarPath : null,
  );

  const companiesQuery = useQuery({
    queryKey: ["companies-lite", profile?.tenant_id],

    enabled: !!profile && companiesActive,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_companies")
        .select("id, name")
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as CompanyOption[];
    },
  });
  const companies = companiesQuery.data ?? [];
  const selectedCompany = companies.find((c) => c.id === companyId) ?? null;

  const statusesQuery = useQuery({
    queryKey: ["contact-statuses", profile?.tenant_id],
    enabled: !!profile,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_statuses")
        .select("slug, label, color")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as StatusOption[];
    },
  });
  const statuses = statusesQuery.data ?? [];

  const emptyDefaults: FormValues = {
    name: "",
    phone: "",
    email: "",
    source: "Site",
    notes: "",
    status: "lead",
    job_title: "",
    department: "",
    address_street: "",
    address_city: "",
    address_state: "",
    address_zip: "",
    address_country: "",
    birthday: "",
    website: "",
    instagram: "",
    linkedin: "",
    description: "",
  };
  const buildDefaults = (c?: ContactRow): FormValues => ({
    ...emptyDefaults,
    name: c?.name ?? "",
    phone: c?.phone ?? "",
    email: c?.email ?? "",
    source: c?.source ?? "Site",
    notes: c?.notes ?? "",
    status: c?.status ?? "lead",
    job_title: c?.job_title ?? "",
    department: c?.department ?? "",
    address_street: c?.address_street ?? "",
    address_city: c?.address_city ?? "",
    address_state: c?.address_state ?? "",
    address_zip: c?.address_zip ?? "",
    address_country: c?.address_country ?? "",
    birthday: c?.birthday ?? "",
    website: c?.website ?? "",
    instagram: c?.instagram ?? "",
    linkedin: c?.linkedin ?? "",
    description: c?.description ?? "",
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: buildDefaults(contact),
  });

  useEffect(() => {
    if (open) {
      reset(buildDefaults(contact));
      setTags(contact?.tags ?? []);
      setCustomTag("");
      setCompanyId(contact?.company_id ?? null);
      setCompanySearch("");
      setAvatarPath(contact?.avatar_url ?? null);
      setAvatarFile(null);
      setAvatarPreview(null);
      setAvatarRemoved(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact, reset]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const mutation = useMutation({
    mutationFn: async (data: FormValues) => {
      if (!profile) throw new Error("Sessão inválida");
      const payload = {
        name: data.name,
        phone: data.phone || null,
        email: data.email || null,
        source: data.source || null,
        notes: data.notes || null,
        tags,
        company_id: companyId,
        status: data.status || "lead",
        job_title: data.job_title || null,
        department: data.department || null,
        address_street: data.address_street || null,
        address_city: data.address_city || null,
        address_state: data.address_state || null,
        address_zip: data.address_zip || null,
        address_country: data.address_country || null,
        birthday: data.birthday || null,
        website: data.website || null,
        instagram: data.instagram || null,
        linkedin: data.linkedin || null,
        description: data.description || null,
      };

      let contactId = contact?.id ?? null;
      if (editing && contact) {
        const { error } = await supabase.from("contacts").update(payload).eq("id", contact.id);
        if (error) throw error;
      } else {
        const { data: inserted, error } = await supabase
          .from("contacts")
          .insert({ ...payload, tenant_id: profile.tenant_id })
          .select("id")
          .single();
        if (error) throw error;
        contactId = inserted.id;
      }

      // Handle avatar changes
      if (contactId) {
        if (avatarRemoved && avatarPath) {
          try {
            await removeContactAvatar(avatarPath);
          } catch {
            /* ignore missing */
          }
          await supabase.from("contacts").update({ avatar_url: null }).eq("id", contactId);
        }
        if (avatarFile) {
          const newPath = await uploadContactAvatar({
            tenantId: profile.tenant_id,
            contactId,
            file: avatarFile,
          });
          await supabase.from("contacts").update({ avatar_url: newPath }).eq("id", contactId);
        }
      }
    },

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact", contact?.id] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      const oldCompanyId = contact?.company_id ?? null;
      const newCompanyId = companyId;
      if (oldCompanyId !== newCompanyId) {
        if (oldCompanyId) qc.invalidateQueries({ queryKey: ["company-contacts", oldCompanyId] });
        if (newCompanyId) qc.invalidateQueries({ queryKey: ["company-contacts", newCompanyId] });
        qc.invalidateQueries({ queryKey: ["company-deals"] });
      }
      toast.success(editing ? "Contato atualizado" : "Contato criado");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao salvar"),
  });

  const source = watch("source");
  const statusValue = watch("status");

  const addCustomTag = () => {
    const t = customTag.trim();
    if (t && !tags.includes(t)) setTags((p) => [...p, t]);
    setCustomTag("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar contato" : "Novo contato"}</DialogTitle>
          <DialogDescription>Preencha as informações do contato.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-border bg-muted flex items-center justify-center">
              {avatarPreview ? (
                <img src={avatarPreview} alt="" className="h-full w-full object-cover" />
              ) : !avatarRemoved && savedAvatarQuery.data ? (
                <img src={savedAvatarQuery.data} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserIcon className="h-7 w-7 text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 5 * 1024 * 1024) {
                    toast.error("Imagem deve ter até 5 MB");
                    return;
                  }
                  setAvatarFile(f);
                  setAvatarRemoved(false);
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4 mr-1.5" /> Enviar foto
                </Button>
                {(avatarPath || avatarFile) && !avatarRemoved && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setAvatarFile(null);
                      setAvatarRemoved(true);
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" /> Remover
                  </Button>
                )}
              </div>
              <p className="text-caption text-muted-foreground">JPG/PNG, até 5 MB.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="name">Nome *</Label>
            <Input id="name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Telefone</Label>
              <Input id="phone" {...register("phone")} placeholder="(11) 99999-0000" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" {...register("email")} aria-invalid={!!errors.email} />
              {errors.email && (
                <p className="text-caption text-destructive">{errors.email.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Origem</Label>
              <Select value={source} onValueChange={(v) => setValue("source", v)}>
                <SelectTrigger aria-label="Origem">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {origins.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Situação</Label>
              <Select value={statusValue ?? "lead"} onValueChange={(v) => setValue("status", v)}>
                <SelectTrigger aria-label="Situação">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((s) => (
                    <SelectItem key={s.slug} value={s.slug}>
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        {s.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {companiesActive && (
            <div className="space-y-1.5">
              <Label htmlFor="company-combobox-trigger">Empresa</Label>
              <Popover open={companyPopoverOpen} onOpenChange={setCompanyPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="company-combobox-trigger"
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-label="Empresa"
                    aria-expanded={companyPopoverOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {selectedCompany?.name ?? "Sem empresa"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Buscar empresa…"
                      value={companySearch}
                      onValueChange={setCompanySearch}
                    />
                    <CommandList>
                      <CommandEmpty>Nenhuma empresa encontrada.</CommandEmpty>
                      <CommandGroup>
                        <CommandItem
                          value="__none__"
                          onSelect={() => {
                            setCompanyId(null);
                            setCompanyPopoverOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "h-4 w-4",
                              companyId === null ? "opacity-100" : "opacity-0",
                            )}
                          />
                          Sem empresa
                        </CommandItem>
                        {companies
                          .filter((c) =>
                            c.name.toLowerCase().includes(companySearch.trim().toLowerCase()),
                          )
                          .map((c) => (
                            <CommandItem
                              key={c.id}
                              value={c.id}
                              onSelect={() => {
                                setCompanyId(c.id);
                                setCompanyPopoverOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "h-4 w-4",
                                  companyId === c.id ? "opacity-100" : "opacity-0",
                                )}
                              />
                              {c.name}
                            </CommandItem>
                          ))}
                      </CommandGroup>
                      {companySearch.trim() && (
                        <CommandGroup>
                          <CommandItem
                            value="__create__"
                            onSelect={() => {
                              setCompanyPopoverOpen(false);
                              setOpenNewCompany(true);
                            }}
                          >
                            <Plus className="h-4 w-4" />
                            Criar empresa "{companySearch.trim()}"
                          </CommandItem>
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          )}

          {/* Cargo & departamento */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="job_title">Cargo</Label>
              <Input
                id="job_title"
                {...register("job_title")}
                placeholder="Ex: Diretor Comercial"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="department">Departamento</Label>
              <Input id="department" {...register("department")} placeholder="Ex: Vendas" />
            </div>
          </div>

          {/* Aniversário + site */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="birthday">Aniversário</Label>
              <Input id="birthday" type="date" {...register("birthday")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website">Site</Label>
              <Input
                id="website"
                type="url"
                {...register("website")}
                placeholder="https://…"
                aria-invalid={!!errors.website}
              />
              {errors.website && (
                <p className="text-caption text-destructive">{errors.website.message}</p>
              )}
            </div>
          </div>

          {/* Redes sociais */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="instagram">Instagram</Label>
              <Input id="instagram" {...register("instagram")} placeholder="@usuario" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="linkedin">LinkedIn</Label>
              <Input
                id="linkedin"
                type="url"
                {...register("linkedin")}
                placeholder="https://linkedin.com/in/…"
                aria-invalid={!!errors.linkedin}
              />
              {errors.linkedin && (
                <p className="text-caption text-destructive">{errors.linkedin.message}</p>
              )}
            </div>
          </div>

          {/* Endereço */}
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="text-caption font-medium text-muted-foreground">Endereço</div>
            <div className="space-y-1.5">
              <Label htmlFor="address_street">Rua / número</Label>
              <Input id="address_street" {...register("address_street")} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="address_city">Cidade</Label>
                <Input id="address_city" {...register("address_city")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="address_state">Estado</Label>
                <Input id="address_state" {...register("address_state")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="address_zip">CEP</Label>
                <Input id="address_zip" {...register("address_zip")} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="address_country">País</Label>
              <Input id="address_country" {...register("address_country")} placeholder="Brasil" />
            </div>
          </div>

          {/* Descrição livre */}
          <div className="space-y-1.5">
            <Label htmlFor="description">Descrição</Label>
            <Textarea
              id="description"
              rows={3}
              {...register("description")}
              placeholder="Contexto do contato, preferências, histórico…"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Etiquetas</Label>
            <div className="flex flex-wrap gap-3 rounded-md border border-border p-3">
              {Array.from(new Set([...suggestedTags, ...tags])).map((t) => {
                const checked = tags.includes(t);
                return (
                  <label key={t} className="flex items-center gap-2 text-body cursor-pointer">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setTags((prev) => (v ? [...prev, t] : prev.filter((x) => x !== t)))
                      }
                    />
                    {t}
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Adicionar etiqueta…"
                value={customTag}
                onChange={(e) => setCustomTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomTag();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={addCustomTag}>
                Adicionar
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notas</Label>
            <Textarea id="notes" rows={3} {...register("notes")} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Salvando…" : editing ? "Salvar" : "Criar contato"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <CompanyFormDialog
        open={openNewCompany}
        onOpenChange={setOpenNewCompany}
        defaultName={companySearch.trim()}
        onCreated={(created) => {
          qc.invalidateQueries({ queryKey: ["companies-lite"] });
          qc.invalidateQueries({ queryKey: ["companies"] });
          setCompanyId(created.id);
          setCompanySearch("");
        }}
      />
    </Dialog>
  );
}
