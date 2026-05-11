# Observability 

Shade Agent logs can be public or private.

## Public logs 

When `deploy_to_phala.public_logs` is set to `true` in the `deployment.yaml`, logs are public to everyone. They can be accessed via the following endpoint:

```
https://<app_id>-8090.<gateway-domain>/logs/<container_name>
```

## Private logs

When `deploy_to_phala.public_logs` is set to `false`, the previously cited endpoint is closed and you need another way to access logs and data.

Here we show you how to access logs and data using the Grafana stack.

### Services 

The Grafana stack has three main pillars of observability: 
- Logs - timestamped messages your app emits to the console via console.log, console.error, etc. ("agent registered", "tx_sent", "rpc_failed").
- Metrics - numeric values sampled over time ("245 requests/sec", "203 MB memory in use", "uptime 4h 12m") that you graph and alert on.
- Traces - a record of one request's journey through your code as a tree of timed spans, showing where the latency went and which downstream calls happened ("POST /api/transaction took 211ms", "tx.send → tx.sign (180ms) → fetch NEAR RPC (140ms)", "agent.register failed at MPC contract after 5s").

We use five different services for observability:

- **Loki** — log storage. Receives pushes from Alloy and serves LogQL queries to Grafana.
- **Alloy** — log forwarder. Discovers containers and forwards their logs to Loki.
- **Prometheus** — metrics storage. Scrapes metrics from the agent and stores them.
- **Tempo** — trace storage. Receives traces from the agent and stores them.
- **Grafana** — UI. Auto-provisions all three backends as datasources and gates everything behind an admin login. The only externally-reachable service in the stack.

These services need to be included in the Docker compose file. Here is an example -> [docker-compose-observability.yaml](../../shade-agent-template/docker-compose-observability.yaml). You can configure it how you like.

If you don't need logs, opt out of Loki and Alloy. If you don't need metrics, opt out of Prometheus. If you don't need traces, opt out of Tempo.

The minimum supported `deploy_to_phala.instance_type` for the full observability stack is `tdx.medium` — six containers don't fit comfortably on `tdx.small` (1 CPU / ~2 GB RAM).

### App requirements

Logs work for free — anything written to stdout/stderr is shipped to Loki. Metrics and traces need a small amount of agent code.

Install the dependencies:

```bash
npm install prom-client @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions @opentelemetry/auto-instrumentations-node
```

Here is an example `src/observability.ts` file for setting up observability:

```ts
import type { Hono, Context } from "hono";
import client from "prom-client";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

// ---------- Logs ----------
// Standard log formats
type LogFields = Record<string, unknown>;
const emit = (level: "info" | "warn" | "error", event: string, fields: LogFields) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};
export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
// e.g. log.info("tx_sent", { chain: "near", txid });

// ---------- Metrics ----------
// Default collector adds process_*, nodejs_*, plus your custom counters/gauges.
export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

export const txSent = new client.Counter({
  name: "agent_tx_sent_total",
  help: "Total transactions submitted to chain",
  labelNames: ["chain", "status"] as const,
  registers: [metricsRegistry],
});
// e.g. txSent.inc({ chain: "near", status: "success" });

export const agentUp = new client.Gauge({
  name: "agent_up",
  help: "1 if healthy, 0 otherwise",
  registers: [metricsRegistry],
});
// e.g. agentUp.set(1);

// Mount /metrics on a Hono app so Prometheus can scrape it.
export const mountMetrics = (app: Hono) =>
  app.get("/metrics", async (c: Context) => {
    c.header("Content-Type", metricsRegistry.contentType);
    return c.body(await metricsRegistry.metrics());
  });

// ---------- Traces ----------
// IMPORTANT: call otelSDK.start() in src/index.ts BEFORE other imports
const otlpEndpoint = "http://tempo:4318/v1/traces";

export const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "shade-agent-app" }),
  traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
  instrumentations: [getNodeAutoInstrumentations()], // Or set specific instrumentations for reduced supply chain risk
});

export const tracer = trace.getTracer("shade-agent-app");

// Wrap an async block in a span. Auto-instrumented fetches inside become children.
export const traced = <T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> =>
  tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
// e.g.
//   const result = await traced("tx.send", async (span) => {
//     span.setAttribute("chain", "near");
//     return await sendTx();
//   });
```

You need to invoke some functions in your main file `src/index.ts`:

```ts
// At the very top of the file, BEFORE other imports:
// Patches libraries like http and fetch at runtime
import { otelSDK, mountMetrics } from "./observability";
otelSDK.start();
```

```ts
// After your Hono app is created:
mountMetrics(app); // exposes /metrics for Prometheus to scrape
```

Without these two changes, deploys still succeed but Prometheus scrapes a 404 and Tempo stays empty — only logs would work.

For full details on how to use logging, metrics and traces in your application refer to the docs https://grafana.com/docs/.

### Deploying 

1) Configure your Docker compose file and make sure your `deployment.yaml` file points at it.
2) In your `deployment.yaml` file set `deploy_to_phala.public_logs` (and optionally `deploy_to_phala.public_sysinfo`) to `false` .
3) Generate a secret `openssl rand -hex 32`
4) Add the secret to your `.env` file `GF_SECURITY_ADMIN_PASSWORD=YOUR_SECRET`
5) Deploy the Shade Agent

### Using Observability 

After deployment the CLI will spit out a URL for the Grafana UI on port 3030. Click on this URL and enter your username "admin" and your password you generated previously. To learn how to use the dashboard you can watch [this youtube video](https://www.youtube.com/watch?v=1q3YzX2DDM4).