import { APP_URLS } from "../../constants";
import { registerLinkCoverage } from "../lib/link-coverage";

// Twenty keeps a GraphQL-subscriptions websocket open after login, so the
// page never reaches `networkidle`. `load` is Playwright's recommended
// strategy for SPAs with persistent connections.
registerLinkCoverage({
  appName: "Twenty (CRM)",
  baseUrl: APP_URLS.Twenty,
  waitUntil: "load",
});
