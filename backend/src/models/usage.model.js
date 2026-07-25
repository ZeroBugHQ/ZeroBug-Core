import mongoose from "mongoose";

const { Schema } = mongoose;

// One cumulative counter document per project — incremented (never row-per-call)
// as the model is used, so the stats page is cheap to read.
const usageSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, unique: true, index: true },
    promptTokens: { type: Number, default: 0 },
    responseTokens: { type: Number, default: 0 },
    requests: { type: Number, default: 0 }, // LLM completions
    toolRequests: { type: Number, default: 0 }, // total tool calls
    toolCalls: { type: Schema.Types.Mixed, default: {} }, // { toolName: count }
  },
  { timestamps: true },
);

usageSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id?.toString();
    ret.projectId = ret.projectId?.toString();
    delete ret._id;
    return ret;
  },
});

export const Usage = mongoose.model("Usage", usageSchema);
