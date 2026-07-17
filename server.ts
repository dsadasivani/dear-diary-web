import express, { type ErrorRequestHandler } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

export interface CreateAppOptions {
  mode?: "development" | "production";
  distPath?: string;
  jsonLimit?: string;
}

const resolveMode = (): "development" | "production" => {
  if (process.env.NODE_ENV === "development") return "development";
  if (process.env.NODE_ENV === "production") return "production";
  return process.env.npm_lifecycle_event === "dev" ? "development" : "production";
};

const parsePort = (value: string | undefined): number => {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
};

const apiNotFound: express.RequestHandler = (_req, res) => {
  res.status(404).type("application/json").json({ error: "not_found" });
};

const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).type("application/json").json({ error: "payload_too_large" });
    return;
  }
  if (error?.type === "entity.parse.failed") {
    res.status(400).type("application/json").json({ error: "invalid_json" });
    return;
  }
  res.status(error?.status || 500).type("application/json").json({ error: "internal_server_error" });
};

export const createApp = async (options: CreateAppOptions = {}): Promise<express.Express> => {
  const app = express();
  const mode = options.mode || resolveMode();

  app.disable("x-powered-by");
  app.use(express.json({ limit: options.jsonLimit || "10mb" }));

  app.get("/api/health", (_req, res) => {
    res.type("application/json").json({ status: "ok", offline: true });
  });
  app.use("/api", apiNotFound);

  if (mode === "development") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== "true",
        watch: process.env.DISABLE_HMR === "true" ? null : {},
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = options.distPath || path.join(process.cwd(), "dist");
    const indexPath = path.join(distPath, "index.html");
    app.use(express.static(distPath, {
      dotfiles: "deny",
      fallthrough: true,
      index: false,
    }));
    app.get("*", (_req, res) => {
      res.sendFile(indexPath);
    });
  }

  app.use(errorHandler);
  return app;
};

export const startServer = async (): Promise<void> => {
  const app = await createApp();
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST || "0.0.0.0";
  app.listen(port, host, () => {
    console.log(`Server running on ${host}:${port}`);
  });
};

if (process.env.DEAR_DIARY_DISABLE_SERVER_AUTOSTART !== "true") {
  void startServer().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
