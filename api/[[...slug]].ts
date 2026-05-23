import express from "express";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { setupRoutes } from "../src/server-routes.js";

dotenv.config();

const app = express();
app.use(express.json());

const locationCache = new Map<string, any>();
const hotelCache = new Map<string, any>();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

setupRoutes(app, anthropic, locationCache, hotelCache);

export default app;
