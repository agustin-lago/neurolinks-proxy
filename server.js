import crypto from "node:crypto";
import express from "express";
import { Readable } from "node:stream";

const app = express();

const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || "30mb";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const MAX_CONCURRENT_REQUESTS = Number(process.env.MAX_CONCURRENT_REQUESTS || 1000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 1200);
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || "";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "true";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const googleAllowedHosts = new Set([
  "www.googleapis.com",
  "oauth2.googleapis.com",
  "sheets.googleapis.com",
  "calendar.googleapis.com",
  "drive.googleapis.com",
  "docs.googleapis.com"
]);

const openAiAllowedPathPrefixes = [
  "/v1/"
];

const hopByHopRequestHeaders = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "x-target-host",
  "x-proxy-token"
]);

const hopByHopResponseHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade"
]);

let activeRequests = 0;
const rateLimitBuckets = new Map();

function parseTrustProxy(value) {
  if (!value) return "loopback";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

if (NODE_ENV === "production" && !ALLOW_UNAUTHENTICATED && PROXY_AUTH_TOKEN.length < 32) {
  console.error(JSON.stringify({ level: "fatal", msg: "PROXY_AUTH_TOKEN must be set and at least 32 characters in production" }));
  process.exit(1);
}

app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY);
app.use(express.raw({ type: "*/*", limit: MAX_BODY_SIZE }));

app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  return res.status(400).json({ error: "Invalid request body" });
});

function log(level, msg, extra = {}) {
  const order = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
  if ((order[level] || 20) < (order[LOG_LEVEL] || 20)) return;
  console[level === "fatal" ? "error" : level](JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...extra
  }));
}

function requestId(req) {
  return String(req.headers["x-request-id"] || crypto.randomUUID());
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireProxyAuth(req, res, next) {
  if (req.path === "/health" || ALLOW_UNAUTHENTICATED) return next();

  const incomingToken = req.headers["x-proxy-token"] || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!PROXY_AUTH_TOKEN || !incomingToken || !timingSafeEqualString(incomingToken, PROXY_AUTH_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function rateLimit(req, res, next) {
  if (req.path === "/health") return next();

  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);

  res.setHeader("RateLimit-Limit", String(RATE_LIMIT_MAX));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX - bucket.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now > bucket.resetAt + RATE_LIMIT_WINDOW_MS) rateLimitBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function concurrencyGuard(req, res, next) {
  if (req.path === "/health") return next();
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return res.status(503).json({ error: "Proxy overloaded" });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };

  activeRequests += 1;
  res.once("finish", release);
  res.once("close", release);

  next();
}

function sanitizeHeaderValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function stripRequestHeaders(headers) {
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const cleanValue = sanitizeHeaderValue(value);
    if (!hopByHopRequestHeaders.has(lower) && cleanValue !== undefined) {
      clean[key] = cleanValue;
    }
  }
  return clean;
}

function resolveTarget(req) {
  const hostname = String(req.hostname || "").toLowerCase();

  if (hostname.startsWith("google-proxy.")) {
    const targetHost = String(req.headers["x-target-host"] || "").toLowerCase();
    if (!googleAllowedHosts.has(targetHost)) {
      return { errorStatus: 403, error: "Google target not allowed" };
    }
    return { provider: "google", targetHost };
  }

  if (hostname.startsWith("proxy.") || hostname.startsWith("openai-proxy.")) {
    if (!openAiAllowedPathPrefixes.some((prefix) => req.originalUrl.startsWith(prefix))) {
      return { errorStatus: 403, error: "OpenAI path not allowed" };
    }
    return { provider: "openai", targetHost: "api.openai.com" };
  }

  return { errorStatus: 404, error: "Unknown proxy host" };
}

function copyResponseHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    if (!hopByHopResponseHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "neurolinks-proxy",
    activeRequests,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.use(requireProxyAuth);
app.use(rateLimit);
app.use(concurrencyGuard);

app.all("*", async (req, res) => {
  const id = requestId(req);
  res.setHeader("x-request-id", id);

  const resolved = resolveTarget(req);
  if (resolved.error) {
    log("warn", "blocked request", { requestId: id, ip: req.ip, host: req.hostname, path: req.originalUrl, reason: resolved.error });
    return res.status(resolved.errorStatus).json({ error: resolved.error });
  }

  const targetUrl = `https://${resolved.targetHost}${req.originalUrl}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  req.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: stripRequestHeaders(req.headers),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
      signal: controller.signal
    });

    res.status(upstream.status);
    copyResponseHeaders(upstream, res);

    log("info", "proxied request", {
      requestId: id,
      provider: resolved.provider,
      targetHost: resolved.targetHost,
      method: req.method,
      path: req.originalUrl,
      status: upstream.status,
      durationMs: Date.now() - startedAt
    });

    if (req.method === "HEAD" || !upstream.body) {
      return res.end();
    }

    Readable.fromWeb(upstream.body).on("error", (error) => {
      log("error", "response stream error", { requestId: id, message: error?.message || String(error) });
      if (!res.headersSent) res.status(502);
      res.end();
    }).pipe(res);
  } catch (error) {
    const aborted = error?.name === "AbortError";
    log("error", "upstream error", {
      requestId: id,
      provider: resolved.provider,
      targetHost: resolved.targetHost,
      path: req.originalUrl,
      durationMs: Date.now() - startedAt,
      message: aborted ? "Request timeout" : (error?.message || String(error))
    });

    if (!res.headersSent) {
      return res.status(aborted ? 504 : 502).json({ error: aborted ? "Proxy request timeout" : "Proxy upstream error", requestId: id });
    }
    res.end();
  } finally {
    clearTimeout(timeout);
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  log("info", "proxy listening", { port: PORT, nodeEnv: NODE_ENV, trustProxy: TRUST_PROXY });
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 190000);

function shutdown(signal) {
  log("info", "shutdown requested", { signal });
  server.close((error) => {
    if (error) {
      log("error", "shutdown error", { message: error.message });
      process.exit(1);
    }
    process.exit(0);
  });

  setTimeout(() => {
    log("error", "forced shutdown timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
  log("fatal", "uncaught exception", { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("fatal", "unhandled rejection", { message: reason?.message || String(reason), stack: reason?.stack });
  process.exit(1);
});
