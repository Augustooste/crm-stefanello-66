/** Presentation-only compatibility for the historical company name; never writes tenant data. */
export function displayBrandName(name: string): string {
  return /^(?:Laticínios?\s+)?Stefanello(?:\s*[—/-]\s*Laticínios e embutidos)?$/i.test(name.trim())
    ? "Laticínio Stefanello"
    : name;
}
