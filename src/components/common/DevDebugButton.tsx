import { Bug } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useCurrentProfile } from "@/lib/api/session";

export function DevDebugButton() {
  const { data: profile } = useCurrentProfile();

  if (!import.meta.env.DEV) return null;

  const handleClick = () => {
    console.log("[DevDebugButton] profile:", profile, "tenant_id:", profile?.tenant_id);
    toast.info("Informações técnicas no console");
  };

  return (
    <Button
      variant="secondary"
      size="icon"
      className="fixed bottom-4 right-4 z-50 rounded-full shadow-md"
      onClick={handleClick}
      aria-label="Informações técnicas"
    >
      <Bug className="h-4 w-4" />
    </Button>
  );
}
