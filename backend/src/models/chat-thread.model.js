import mongoose from "mongoose";

const { Schema } = mongoose;

// A single persisted chat message. Mirrors the frontend ChatMessage shape closely
// enough to round-trip; screenshots (huge data URLs) are not persisted by the
// client, so threads stay small.
const messageSchema = new Schema(
  {
    mid: { type: String, required: true }, // client-side message id
    role: { type: String, enum: ["user", "agent", "system"], required: true },
    content: { type: String, default: "" },
    kind: { type: String, default: undefined },
    ts: { type: Number, default: undefined },
    testCode: { type: String, default: undefined },
    detail: { type: String, default: undefined },
    stepNo: { type: Number, default: undefined },
    stepStatus: { type: String, default: undefined },
    meta: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false },
);

// A persistent conversation with the agent, scoped to a project. Threads survive
// navigation and reloads, and are auto-cleared 10 days after their last activity
// via the TTL index below.
const chatThreadSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    title: { type: String, default: "New chat" },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

// TTL: Mongo removes a thread 10 days after `updatedAt`. Every save bumps
// `updatedAt`, so only threads left untouched for 10 days are cleared.
const TEN_DAYS_SECONDS = 10 * 24 * 60 * 60;
chatThreadSchema.index({ updatedAt: 1 }, { expireAfterSeconds: TEN_DAYS_SECONDS });

chatThreadSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.projectId = ret.projectId?.toString();
    delete ret._id;
    return ret;
  },
});

export const ChatThread = mongoose.model("ChatThread", chatThreadSchema);
