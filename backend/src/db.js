import mongoose from "mongoose";
import { config } from "./config.js";

let connected = false;

export async function connectDb() {
  if (connected) return mongoose.connection;
  mongoose.set("strictQuery", true);
  await mongoose.connect(config.mongoUri, {
    dbName: config.mongoDb,
    serverSelectionTimeoutMS: 5000,
  });
  connected = true;
  console.log(`[db] connected to ${config.mongoUri}/${config.mongoDb}`);
  return mongoose.connection;
}

export function isDbConnected() {
  return mongoose.connection?.readyState === 1;
}
