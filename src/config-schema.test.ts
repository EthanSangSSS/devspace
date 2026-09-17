import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  devspaceConfigJsonSchema,
  devspaceConfigSchema,
} from "./config-schema.js";

assert.throws(
  () => devspaceConfigSchema.parse({ configVersion: 1, typo: true }),
  /Unrecognized key/,
);

for (const field of ["model", "effort", "compatibleVersions"] as const) {
  assert.throws(
    () => devspaceConfigSchema.parse({
      configVersion: 1,
      agyDelegation: { [field]: "   \t" },
    }),
  );
}

const preservedAgyPolicy = devspaceConfigSchema.parse({
  configVersion: 1,
  agyDelegation: {
    model: " gemini-next-qualified ",
    effort: "\tmedium ",
    compatibleVersions: " >=1.1.22 <2.0.0 ",
  },
});
assert.equal(preservedAgyPolicy.agyDelegation.model, " gemini-next-qualified ");
assert.equal(preservedAgyPolicy.agyDelegation.effort, "\tmedium ");
assert.equal(preservedAgyPolicy.agyDelegation.compatibleVersions, " >=1.1.22 <2.0.0 ");

const generatedSchema = `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`;
const committedSchema = readFileSync(
  new URL("../schema/v1/devspace.schema.json", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.equal(committedSchema, generatedSchema, "run `npm run schema:config` after changing config-schema.ts");

console.log("config schema tests passed");
