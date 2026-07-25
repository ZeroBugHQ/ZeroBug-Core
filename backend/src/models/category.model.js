import mongoose from "mongoose";

const { Schema } = mongoose;

// A user-created grouping of tests within a project (e.g. "Login flow",
// "Checkout", "Admin"). Categories are project-wide; a test carries a
// categoryId and shows under that category inside whichever status column it
// currently sits in. Tests with no categoryId render under "Uncategorized".
const categorySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, required: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

categorySchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    delete ret._id;
    return ret;
  },
});

export const Category = mongoose.model("Category", categorySchema);
