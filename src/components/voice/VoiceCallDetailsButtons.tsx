import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { VoiceCallRow } from "@/lib/api/voice-calls";

type View = "summary" | "transcript" | null;

/** Botões [Ver resumo] [Ver transcrição] do item "Ligação IA" da timeline. */
export function VoiceCallDetailsButtons({ call }: { call: VoiceCallRow }) {
  const [view, setView] = useState<View>(null);
  if (!call.summary && !call.transcript) return null;
  const text = view === "summary" ? call.summary : call.transcript;

  return (
    <div className="flex gap-2 pt-1">
      {call.summary && (
        <Button size="sm" variant="outline" onClick={() => setView("summary")}>
          Ver resumo
        </Button>
      )}
      {call.transcript && (
        <Button size="sm" variant="outline" onClick={() => setView("transcript")}>
          Ver transcrição
        </Button>
      )}
      <Dialog open={view !== null} onOpenChange={(o) => !o && setView(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{view === "summary" ? "Resumo da ligação" : "Transcrição"}</DialogTitle>
            <DialogDescription>Objetivo: {call.objective}</DialogDescription>
          </DialogHeader>
          <p className="max-h-96 overflow-y-auto whitespace-pre-wrap text-body">{text}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
