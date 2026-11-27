import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"] }));
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
const askErrors: ErrorRequestHandler = (error, req, res, next) => {
  if (!req.path.startsWith("/api/ask")) { next(error); return; }
  const oversized = (error as { type?: string }).type === "entity.too.large";
  res.status(oversized ? 413 : 400).json({ error: oversized ? "The request is too large. Questions are limited to 2,000 characters." : "Invalid request. Please send a valid JSON question." });
};
app.use(askErrors);

export default app;
