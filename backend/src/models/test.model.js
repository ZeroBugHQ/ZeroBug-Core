import mongoose from "mongoose";

const { Schema } = mongoose;

const apiConfigSchema = new Schema(
  {
    method: { type: String, default: "GET" },
    url: { type: String, default: "" },
    headers: { type: Map, of: String, default: undefined },
    body: { type: String, default: "" },
    expectedStatus: { type: Number, default: 200 },
    expectedBodyContains: { type: String, default: "" },
    expectedJsonPath: { type: String, default: "" },
    expectedJsonValue: { type: String, default: "" },
  },
  { _id: false },
);

const testSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    columnId: { type: Schema.Types.ObjectId, ref: "Column", default: undefined },
    // Optional user-created grouping within the board (see category.model.js).
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: undefined },
    code: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    suite: { type: String, default: "General" },
    tags: { type: [String], default: () => [] }, // freeform labels: smoke, critical, auth…
    // Data-driven: run the test once per row, substituting {{col}} placeholders.
    dataRows: { type: [Schema.Types.Mixed], default: undefined },
    // Ordering: test codes that must PASS before this one runs (queue runs only).
    dependsOn: { type: [String], default: () => [] },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    estMs: { type: Number, default: 2000 },
    budgetMs: { type: Number, default: 0 }, // perf budget; 0 = none. Over → flagged.
    flaky: { type: Boolean, default: false }, // auto-set: recent runs mix pass & fail
    queueOrder: { type: Number, default: 0 }, // manual ordering within the run queue
    steps: { type: [String], default: undefined },
    attachments: { type: [String], default: undefined }, // base64 data URLs (optional context images)
    maxRetries: { type: Number, default: 0, min: 0, max: 5 },
    mode: { type: String, enum: ["ui", "api"], default: "ui" },
    // Emulated form-factor for UI runs (Chromium only; mobile/tablet set viewport
    // + touch + mobile user-agent via Playwright device descriptors).
    viewport: { type: String, enum: ["desktop", "tablet", "mobile"], default: "desktop" },
    assertionTypes: {
      type: [String],
      enum: ["functional", "visual", "a11y"],
      default: () => ["functional"],
    },
    apiConfig: { type: apiConfigSchema, default: undefined },
    status: {
      type: String,
      enum: ["queued", "running", "passed", "failed"],
      default: "queued",
    },
    durationMs: { type: Number, default: undefined },
    failureReason: { type: String, default: undefined },
  },
  { timestamps: true },
);

// Expose `id` (string) and drop _id/__v so the API shape matches the frontend.
testSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    ret.columnId = ret.columnId?.toString();
    ret.categoryId = ret.categoryId ? ret.categoryId.toString() : null;
    if (ret.apiConfig?.headers instanceof Map)
      ret.apiConfig.headers = Object.fromEntries(ret.apiConfig.headers);
    delete ret._id;
    return ret;
  },
});

export const Test = mongoose.model("Test", testSchema);
