import { useEffect, useState } from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { useCurrentProfile } from "@/lib/api/session";
import { useTenantOnboarding } from "@/lib/api/onboarding";
import { useConsentAcknowledged } from "@/components/common/ConsentModal";

/**
 * Auto-opens the onboarding wizard when an admin belongs to a tenant whose
 * onboarded_at is NULL. Clicking "Refazer configuração" in /configuracoes
 * resets onboarded_at → the gate reopens the wizard automatically on the
 * next query refresh. Dismissal (X / esc) is remembered until onboarded_at
 * flips again, so we don't nag mid-session.
 */
export function OnboardingGate() {
  const { data: profile } = useCurrentProfile();
  const { data: tenant, isLoading } = useTenantOnboarding();
  // O aviso de privacidade é modal: abrir o assistente por cima empilha dois
  // diálogos e nenhum dos dois recebe clique. Espera o aceite.
  const consentAcknowledged = useConsentAcknowledged();
  const [open, setOpen] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<string | "never" | null>(null);

  const isAdmin = profile?.role === "admin";
  const needsOnboarding = tenant != null && tenant.onboarded_at == null;
  // Auto-open unless the user has already dismissed the wizard for the
  // current "needs onboarding" streak. We key the dismissal on tenant id +
  // onboarded_at, so resetting onboarded_at (Refazer) makes the wizard
  // reappear without a page reload.
  const dismissKey = tenant ? `${tenant.id}:${tenant.onboarded_at ?? "null"}` : null;
  const shouldAutoOpen =
    !isLoading && isAdmin && consentAcknowledged && needsOnboarding && dismissedAt !== dismissKey;

  useEffect(() => {
    if (shouldAutoOpen && !open) setOpen(true);
  }, [shouldAutoOpen, open]);

  if (!isAdmin) return null;
  if (!consentAcknowledged) return null;
  if (!needsOnboarding && !open) return null;

  return (
    <OnboardingWizard
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setDismissedAt(dismissKey ?? "never");
      }}
    />
  );
}
