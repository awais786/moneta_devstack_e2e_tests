import { APP_URLS } from "../../constants";
import { registerLinkCoverage } from "../lib/link-coverage";

registerLinkCoverage({ appName: "Twenty (CRM)", baseUrl: APP_URLS.Twenty });
