import mongoose from "mongoose";

const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "global" },
    values: { type: Object, default: {} },
  },
  { timestamps: true },
);

appSettingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const AppSetting =
  mongoose.models.AppSetting || mongoose.model("AppSetting", appSettingSchema);
