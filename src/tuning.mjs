import fs from "node:fs";
import { tuningCatalog } from "./paths.mjs";
import { CliError } from "./errors.mjs";

const PARAMETERS = ["preblur", "noise", "details", "halo", "blur", "compression"];

export function loadTuningCatalog() {
  const catalog = JSON.parse(fs.readFileSync(tuningCatalog, "utf8"));
  if (catalog.schema_version !== 1 || catalog.policy_id !== "proteus-advanced-v1") {
    throw new CliError("TUNING_CATALOG_INVALID", "The bundled advanced tuning catalog is invalid.");
  }
  for (const [id, profile] of Object.entries(catalog.profiles || {})) {
    for (const parameter of PARAMETERS) {
      const value = profile.relative_offsets?.[parameter];
      const bounds = catalog.parameter_bounds?.[parameter];
      if (!Number.isFinite(value) || !Array.isArray(bounds) || value < bounds[0] || value > bounds[1]) {
        throw new CliError("TUNING_CATALOG_INVALID", `Profile ${id} has an invalid ${parameter} value.`);
      }
    }
    const blendBounds = catalog.parameter_bounds?.blend;
    if (!Number.isFinite(profile.blend) || profile.blend < blendBounds[0] || profile.blend > blendBounds[1]) {
      throw new CliError("TUNING_CATALOG_INVALID", `Profile ${id} has an invalid blend value.`);
    }
  }
  return catalog;
}

export function resolveTuningProfile(id) {
  const catalog = loadTuningCatalog();
  const profile = catalog.profiles[id];
  if (!profile) throw new CliError("TUNING_PROFILE_UNSUPPORTED", `Unsupported advanced tuning profile: ${id}`);
  return { id, policy_id: catalog.policy_id, model: catalog.model, estimate_frames: catalog.estimate_frames, ...profile };
}
