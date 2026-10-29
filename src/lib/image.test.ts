import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeImageFile } from "./image";

type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };
type FakeCtx = { drawImage: ReturnType<typeof vi.fn> };
type FakeCanvas = {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
};

function makeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

function makeCanvas(ctx: FakeCtx | null, blob: Blob | null): FakeCanvas {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toBlob: vi.fn((cb: (b: Blob | null) => void) => cb(blob)),
  };
}

const PNG_FILE = () => new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });

describe("resizeImageFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retorna o arquivo original para não-imagens", async () => {
    const file = new File(["abc"], "doc.pdf", { type: "application/pdf" });
    expect(await resizeImageFile(file)).toBe(file);
  });

  it("retorna o arquivo original para SVG (vetorial)", async () => {
    const file = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    expect(await resizeImageFile(file)).toBe(file);
  });

  it("faz fallback ao original quando canvas/createImageBitmap indisponível (jsdom)", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    // jsdom não implementa createImageBitmap → helper deve retornar o mesmo File.
    expect(await resizeImageFile(file)).toBe(file);
  });

  it("faz fallback ao original quando createImageBitmap lança (catch geral)", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode falhou")));
    const file = PNG_FILE();
    const result = await resizeImageFile(file);
    expect(result).toBe(file);
  });

  it("retorna o arquivo original quando a imagem já é pequena o bastante (scale >= 1)", async () => {
    const bitmap = makeBitmap(50, 40);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const file = PNG_FILE();

    const result = await resizeImageFile(file, 256);

    expect(result).toBe(file);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("redimensiona e retorna um File WebP quando a imagem excede maxSize", async () => {
    const bitmap = makeBitmap(1000, 500);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const blob = new Blob(["webp-bytes"], { type: "image/webp" });
    const ctx: FakeCtx = { drawImage: vi.fn() };
    const canvas = makeCanvas(ctx, blob);
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockReturnValue(canvas as unknown as HTMLCanvasElement);

    const file = PNG_FILE();
    const result = await resizeImageFile(file, 256, 0.8);

    expect(createElementSpy).toHaveBeenCalledWith("canvas");
    // scale = min(1, 256/1000) = 0.256 → 1000*0.256=256, 500*0.256=128
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
    expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 256, 128);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.8);
    expect(bitmap.close).toHaveBeenCalled();
    expect(result).not.toBe(file);
    expect(result.type).toBe("image/webp");
    expect(result.name).toBe("logo.webp");
  });

  it("troca só a extensão do nome ao gerar o WebP (arquivo com pontos no nome)", async () => {
    const bitmap = makeBitmap(1000, 1000);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const blob = new Blob(["webp-bytes"], { type: "image/webp" });
    const canvas = makeCanvas({ drawImage: vi.fn() }, blob);
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const file = new File([new Uint8Array([1, 2, 3])], "minha.logo.antiga.png", {
      type: "image/png",
    });

    const result = await resizeImageFile(file, 100);

    expect(result.name).toBe("minha.logo.antiga.webp");
  });

  it("retorna o arquivo original quando getContext('2d') retorna null", async () => {
    const bitmap = makeBitmap(1000, 1000);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const canvas = makeCanvas(null, null);
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLCanvasElement);

    const file = PNG_FILE();
    const result = await resizeImageFile(file, 256);

    expect(result).toBe(file);
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });

  it("retorna o arquivo original quando toBlob resolve null", async () => {
    const bitmap = makeBitmap(1000, 1000);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const canvas = makeCanvas({ drawImage: vi.fn() }, null);
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLCanvasElement);

    const file = PNG_FILE();
    const result = await resizeImageFile(file, 256);

    expect(result).toBe(file);
  });
});
