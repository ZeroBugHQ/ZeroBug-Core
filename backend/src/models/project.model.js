import mongoose from "mongoose";

const { Schema } = mongoose;

// Seed list of environment kinds a new project starts with. Users can add their
// own (up to MAX_ENVIRONMENT_KINDS total) and delete any of these.
export const DEFAULT_ENVIRONMENT_KINDS = [
  "prod",
  "staging",
  "ephemeral",
  "dev",
  "qa",
  "uat",
  "sandbox",
];
export const MAX_ENVIRONMENT_KINDS = 20;

const projectSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    environmentKinds: { type: [String], default: () => [...DEFAULT_ENVIRONMENT_KINDS] },
    agentModel: { type: String, default: "" },
    // Automation: queue pause flag + webhook (CI/curl) trigger config.
    queuePaused: { type: Boolean, default: false },
    webhookToken: { type: String, default: "", index: true },
    webhookCallbackUrl: { type: String, default: "" },
    // Alerting: notify (via global notify channels) when a batch dips below this
    // pass-rate %, or when a critical test fails. 0 = pass-rate alert off.
    alertPassRateThreshold: { type: Number, default: 0, min: 0, max: 100 },
    alertOnCriticalFail: { type: Boolean, default: false },
  },
  { timestamps: true },
);

projectSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

export const Project = mongoose.model("Project", projectSchema);
