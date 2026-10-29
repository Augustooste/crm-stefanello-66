import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { useInboundEvents, type InboundEvent } from "@/lib/api/inbound-rules";
import { renderWithQueryClient } from "@/test/render";
import { formatDateTime } from "./format";
import { InboundEventsDialog } from "./InboundEventsDialog";
import { queryResult } from "./test-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});
vi.mock("@/lib/api/inbound-rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/inbound-rules")>()),
  useInboundEvents: vi.fn(),
}));

const EVENT: InboundEvent = {
  id: "ev1",
  ruleId: "r1",
  externalEventId: "evt_1",
  status: "processed",
  attempts: 1,
  actionTaken: "mark_won",
  dealId: null,
  errorCode: null,
  extracted: null,
  receivedAt: "2026-10-22T10:00:00Z",
  processedAt: "2026-10-22T10:00:01Z",
  duplicateCount: 0,
  lastDuplicateAt: null,
};

function show(events: InboundEvent[]) {
  vi.mocked(useInboundEvents).mockReturnValue(
    queryResult(events) as unknown as ReturnType<typeof useInboundEvents>,
  );
  renderWithQueryClient(
    <InboundEventsDialog ruleId="r1" ruleName="Stripe" open onOpenChange={vi.fn()} />,
  );
}

describe("InboundEventsDialog: reenvios (v2.1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sem reenvio não mostra nada a mais", () => {
    show([EVENT]);
    expect(screen.getByText("evt_1")).toBeInTheDocument();
    expect(screen.queryByText(/Reenviado/)).toBeNull();
  });

  it("mostra quantas vezes o gateway reenviou e quando foi o último", () => {
    const last = "2026-10-22T11:30:00Z";
    show([
      { ...EVENT, id: "a", externalEventId: "evt_a", duplicateCount: 3, lastDuplicateAt: last },
      { ...EVENT, id: "b", externalEventId: "evt_b", duplicateCount: 1, lastDuplicateAt: last },
    ]);
    expect(
      screen.getByText(`Reenviado 3 vezes (último em ${formatDateTime(last, "-")})`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Reenviado 1 vez (último em ${formatDateTime(last, "-")})`),
    ).toBeInTheDocument();
  });

  it("sem data do último reenvio mostra só a contagem", () => {
    show([{ ...EVENT, duplicateCount: 2, lastDuplicateAt: null }]);
    expect(screen.getByText("Reenviado 2 vezes")).toBeInTheDocument();
  });
});

describe("InboundEventsDialog: motivo da perda (v2.2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mostra extracted.reason quando existe e ignora vazio ou não texto", () => {
    show([
      {
        ...EVENT,
        id: "a",
        actionTaken: "mark_lost",
        extracted: { conditions_ok: true, reason: "Pagamento recusado" },
      },
      { ...EVENT, id: "b", extracted: { reason: "  " } },
      { ...EVENT, id: "c", extracted: { reason: 42 } },
    ]);
    expect(screen.getAllByText(/Motivo da perda/)).toHaveLength(1);
    expect(screen.getByText("Motivo da perda: Pagamento recusado")).toBeInTheDocument();
  });

  it("renderiza HTML no motivo como texto, sem criar elementos", () => {
    const payload = "<img src=x onerror=alert(1)>";
    show([{ ...EVENT, id: "x", extracted: { reason: payload } }]);
    expect(screen.getByText(`Motivo da perda: ${payload}`)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
