import mongoose from "mongoose";

const { Schema } = mongoose;

const stepSchema = new Schema(
  {
    index: Number,
    label: String,
    status: { type: String, enum: ["running", "pass", "fail"], default: "running" },
    detail: String,
  },
  { _id: false },
);

const artifactSchema = new Schema(
  {
    kind: String,
    label: String,
    url: String,
  },
  { _id: false },
);

const runSchema = new Schema(
  {
    testId: { type: Schema.Types.ObjectId, ref: "Test", required: true },
    status: {
      type: String,
      enum: ["running", "passed", "failed"],
      default: "running",
    },
    mode: { type: String, enum: ["ui", "api"], default: "ui" },
    // Where this run originated, for audit/insights. "interactive" = a UI Run;
    // "queue"/"schedule"/a webhook-supplied value = an automation run.
    source: { type: String, default: undefined },
    assertionTypes: { type: [String], default: [] },
    attempt: { type: Number, default: 1 },
    maxAttempts: { type: Number, default: 1 },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: undefined },
    durationMs: { type: Number, default: undefined },
    failureReason: { type: String, default: undefined },
    actions: { type: Array, default: [] },
    steps: { type: [stepSchema], default: [] },
    artifacts: { type: [artifactSchema], default: [] },
    output: {
      type: new Schema(
        {
          url: String,
          title: String,
          text: String,
          result: String,
          screenshot: String,
          statusCode: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Captured during a run for inline failure triage: browser console errors,
    // failed/4xx-5xx network requests, and a saved DOM-at-end HTML snapshot.
    forensics: {
      type: new Schema(
        {
          console: { type: [{ type: { type: String }, text: String }], default: [] },
          network: {
            type: [{ url: String, method: String, status: Number, failure: String }],
            default: [],
          },
          domSnapshotUrl: String,
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

runSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.testId = ret.testId?.toString();
    delete ret._id;
    return ret;
  },
});

export const Run = mongoose.model("Run", runSchema);
