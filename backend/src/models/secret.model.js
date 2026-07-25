import mongoose from "mongoose";

const { Schema } = mongoose;

// An encrypted credential/value scoped to an environment. The plaintext value is
// NEVER stored or returned by the API — only `valueEnc` (AES-256-GCM).
const secretSchema = new Schema(
  {
    environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true, index: true },
    key: { type: String, required: true },
    valueEnc: { type: String, required: true },
  },
  { timestamps: true },
);

secretSchema.index({ environmentId: 1, key: 1 }, { unique: true });

export const Secret = mongoose.model("Secret", secretSchema);
