import { agendaEngine } from "./agenda/manifest";
import { companiesEngine } from "./companies/manifest";
import { productsEngine } from "./products/manifest";
import { createEngineRegistry } from "@/kernel/engines/registry";
import { crmEngine } from "./crm/manifest";
import { aiEngine } from "./ai/manifest";
import { nurtureEngine } from "./nurture/manifest";
import { analyticsEngine } from "./analytics/manifest";
import { calendarEngine } from "./calendar/manifest";

/** Build-time registry. Importing this module validates every manifest. */
export const engineRegistry = createEngineRegistry([
  crmEngine,
  calendarEngine,
  companiesEngine,
  productsEngine,
  agendaEngine,
  aiEngine,
  nurtureEngine,
  analyticsEngine,
]);
