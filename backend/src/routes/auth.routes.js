import { Router } from "express";
import { authEnabled, expectedToken, verifyPassword } from "../services/auth-service.js";

export const authRouter = Router();

// Whether the client must log in (kept unauthenticated so the gate can ask).
authRouter.get("/status", (_req, res) => {
  res.json({ required: authEnabled() });
});

authRouter.post("/login", (req, res) => {
  if (!authEnabled()) return res.json({ token: "" });
  if (verifyPassword(req.body?.password)) return res.json({ token: expectedToken() });
  return res.status(401).json({ error: "Incorrect password" });
});
