import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

export type BusinessHours = Record<string, { enabled: boolean; open: string; close: string }>;

export type BusinessProfile = {
  segment: string;
  city: string;
  team: string[];
  human_handoff_owner: string;
  assistant_name: string;
  hours: BusinessHours;
  offerings: { name: string; price?: string }[];
  price_range: string;
  portfolio_url: string;
};

const WEEKDAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Segunda" },
  { key: "tue", label: "Terça" },
  { key: "wed", label: "Quarta" },
  { key: "thu", label: "Quinta" },
  { key: "fri", label: "Sexta" },
  { key: "sat", label: "Sábado" },
  { key: "sun", label: "Domingo" },
];

export function emptyBusinessProfile(): BusinessProfile {
  return {
    segment: "",
    city: "",
    team: [],
    human_handoff_owner: "",
    assistant_name: "",
    hours: WEEKDAYS.reduce((acc, d) => {
      acc[d.key] = {
        enabled: d.key !== "sat" && d.key !== "sun",
        open: "09:00",
        close: "18:00",
      };
      return acc;
    }, {} as BusinessHours),
    offerings: [],
    price_range: "",
    portfolio_url: "",
  };
}

export function normalizeBusinessProfile(raw: unknown): BusinessProfile {
  const base = emptyBusinessProfile();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  return {
    ...base,
    ...r,
    team: Array.isArray(r.team) ? (r.team as string[]) : base.team,
    offerings: Array.isArray(r.offerings)
      ? (r.offerings as { name: string; price?: string }[])
      : base.offerings,
    hours:
      r.hours && typeof r.hours === "object"
        ? { ...base.hours, ...(r.hours as BusinessHours) }
        : base.hours,
  } as BusinessProfile;
}

export function BusinessProfileForm({
  value,
  onChange,
  showHelp = true,
  hideSegment = false,
}: {
  value: BusinessProfile;
  onChange: (v: BusinessProfile) => void;
  showHelp?: boolean;
  hideSegment?: boolean;
}) {
  const [teamInput, setTeamInput] = useState("");
  const [offeringName, setOfferingName] = useState("");
  const [offeringPrice, setOfferingPrice] = useState("");

  const set = <K extends keyof BusinessProfile>(k: K, v: BusinessProfile[K]) =>
    onChange({ ...value, [k]: v });

  const addTeamMember = () => {
    const t = teamInput.trim();
    if (!t || value.team.includes(t)) return;
    set("team", [...value.team, t]);
    setTeamInput("");
  };

  const addOffering = () => {
    const n = offeringName.trim();
    if (!n) return;
    set("offerings", [...value.offerings, { name: n, price: offeringPrice.trim() || undefined }]);
    setOfferingName("");
    setOfferingPrice("");
  };

  return (
    <div className="space-y-6">
      {showHelp && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-caption text-muted-foreground">
          Esses dados ensinam a assistente de IA sobre o seu negócio — quanto mais completo,
          melhores as respostas.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {!hideSegment && (
          <div className="space-y-1.5">
            <Label htmlFor="bp-segment">Segmento</Label>
            <Input
              id="bp-segment"
              value={value.segment}
              onChange={(e) => set("segment", e.target.value)}
              placeholder="Ex.: clínica odontológica, marcenaria"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="bp-city">Cidade</Label>
          <Input
            id="bp-city"
            value={value.city}
            onChange={(e) => set("city", e.target.value)}
            placeholder="Ex.: São Paulo — SP"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Time de atendimento</Label>
        <div className="flex flex-wrap gap-2 rounded-md border border-border p-2 min-h-[44px]">
          {value.team.length === 0 && (
            <span className="text-caption text-muted-foreground px-1">
              Nenhum membro adicionado ainda.
            </span>
          )}
          {value.team.map((m) => (
            <span
              key={m}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-caption"
            >
              {m}
              <button
                type="button"
                onClick={() =>
                  set(
                    "team",
                    value.team.filter((x) => x !== m),
                  )
                }
                aria-label={`Remover ${m}`}
                className="hover:text-destructive"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={teamInput}
            onChange={(e) => setTeamInput(e.target.value)}
            placeholder="Nome do membro"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTeamMember();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addTeamMember}>
            Adicionar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bp-owner">Responsável pelo atendimento humano</Label>
          <Input
            id="bp-owner"
            value={value.human_handoff_owner}
            onChange={(e) => set("human_handoff_owner", e.target.value)}
            placeholder="Ex.: Ana (WhatsApp 11 9…)"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bp-assistant">Nome da assistente virtual</Label>
          <Input
            id="bp-assistant"
            value={value.assistant_name}
            onChange={(e) => set("assistant_name", e.target.value)}
            placeholder="Ex.: Sofia"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Horário de funcionamento</Label>
        <div className="rounded-md border border-border">
          {WEEKDAYS.map((d, i) => {
            const day = value.hours[d.key] ?? { enabled: false, open: "09:00", close: "18:00" };
            return (
              <div
                key={d.key}
                className={`flex flex-wrap items-center gap-3 p-3 ${i < WEEKDAYS.length - 1 ? "border-b border-border" : ""}`}
              >
                <label className="flex items-center gap-2 text-body cursor-pointer w-28">
                  <Checkbox
                    checked={day.enabled}
                    onCheckedChange={(v) =>
                      set("hours", { ...value.hours, [d.key]: { ...day, enabled: !!v } })
                    }
                  />
                  {d.label}
                </label>
                <Input
                  type="time"
                  value={day.open}
                  disabled={!day.enabled}
                  className="w-32"
                  onChange={(e) =>
                    set("hours", { ...value.hours, [d.key]: { ...day, open: e.target.value } })
                  }
                />
                <span className="text-caption text-muted-foreground">até</span>
                <Input
                  type="time"
                  value={day.close}
                  disabled={!day.enabled}
                  className="w-32"
                  onChange={(e) =>
                    set("hours", { ...value.hours, [d.key]: { ...day, close: e.target.value } })
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Produtos / serviços</Label>
        <div className="rounded-md border border-border divide-y divide-border">
          {value.offerings.length === 0 && (
            <div className="p-3 text-caption text-muted-foreground">
              Nenhum item adicionado ainda.
            </div>
          )}
          {value.offerings.map((o, i) => (
            <div key={`${o.name}-${i}`} className="flex items-center gap-3 p-3">
              <div className="flex-1">
                <div className="text-body">{o.name}</div>
                {o.price && <div className="text-caption text-muted-foreground">{o.price}</div>}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remover ${o.name}`}
                onClick={() =>
                  set(
                    "offerings",
                    value.offerings.filter((_, idx) => idx !== i),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px_auto]">
          <Input
            value={offeringName}
            onChange={(e) => setOfferingName(e.target.value)}
            placeholder="Nome do produto ou serviço"
          />
          <Input
            value={offeringPrice}
            onChange={(e) => setOfferingPrice(e.target.value)}
            placeholder="Preço (opcional)"
          />
          <Button type="button" variant="outline" onClick={addOffering}>
            <Plus className="mr-1 h-4 w-4" /> Adicionar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bp-price">Faixa de preço geral</Label>
          <Input
            id="bp-price"
            value={value.price_range}
            onChange={(e) => set("price_range", e.target.value)}
            placeholder="Ex.: R$ 200 a R$ 1.500"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bp-portfolio">Link de portfólio / site</Label>
          <Input
            id="bp-portfolio"
            value={value.portfolio_url}
            onChange={(e) => set("portfolio_url", e.target.value)}
            placeholder="https://…"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bp-notes">Observações adicionais</Label>
        <Textarea
          id="bp-notes"
          rows={3}
          value={(value as unknown as { notes?: string }).notes ?? ""}
          onChange={(e) =>
            onChange({ ...value, notes: e.target.value } as BusinessProfile & { notes: string })
          }
          placeholder="Qualquer detalhe que ajude a IA a responder melhor."
        />
      </div>
    </div>
  );
}
