import mongoose from "mongoose";

const { Schema } = mongoose;

// An append-only record of notable actions (who-changed-what, minus "who" until
// real accounts exist). Used by the activity log.
const auditSchema = new Schema(
  {
    action: { type: String, required: true }, // e.g. "project.create", "run.start_all"
    detail: { type: String, default: "" },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: undefined, index: true },
  },
  { timestamps: true },
);

auditSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    delete ret._id;
    return ret;
  },
});

export const AuditLog = mongoose.model("AuditLog", auditSchema);
