import { request } from "./client.ts";
import type { EffectiveSettings } from "../../../shared/settings.ts";
export type { EffectiveSettings } from "../../../shared/settings.ts";

export const settingsApi = {
  read(): Promise<{ settings: EffectiveSettings }> { return request("GET", "/api/settings"); },
};
