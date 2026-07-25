import mongoose from "mongoose";

const { Schema } = mongoose;

// One learned lesson about a site, scoped to a project + origin. Populated and
// reinforced automatically by site-memory-service after each run. See
// memory-logic.js for the confidence math and mining rules.
const siteMemorySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    origin: { type: String, required: true }, // scheme://host
    kind: {
      type: String,
      enum: ["popup", "login", "failure", "note"],
      default: "note",
    },
    // The human-readable lesson text injected into the agent's prompt as a hint.
    lesson: { type: String, required: true },
    // Structured extras (heading, endpoint, reason…) — for the UI and future use.
    detail: { type: Schema.Types.Mixed, default: {} },
    // Stable dedupe key (origin|kind|normalized-lesson); unique per project.
    key: { type: String, required: true, index: true },

    confidence: { type: Number, default: 0.3, min: 0, max: 1 },
    uses: { type: Number, default: 0 }, // times surfaced as a hint in a run
    wins: { type: Number, default: 0 }, // ...where that run then passed
    losses: { type: Number, default: 0 }, // ...where that run then failed
    // Confidence over time (most recent last, capped) — powers the detail sparkline.
    history: {
      type: [new Schema({ ts: Number, confidence: Number, passed: Boolean }, { _id: false })],
      default: [],
    },
    status: { type: String, enum: ["active", "pruned"], default: "active" },
    source: { type: String, enum: ["mined", "reflection"], default: "mined" },
    sourceRunId: { type: Schema.Types.ObjectId, ref: "Run", default: undefined },
    lastUsedAt: { type: Date, default: undefined },
  },
  { timestamps: true },
);

// A lesson is unique per project + dedupe key.
siteMemorySchema.index({ projectId: 1, key: 1 }, { unique: true });
siteMemorySchema.index({ projectId: 1, origin: 1, status: 1 });

siteMemorySchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    ret.sourceRunId = ret.sourceRunId?.toString();
    delete ret._id;
    return ret;
  },
});

export const SiteMemory = mongoose.model("SiteMemory", siteMemorySchema);
