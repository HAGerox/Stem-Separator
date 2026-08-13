import { readFileSync } from "node:fs";
import { buildModelPlan, catalogFromRegistry } from "../src/lib/catalog";

const registry = JSON.parse(readFileSync(process.argv[2], "utf8"));
const catalog = catalogFromRegistry(registry);
const plan = buildModelPlan(catalog, ["vocals"]);
if (plan.length !== 1 || plan[0].modelName !== "Becruily Deux") {
  throw new Error(`Expected Becruily Deux, received ${JSON.stringify(plan)}`);
}
if (plan[0].artifacts?.length !== 2) {
  throw new Error(`Expected two verified registry artifacts, received ${JSON.stringify(plan[0])}`);
}
const specialists = buildModelPlan(catalog, ["vocals", "drums"]);
if (specialists.length !== 2 || specialists[0].stems.join() !== "vocals" || specialists[1].stems.join() !== "drums") {
  throw new Error(`Expected independent specialist passes for vocals and drums, received ${JSON.stringify(specialists)}`);
}
const multitrack = buildModelPlan(catalog, ["vocals", "drums", "bass", "guitar", "piano", "other"], true);
if (multitrack.length !== 1 || multitrack[0].stems.length !== 6) {
  throw new Error(`Expected one coherent six-stem pass, received ${JSON.stringify(multitrack)}`);
}
const manualSix = buildModelPlan(catalog, ["vocals", "drums", "bass", "guitar", "piano", "other"]);
if (manualSix.length < 2 || manualSix[0].stems.length === 6) {
  throw new Error(`Manual stem choices must stay specialist-routed, received ${JSON.stringify(manualSix)}`);
}
console.log(JSON.stringify(plan[0], null, 2));
