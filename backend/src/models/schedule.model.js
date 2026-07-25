import mongoose from "mongoose";

const { Schema } = mongoose;

// A cron-scheduled run of a project's queue (optionally filtered to one suite).
const scheduleSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, required: true },
    cron: { type: String, required: true }, // 5-field cron: "m h dom mon dow"
    suite: { type: String, default: "" }, // empty = whole queue
    environmentId: { type: Schema.Types.ObjectId, ref: "Environment", default: undefined },
    callbackUrl: { type: String, default: "" }, // POSTed a run summary when done
    maxRetries: { type: Number, default: 0, min: 0, max: 5 },
    enabled: { type: Boolean, default: true },
    lastTriggeredAt: { type: Date, default: undefined },
    lastCompletedAt: { type: Date, default: undefined },
    lastStatus: { type: String, enum: ["passed", "failed", "running", "skipped"], default: undefined },
    lastError: { type: String, default: undefined },
  },
  { timestamps: true },
);

scheduleSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    ret.environmentId = ret.environmentId?.toString();
    delete ret._id;
    return ret;
  },
});

export const Schedule = mongoose.model("Schedule", scheduleSchema);
