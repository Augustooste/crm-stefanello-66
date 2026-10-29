import { Moon, Palette, Sun } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";
import { isDarkSkin } from "@/lib/appearance-boot";
import { useAppearance, type Skin, type Theme } from "@/lib/useAppearance";

/**
 * Preferências de aparência (por usuário) — tema claro/escuro e visual da marca.
 * Consome o store compartilhado `useAppearance`, a mesma fonte dos toggles do
 * topbar, então mudar aqui reflete lá na hora (e vice-versa). Persiste no
 * <html> + localStorage, reaplicado antes do paint no root.
 */
export function AppearanceTab() {
  const { theme, skin, setTheme, setSkin } = useAppearance();
  // Profundo e Power trazem o próprio campo escuro: deixar o Tema clicável ali
  // seria oferecer uma escolha que a tela ignora. A preferência fica salva e
  // volta a valer quando o Visual for Clean.
  const temaDesabilitado = isDarkSkin(skin);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Palette className="h-4 w-4" aria-hidden />
          Aparência
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label id="aparencia-tema">Tema</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={theme}
            onValueChange={(v) => v && setTheme(v as Theme)}
            className="justify-start"
            aria-labelledby="aparencia-tema"
          >
            <ToggleGroupItem value="light" aria-label="Tema claro" disabled={temaDesabilitado}>
              <Sun className="mr-2 h-4 w-4" aria-hidden />
              Claro
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" aria-label="Tema escuro" disabled={temaDesabilitado}>
              <Moon className="mr-2 h-4 w-4" aria-hidden />
              Escuro
            </ToggleGroupItem>
          </ToggleGroup>
          {temaDesabilitado && (
            <p className="text-caption text-muted-foreground">
              O Visual escolhido abaixo tem campo escuro próprio, então o tema fica fixo. Volte para
              o Clean para escolher entre claro e escuro.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label id="aparencia-visual">Visual</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={skin}
            onValueChange={(v) => v && setSkin(v as Skin)}
            className="justify-start"
            aria-labelledby="aparencia-visual"
          >
            <ToggleGroupItem value="clean" aria-label="Visual Clean">
              Clean
            </ToggleGroupItem>
            <ToggleGroupItem value="profundo" aria-label="Visual Profundo">
              Profundo
            </ToggleGroupItem>
            <ToggleGroupItem value="power" aria-label="Visual Power">
              Power
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-caption text-muted-foreground">
            Clean acompanha o tema escolhido acima. Profundo (campo escuro do design system, com
            azul safira) e Power (fundo AMOLED com brilho neon) trazem o próprio fundo escuro e
            desligam a escolha de tema enquanto estiverem ativos.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
