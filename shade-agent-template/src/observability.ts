// Observability example: one canonical pattern per pillar.
//
// Logs    -> structured JSON to stdout/stderr; Alloy ships them to Loki via
//            the Docker socket. Queryable in Grafana with `| json`.
// Metrics -> prom-client exposes /metrics; Prometheus scrapes it on a 15s
//            interval (see docker-compose-observability.yaml).
// Traces  -> OpenTelemetry SDK emits OTLP/HTTP spans to Tempo. The
//            auto-instrumentations cover the http server and outbound fetch
//            calls without per-call code changes.
//
// Wiring (see src/index.ts):
//   - import { otelSDK } from "./observability"; otelSDK.start();   // before app code
//   - app.get("/metrics", ...)                                       // expose for Prometheus

import { Hono } from "hono";
import client from "prom-client";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
// Structured logs are just JSON on stdout/stderr. Alloy reads them via the
// Docker socket and ships to Loki. In Grafana, query with:
//   {service_name="shade-agent-app"} | json
// to extract individual fields, or `|= "tx_sent"` for a substring match.

type LogFields = Record<string, unknown>;

const emit = (level: "info" | "warn" | "error", event: string, fields: LogFields) => {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
};

export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};

// Example:
//   log.info("tx_sent", { chain: "near", txid: "abc..." });
//   log.error("rpc_failed", { url, status: res.status });

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
// prom-client exposes Prometheus-format metrics. The default collector adds
// process_cpu_seconds_total, process_resident_memory_bytes,
// process_start_time_seconds (free uptime via `time() - process_start_time_seconds`),
// nodejs_event_loop_lag_seconds, etc.

export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

export const txSent = new client.Counter({
  name: "agent_tx_sent_total",
  help: "Total transactions submitted to chain",
  labelNames: ["chain", "status"] as const,
  registers: [metricsRegistry],
});

export const agentUp = new client.Gauge({
  name: "agent_up",
  help: "1 if the agent's last healthcheck succeeded, 0 otherwise",
  registers: [metricsRegistry],
});
agentUp.set(1);

// Example:
//   txSent.inc({ chain: "near", status: "success" });
//   agentUp.set(healthy ? 1 : 0);

// Mount on the Hono app at /metrics so Prometheus can scrape it. Returning a
// Hono handler lets the consumer attach it the way they prefer.
export const metricsHandler = async (c: import("hono").Context) => {
  c.header("Content-Type", metricsRegistry.contentType);
  return c.body(await metricsRegistry.metrics());
};

export const mountMetrics = (app: Hono) => app.get("/metrics", metricsHandler);

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------
// OpenTelemetry SDK with the OTLP HTTP exporter pointed at Tempo. The auto-
// instrumentations transparently wrap http server, fetch, and other common
// libs so most spans appear without code changes.
//
// IMPORTANT: call otelSDK.start() in src/index.ts BEFORE importing anything
// you want auto-instrumented (the SDK monkey-patches modules at startup).

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://tempo:4318/v1/traces";

export const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "shade-agent-app",
  }),
  traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
  instrumentations: [getNodeAutoInstrumentations()],
});

export const tracer = trace.getTracer("shade-agent-app");

// Example manual span (auto-instrumentations cover http/fetch/etc. for free):
//
//   const span = tracer.startSpan("sign_transaction");
//   span.setAttribute("chain", "near");
//   try {
//     const result = await doSign();
//     span.setAttribute("txid", result.txid);
//     return result;
//   } catch (err) {
//     span.recordException(err as Error);
//     span.setStatus({ code: 2 /* ERROR */ });
//     throw err;
//   } finally {
//     span.end();
//   }
