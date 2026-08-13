import { readFileSync } from "node:fs";
import { buildModelPlan, catalogFromRegistry } from "../src/lib/catalog";

const registry = JSON.parse(readFileSync(process.argv[2], "utf8"));
const plan = buildModelPlan(catalogFromRegistry(registry), ["vocals"]);
if (plan.length !== 1 || plan[0].modelName !== "Becruily Deux") {
  throw new Error(`Expected Becruily Deux, received ${JSON.stringify(plan)}`);
}
if (plan[0].artifacts?.length !== 2) {
  throw new Error(`Expected two verified registry artifacts, received ${JSON.stringify(plan[0])}`);
}
console.log(JSON.stringify(plan[0], null, 2));
