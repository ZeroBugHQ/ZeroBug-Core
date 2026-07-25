import mongoose from "mongoose";

const { Schema } = mongoose;

const environmentSchema = new Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    // Free-form: each project defines its own set of kinds (see Project.environmentKinds).
    kind: { type: String, default: "staging" },
    active: { type: Boolean, default: true },
    // Remembered login/credentials for this target. Once the user answers the
    // agent's login question once, it's saved here and reused on every later run
    // against this environment (so it never re-asks). Stored as plain text.
    loginInstructions: { type: String, default: "" },
    vars: { type: Number, default: 0 },
    secrets: { type: Number, default: 0 }, // count of stored secrets (values live in the Secret collection)
    health: { type: String, enum: ["healthy", "degraded"], default: "healthy" },
    // Rolling health samples (capped) for the uptime indicator.
    healthHistory: {
      type: [new Schema({ at: Date, healthy: Boolean }, { _id: false })],
      default: () => [],
    },
    // When a logged-in browser session was last saved for reuse (storageState).
    storageStateSavedAt: { type: Date, default: undefined },
  },
  { timestamps: true },
);

environmentSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

export const Environment = mongoose.model("Environment", environmentSchema);
