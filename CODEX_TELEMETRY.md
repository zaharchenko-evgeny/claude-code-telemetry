Codex CLI telemetry with OpenTelemetry

This document explains how to configure Codex CLI (from openai/codex) to emit OpenTelemetry logs, what events/fields are available, and how to export them via OTLP/HTTP or OTLP/gRPC into your existing OpenTelemetry pipeline (Collector, vendors, etc.).

Codex currently emits OpenTelemetry logs only – no native OTEL metrics or traces. Metrics are expected to be derived on the backend from these log records.  ￼

⸻

1. Where telemetry is configured

Codex reads its config from:

~/.codex/config.toml

(or $CODEX_HOME/config.toml if CODEX_HOME is set). This file is shared between the CLI and the IDE extension.  ￼

You can override any config key at runtime with:

codex --config key=value
# or
codex -c key=value

Values are parsed as JSON if possible, otherwise as a literal string.  ￼

⸻

2. Enabling OpenTelemetry in Codex

2.1 Minimal [otel] block

From the official configuration docs:  ￼

[otel]
environment     = "staging"  # defaults to "dev"
exporter        = "none"     # defaults to "none"; set to otlp-http or otlp-grpc
log_user_prompt = false      # redact prompt text unless explicitly enabled

Key fields:
•	environment: a free-form label (e.g. dev, staging, prod) used as env attribute on all events.
•	exporter:
•	"none" – instrumentation active, but no export (default).
•	"otlp-http" – send OTLP logs via HTTP.
•	"otlp-grpc" – send OTLP logs via gRPC.
•	log_user_prompt:
•	false (default): user prompts are redacted from OTEL logs.
•	true: full user text is included in codex.user_prompt events (see below).

Codex will also tag every exported event with (among others):  ￼
•	service.name = originator (CLI name, e.g. codex_cli_rs)
•	CLI version
•	env = value from [otel].environment

Telemetry export is opt-in: nothing is sent unless you set an exporter.

2.2 One-off enabling via CLI

Instead of editing config.toml, you can enable OTEL per-run:

# Enable OTEL logs over HTTP and point to your collector
codex \
-c otel.environment='"dev"' \
-c 'otel.exporter={"otlp-http":{"endpoint":"http://localhost:4318/v1/logs","protocol":"binary"}}'

Note: Because the CLI parses --config as JSON where possible, you use JSON syntax in the value (double quotes, {} etc.).  ￼

⸻

3. What Codex actually emits (event catalog)

From the Codex config’s “otel / Event catalog” section.  ￼

3.1 Common metadata on every event

Every OTEL log record includes:
•	event.timestamp
•	conversation.id
•	app.version
•	auth_mode (when available)
•	user.account_id (when available)
•	terminal.type
•	model
•	slug

You’ll also see service.name and env as described earlier.

3.2 Event types and their attributes

Codex emits the following event types (log records). I’m grouping attributes per event for clarity.

3.2.1 codex.conversation_starts
Fired when a new Codex session begins. Attributes:  ￼
•	provider_name
•	reasoning_effort (optional)
•	reasoning_summary
•	context_window (optional)
•	max_output_tokens (optional)
•	auto_compact_token_limit (optional)
•	approval_policy
•	sandbox_policy
•	mcp_servers (comma-separated list)
•	active_profile (optional)

Use this to understand session configuration (model, policies, MCP servers, etc.).

3.2.2 codex.api_request
Represents an API call to a model provider. Attributes:  ￼
•	attempt
•	duration_ms
•	http.response.status_code (optional)
•	error.message (on failures)

This is ideal for request-level latency and error-rate metrics.

3.2.3 codex.sse_event
Tracks streamed responses (Server-Sent Events) from the API / model. Attributes:  ￼
•	event.kind
•	duration_ms
•	error.message (failures)
•	input_token_count (responses only)
•	output_token_count (responses only)
•	cached_token_count (responses only, optional)
•	reasoning_token_count (responses only, optional)
•	tool_token_count (responses only)

Use this for token usage, streaming performance, and model behaviour.

3.2.4 codex.user_prompt
Represents user input. Attributes:  ￼
•	prompt_length
•	prompt (only populated if log_user_prompt = true; redacted otherwise)

This is your main user→agent input signal. Use with care for privacy.

3.2.5 codex.tool_decision
Emitted when Codex decides whether to run a tool (e.g. shell command). Attributes:  ￼
•	tool_name
•	call_id
•	decision – one of:
•	"approved"
•	"approved_for_session"
•	"denied"
•	"abort"
•	source – "config" or "user"

Useful for auditing and policy enforcement (what the model wanted to do vs what was allowed).

3.2.6 codex.tool_result
Emitted after a tool invocation completes. Attributes:  ￼
•	tool_name
•	call_id (optional)
•	arguments (optional)
•	duration_ms (execution time)
•	success ("true" or "false")
•	output

Use this to track tool reliability, duration, and side effects.

The docs note that “these event shapes may change as we iterate” – watch release notes if you depend on specific fields.  ￼

⸻

4. Metrics you can derive from these logs

Codex does not currently export OTEL metrics directly – only logs.  ￼
In your Collector / backend (Prometheus-style time series, etc.) you can derive:
•	Request volume & latency
•	From codex.api_request:
•	requests_total by model, provider_name, env, http.response.status_code
•	request_duration_ms histograms from duration_ms
•	Error rates
•	Count codex.api_request where http.response.status_code >= 400 or error.message present.
•	Token usage
•	From codex.sse_event:
•	input_tokens_total, output_tokens_total, reasoning_tokens_total, tool_tokens_total by model, env
•	Tool usage & reliability
•	From codex.tool_result:
•	tool_invocations_total and tool_errors_total by tool_name, success.
•	tool_duration_ms histogram from duration_ms.
•	User behaviour
•	From codex.conversation_starts and codex.user_prompt:
•	Sessions per approval_policy / sandbox_policy.
•	Prompt length distributions (if you’re comfortable instrumentation-wise).

⸻

5. Configuring exporters in config.toml

The exporter is configured as a nested object under [otel]. From the docs:  ￼

5.1 Default [otel] section with explicit exporter

From the example config distributed with Codex:  ￼

################################################################################
# OpenTelemetry (OTEL) – disabled by default
################################################################################
[otel]
# Include user prompt text in logs. Default: false
log_user_prompt = false

# Environment label applied to telemetry. Default: "dev"
environment = "dev"

# Exporter: none (default) | otlp-http | otlp-grpc
exporter = "none"

5.2 OTLP/HTTP exporter example (recommended starting point)

[otel]
environment = "dev"
log_user_prompt = false

# Inline exporter object
exporter = { otlp-http = {
endpoint = "http://localhost:4318/v1/logs",
protocol = "binary",  # "binary" or "json"
# Optional headers (supports env-var substitution like ${OTLP_TOKEN})
headers = { "x-otlp-api-key" = "${OTLP_TOKEN}" }
} }

Notes:
•	The endpoint should be the OTLP/HTTP logs URL exposed by your collector or vendor. For a standard Collector with OTLP HTTP receiver, that’s typically http://<collector-host>:4318/v1/logs.  ￼
•	protocol:
•	"binary" → OTLP/HTTP protobuf
•	"json" → OTLP/HTTP JSON

5.3 OTLP/gRPC exporter example

[otel]
environment = "dev"
exporter = { otlp-grpc = {
endpoint = "otel-collector.example.com:4317",
headers = { "x-otlp-meta" = "abc123" }
} }

This uses the OTLP/gRPC protocol on the standard port 4317.  ￼

Security note: there was a bug in Codex 0.53.0 where otlp-grpc could send traffic unencrypted even when configured with an https endpoint, due to an upstream issue in opentelemetry-rust.  ￼
•	Ensure you are on a fixed Codex version, or
•	Prefer OTLP/HTTP with TLS for production if you can’t confirm the fix.

5.4 OTLP/HTTP with mutual TLS

From the example config:  ￼

[otel]
exporter = { otlp-http = {
endpoint = "https://otel.example.com/v1/logs",
protocol = "binary",
headers = { "x-otlp-api-key" = "${OTLP_TOKEN}" },
tls = {
ca-certificate       = "certs/otel-ca.pem",
client-certificate   = "/etc/codex/certs/client.pem",
client-private-key   = "/etc/codex/certs/client-key.pem",
}
} }

This is the pattern you’d typically use when sending directly to a vendor-managed OTLP HTTPS endpoint or a hardened internal Collector.

⸻

6. Example: Codex → local OpenTelemetry Collector

This is often the simplest deployable architecture:

Codex CLI  --(OTLP logs)-->  OpenTelemetry Collector  --(exporters)-->  backend(s)

6.1 Collector config (logs only, local dev)

Using the basic OTLP receiver + log pipeline (adapted from Collector config docs):  ￼

# otelcol.yaml
receivers:
otlp:
protocols:
http:
endpoint: 0.0.0.0:4318

processors:
batch: {}

exporters:
debug:
verbosity: detailed  # For development only; prints logs to stderr

service:
pipelines:
logs:
receivers: [otlp]
processors: [batch]
exporters: [debug]

Run the Collector (for example, using the contrib image):  ￼

otelcol-contrib --config otelcol.yaml
# or via Docker:
# docker run --rm -v "$(pwd)/otelcol.yaml:/etc/otelcol-contrib/config.yaml" \
#   -p 4318:4318 otel/opentelemetry-collector-contrib

6.2 Codex config pointing at the Collector

In ~/.codex/config.toml:

[otel]
environment = "dev"
log_user_prompt = false

exporter = { otlp-http = {
endpoint = "http://127.0.0.1:4318/v1/logs",
protocol = "binary",
} }

Start Codex and perform some actions; you should see OTEL log records flowing into the Collector’s debug exporter.

⸻

7. Example: Codex → Collector → vendor (Loki, Datadog, etc.)

The general pattern is the same; only the exporter in the Collector changes.

For example, sending logs to a Loki OTLP endpoint using an OTLP HTTP exporter (based on Grafana docs):  ￼

receivers:
otlp:
protocols:
http:
endpoint: 0.0.0.0:4318

processors:
batch: {}

exporters:
otlphttp/logs:
endpoint: http://loki:3100/otlp
tls:
insecure_skip_verify: true   # dev only!
# headers: { "X-Scope-OrgID": "your-tenant" }

service:
pipelines:
logs:
receivers: [otlp]
processors: [batch]
exporters: [otlphttp/logs]

Codex configuration is the same as in §6.2 – it only knows it’s sending OTLP logs to http://collector:4318/v1/logs. The Collector then forwards those logs to Loki (or any other backend).

This is also the pattern you’d use to forward Codex telemetry into Langfuse or other non-OTLP backends: Codex → OTEL Collector → custom exporter / gateway.

⸻

8. Environment & multi-tenant considerations

Some tips for production setups:
•	Use distinct otel.environment values per environment:
•	dev, staging, prod, ci, etc.
•	Use different Collectors/credentials per environment where possible.
•	In multi-tenant setups:
•	Consider adding a tenant attribute (e.g. via a Collector processor that injects tenant_id / team based on source IP or auth).
•	Use vendor-specific labels (e.g. X-Org-Id headers) in the OTLP HTTP exporter if required.  ￼

⸻

9. Privacy & data minimization
   •	Keep log_user_prompt = false unless you really need full prompt text in your observability backend.
   •	You still get prompt_length and other metadata for high-level metrics.
   •	If you enable prompt logging:
   •	Restrict access to the backend indexes storing codex.user_prompt.
   •	Consider a Collector processor to mask or drop sensitive fields before export.

⸻

10. Quick checklist
    1.	Enable OTEL in Codex
          •	Add [otel] to ~/.codex/config.toml with environment, log_user_prompt, and exporter.
    2.	Run an OTLP receiver
          •	Typically an OpenTelemetry Collector with an otlp receiver (HTTP or gRPC) and a logs pipeline.
    3.	Point Codex at the Collector
          •	endpoint = "http://collector-host:4318/v1/logs" for OTLP/HTTP; or endpoint = "collector-host:4317" for OTLP/gRPC.
    4.	Define derived metrics
          •	Use codex.api_request, codex.sse_event, and codex.tool_result to build SLOs and dashboards.
    5.	Harden for prod
          •	Use TLS/mTLS on endpoints, keep prompts redacted by default, and monitor Collector health.
