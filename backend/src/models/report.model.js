import mongoose from "mongoose";

const { Schema } = mongoose;

const reportSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, required: true },
    suite: { type: String, default: "General" },
    prompt: { type: String, default: "" },
    status: { type: String, enum: ["approved", "review"], default: "review" },
    snippet: { type: String, default: "" },
  },
  { timestamps: true },
);

reportSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    delete ret._id;
    return ret;
  },
});

export const Report = mongoose.model("Report", reportSchema);
