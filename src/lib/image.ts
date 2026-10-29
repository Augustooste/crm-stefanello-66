/**
 * Redimensiona uma imagem no cliente antes do upload (canvas → WebP).
 * Evita subir originais gigantes (ex.: logo de 1.16MB) quando a UI só exibe
 * o asset em ~24–96px. Fallback defensivo: qualquer falha ou ambiente sem
 * canvas/createImageBitmap (jsdom, SSR) retorna o arquivo original intacto.
 */
export async function resizeImageFile(file: File, maxSize = 256, quality = 0.8): Promise<File> {
  try {
    // SVG é vetorial (leve) e não faz sentido rasterizar; não-imagens passam direto.
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return file;
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;

    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    // Já é pequena o suficiente — evita reencode desnecessário.
    if (scale >= 1) {
      bitmap.close?.();
      return file;
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    if (!blob) return file;

    const name = file.name.replace(/\.[^.]+$/, "") + ".webp";
    return new File([blob], name, { type: "image/webp" });
  } catch {
    return file;
  }
}
