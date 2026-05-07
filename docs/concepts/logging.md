# Logging

A shade-agent's container logs can be viewed three ways. Pick the one that matches your threat model.

## Public logs (the default)

`deploy_to_phala.public_logs: true` mounts the dstack guest-agent's `GET /logs/<container>` route on the CVM's external HTTP listener (port 8090). Anyone on the internet who knows your `app_id` can read logs at:

```
https://<app_id>-8090.<gateway-domain>/logs/<container_name>
```

Useful for debugging open-source agents. Don't use it if your logs include anything you wouldn't show a stranger — request bodies, user identifiers, third-party API responses, stack traces with env-var names, and so on.

## Private dashboard with Loki + Grafana

[`shade-agent-template/docker-compose-logging.yaml`](../../shade-agent-template/docker-compose-logging.yaml) ships the agent alongside three sidecars so logs stay inside the CVM and only an authenticated viewer can read them:

- **Loki** — stores log chunks on a LUKS-encrypted volume (`loki-data`).
- **Grafana Alloy** — discovers containers via the local Docker socket and forwards their stdout/stderr to Loki.
- **Grafana** — password-protected web UI with the Loki datasource auto-provisioned.

Grafana is published through the Phala gateway on a separate port (3030) so the agent's port 3000 is unaffected. Loki and Alloy live only on the internal Docker bridge — no public routing.

### Opting in

1. In `deployment.yaml`:
   - `docker_compose_path: ./docker-compose-logging.yaml`
   - `deploy_to_phala.public_logs: false` (Grafana replaces the public route — defense in depth says don't expose two log surfaces)
   - Recommend `deploy_to_phala.instance_type: tdx.medium`. The default `tdx.small` (1 CPU / ~2 GB) is tight with four containers running.
2. In `.env`, add `GF_SECURITY_ADMIN_PASSWORD=<long random string>`. Encrypted by Phala KMS at deploy time and unsealed inside the CVM.
3. Run `npm run shade:cli deploy`. The `compose_hash` is different from the default flow; `shade deploy` approves the new measurement on the agent contract automatically (when `approve_measurements` is enabled in `deployment.yaml`).
4. After deploy, Grafana is at:
   ```
   https://<app_id>-3030.<gateway-domain>
   ```
   Log in with `admin` and the password you set. The Loki datasource is auto-configured; query `{container="shade-agent-app"}` in the Explore tab to see the agent's logs.

### Trust boundaries

The Phala host operator can read your agent's logs regardless of which option you pick — they run the Docker daemon directly. The flag and the Loki UI both live inside the CVM; neither blocks host-level access. If you're worried about Phala reading your logs, the only mitigation is to not log sensitive data in the first place.

## Full observability variant (logs + metrics + traces)

If logs aren't enough — for example you want graphs of transactions sent over time, latency breakdowns of outbound RPC calls, or a single dashboard for everything the agent does — use [`shade-agent-template/docker-compose-observability.yaml`](../../shade-agent-template/docker-compose-observability.yaml). It adds two backends to the logging stack:

- **Prometheus** — scrapes `/metrics` from the agent (and from Loki / Tempo) every 15 seconds; stores time-series in a local TSDB with 30-day retention.
- **Tempo** — receives OpenTelemetry traces from the agent on OTLP HTTP (port 4318) and stores them on disk.

Grafana auto-provisions all three datasources (Loki / Prometheus / Tempo) so the Explore tab has them ready.

### Agent-side instrumentation

[`shade-agent-template/src/observability.ts`](../../shade-agent-template/src/observability.ts) is a self-contained example showing one canonical pattern per pillar:

- **Logs** — a small `log.info / .warn / .error` helper that emits structured JSON. Alloy already ships these to Loki via the Docker socket; query in Grafana with `{service_name="shade-agent-app"} | json`.
- **Metrics** — `prom-client` registry with a `/metrics` HTTP endpoint mounted on the Hono app. Adds default node metrics (CPU, memory, event-loop lag, `process_start_time_seconds` for uptime) plus example custom metrics (`agent_tx_sent_total` counter, `agent_up` gauge).
- **Traces** — OpenTelemetry SDK with the OTLP/HTTP exporter pointed at `http://tempo:4318/v1/traces`. The auto-instrumentations transparently wrap the HTTP server, outbound `fetch`, and other common modules — most spans appear without per-call code.

Wiring is two lines in `src/index.ts`: import + start the SDK at the very top of the file, and `mountMetrics(app)` after the Hono app is created.

### Opting in

Same shape as the logging-only variant, with two additional flags and a recommended bigger instance type:

1. In `deployment.yaml`:
   - `docker_compose_path: ./docker-compose-observability.yaml`
   - `deploy_to_phala.public_logs: false`
   - `deploy_to_phala.public_sysinfo: false` (Prometheus replaces the public `/metrics` endpoint, scraping the agent's own one over the internal Docker bridge)
   - `deploy_to_phala.instance_type: tdx.medium` — six containers don't fit on `tdx.small`.
2. In `.env`, the same `GF_SECURITY_ADMIN_PASSWORD=<long random>` as before. No new env vars.
3. Run `npm run shade:cli deploy`. The new `compose_hash` gets approved on the contract automatically.
4. After deploy, Grafana is at `https://<app_id>-3030.<gateway-domain>`. The Explore tab now shows three datasources in the picker — pick whichever one you want to query.

### Sample queries (Grafana Explore)

| Pillar | Datasource | Query |
|---|---|---|
| Logs | Loki | `{service_name="shade-agent-app"} \| json` |
| Metrics | Prometheus | `agent_tx_sent_total` |
| Metrics | Prometheus | `time() - process_start_time_seconds{job="shade-agent-app"}` (uptime) |
| Metrics | Prometheus | `rate(agent_tx_sent_total[5m])` (tx rate) |
| Traces | Tempo | use the trace ID lookup, or the Service Graph view |

Same trust boundary: `loki`, `prometheus`, `tempo`, and Alloy stay on the internal Docker bridge — only `<app_id>-3000` (agent) and `<app_id>-3030` (Grafana) are reachable from outside, and Grafana is behind the admin login.

## What doesn't work

The Phala Cloud dashboard and authenticated API both proxy the same dstack route that `public_logs` gates. With `public_logs: false` and no Loki sidecar, **even the deployer with their own API key cannot read logs.** This is by design — there is no "authenticated-only" log path on Phala Cloud. If you turn off public logs, you need an in-CVM log surface (Loki + Grafana, Dozzle, or anything else mounting the Docker socket) to read your own logs.
