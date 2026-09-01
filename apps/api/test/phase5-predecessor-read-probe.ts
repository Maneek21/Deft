import assert from "node:assert/strict";
import { closeDb } from "../src/lib/db.js";
import {
  employeeModuleActor,
  getModuleRecord,
} from "../src/lib/module-service.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredDecodedBase64(name: string): string {
  return Buffer.from(required(name), "base64").toString("utf8");
}

async function main(): Promise<void> {
  const orgId = required("DEFT_PROBE_ORG_ID");
  const employeeId = required("DEFT_PROBE_EMPLOYEE_ID");
  const recordId = required("DEFT_PROBE_RECORD_ID");
  const expectedName = requiredDecodedBase64("DEFT_PROBE_NAME_BASE64");
  const expectedEmail = requiredDecodedBase64("DEFT_PROBE_EMAIL_BASE64");
  try {
    const record = await getModuleRecord(
      employeeModuleActor({
        orgId,
        employeeId,
        trustLevel: "standard",
        source: "runtime",
      }),
      recordId,
    );
    assert.equal(record.data.name, expectedName);
    assert.equal(record.data.email, expectedEmail);
    process.stdout.write(
      `${JSON.stringify({
        schema: "deft.app_platform.phase5.predecessor_read.v1",
        result: "passed",
        resource: {
          org_id: orgId,
          record_id: record.id,
          revision: record.revision,
          name: record.data.name,
        },
      })}\n`,
    );
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
