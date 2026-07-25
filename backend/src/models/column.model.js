import mongoose from "mongoose";

const { Schema } = mongoose;

// A board column. `systemKey` is set for the four execution columns that the
// test runner drives automatically; it is null for user-created columns.
const columnSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    title: { type: String, required: true },
    systemKey: {
      type: String,
      enum: ["queued", "running", "passed", "failed", null],
      default: null,
    },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

columnSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    delete ret._id;
    return ret;
  },
});

export const Column = mongoose.model("Column", columnSchema);

// The four execution columns every project starts with, in board order.
export const SYSTEM_COLUMNS = [
  { systemKey: "queued", title: "Queued", order: 0 },
  { systemKey: "running", title: "Running", order: 1 },
  { systemKey: "passed", title: "Passed", order: 2 },
  { systemKey: "failed", title: "Failed", order: 3 },
];
