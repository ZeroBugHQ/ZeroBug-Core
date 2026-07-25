// DANGER: this wipes every collection (projects, columns, tests, environments,
// reports) back to an empty workspace. It is NOT run automatically — the API
// server never deletes data on start/restart. To actually wipe, you must opt in:
//
//   npm run db:reset            (asks for --force)
//   node src/seed.js --force    (performs the wipe)
import mongoose from "mongoose";
import { connectDb } from "./db.js";
import { Project } from "./models/project.model.js";
import { Column } from "./models/column.model.js";
import { Test } from "./models/test.model.js";
import { Environment } from "./models/environment.model.js";
import { Report } from "./models/report.model.js";

const forced = process.argv.includes("--force");

async function run() {
  await connectDb();

  if (!forced) {
    const [projects, tests] = await Promise.all([
      Project.estimatedDocumentCount(),
      Test.estimatedDocumentCount(),
    ]);
    console.log(
      `\n⚠  This command DELETES ALL DATA (currently ${projects} project(s), ${tests} test(s)).\n` +
        `   It will NOT run without an explicit opt-in. To wipe, run:\n\n` +
        `     npm run db:reset -- --force\n` +
        `     (or)  node src/seed.js --force\n\n` +
        `   Nothing was deleted.`,
    );
    await mongoose.disconnect();
    return;
  }

  console.log("[reset] --force given — clearing all collections…");
  await Promise.all([
    Project.deleteMany({}),
    Column.deleteMany({}),
    Test.deleteMany({}),
    Environment.deleteMany({}),
    Report.deleteMany({}),
  ]);
  console.log("[reset] done — empty workspace.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[reset] failed:", err);
  process.exit(1);
});
