Gemini CLI Telemetry & OpenTelemetry Integration

This document explains how to enable and configure telemetry for Gemini CLI, what logs and metrics it produces, and how to export them via OpenTelemetry (OTEL) to:
•	Local files
•	A local OTEL Collector + Jaeger (dev)
•	Any OTEL backend (Prometheus, Loki, Datadog, etc.)
•	Google Cloud Logging / Monitoring / Trace

Gemini CLI’s observability is built on OpenTelemetry and can emit logs, metrics, and traces that follow GenAI semantic conventions.  ￼

⸻

1. Architecture overview

At a high level:

Gemini CLI  ──(OTLP logs/metrics/traces)──>  OTEL Collector / Backend
│
├─ File output (local debugging)
└─ Direct export to Google Cloud (optional)

Core points:
•	Instrumentation is built in. Gemini CLI is already instrumented with OTEL; you just turn it on and decide where to send the data.  ￼
•	Telemetry includes:
•	Logs: detailed events (sessions, tools, API, files, routing, etc.).
•	Metrics: counters and histograms for sessions, tools, API latency, tokens, performance, etc.
•	Traces: spans for model calls and workflows (visible in Jaeger or Cloud Trace when using collectors).  ￼
•	You control telemetry via:
•	Settings files (~/.gemini/settings.json, .gemini/settings.json)
•	Environment variables
•	CLI flags (gemini ... --telemetry ...)  ￼

⸻

2. Configuration basics

2.1 Settings files & precedence

Gemini reads configuration from:
•	User settings: ~/.gemini/settings.json
•	Workspace settings: <project>/.gemini/settings.json

Telemetry configuration lives in a "telemetry" object in these files.  ￼

Order of precedence (highest wins):  ￼
1.	CLI flags (e.g. --telemetry, --telemetry-target, etc.)
2.	Environment variables
3.	Workspace settings (.gemini/settings.json)
4.	User settings (~/.gemini/settings.json)
5.	Defaults

Default values if nothing is set:  ￼
•	telemetry.enabled: false
•	telemetry.target: "local"
•	telemetry.otlpEndpoint: "http://localhost:4317"
•	telemetry.otlpProtocol: "grpc"
•	telemetry.logPrompts: true

2.2 Telemetry configuration fields

All telemetry behavior is controlled through .gemini/settings.json (or overridden by env/flags). Key fields:  ￼

JSON field	Env var	Meaning
enabled	GEMINI_TELEMETRY_ENABLED	Turn telemetry on/off (true / false)
target	GEMINI_TELEMETRY_TARGET	Telemetry destination: "local" or "gcp"
otlpEndpoint	GEMINI_TELEMETRY_OTLP_ENDPOINT	OTLP collector endpoint URL
otlpProtocol	GEMINI_TELEMETRY_OTLP_PROTOCOL	"grpc" or "http"
outfile	GEMINI_TELEMETRY_OUTFILE	File path for local telemetry logs/metrics (overrides otlpEndpoint when set)
logPrompts	GEMINI_TELEMETRY_LOG_PROMPTS	Whether to include prompt text in logs (true / false)
useCollector	GEMINI_TELEMETRY_USE_COLLECTOR	Use external OTEL collector (advanced)
useCliAuth	GEMINI_TELEMETRY_USE_CLI_AUTH	Use same OAuth credentials as CLI for GCP telemetry (direct export only)

Boolean env vars treat "true" / "1" as enabled; anything else = false.  ￼

2.3 CLI flags

Useful flags for one-off runs:  ￼
•	--telemetry / --no-telemetry → override telemetry.enabled.
•	--telemetry-target <local|gcp> → override telemetry.target.
•	--telemetry-otlp-endpoint <URL> → override telemetry.otlpEndpoint.
•	--telemetry-otlp-protocol <grpc|http> → override telemetry.otlpProtocol.
•	--telemetry-log-prompts / --no-telemetry-log-prompts → override telemetry.logPrompts.
•	--telemetry-outfile <path> → write telemetry to a file (local target).

Example:

gemini --telemetry \
--telemetry-target=local \
--telemetry-otlp-endpoint="http://localhost:4318" \
--telemetry-otlp-protocol=http


⸻

3. Quick-start recipes

3.1 Minimal: local file telemetry

Good for debugging and understanding what’s emitted before wiring any collectors.
1.	In your project, create .gemini/settings.json:

{
"telemetry": {
"enabled": true,
"target": "local",
"otlpEndpoint": "",
"outfile": ".gemini/telemetry.log",
"logPrompts": false
}
}

	•	otlpEndpoint is set to empty string to force file-only output.  ￼
	•	logPrompts: false avoids logging raw prompt text.

	2.	Run Gemini CLI:

gemini --telemetry "Explain OpenTelemetry in 2 sentences"

	3.	Inspect .gemini/telemetry.log – you’ll see OTEL logs/metrics encoded in a text format (depending on exporter implementation).  ￼

⸻

3.2 Local dev: Jaeger + OTEL Collector (automated)

Gemini provides a helper script that sets up a local OTEL Collector + Jaeger and wires telemetry automatically.
1.	From the root of the gemini-cli repo (or cloned workspace), run:  ￼

npm run telemetry -- --target=local

The script will:
•	Download and start Jaeger and otelcol-contrib if needed.
•	Configure your .gemini/settings.json for local telemetry.
•	Start a collector that receives OTLP from Gemini CLI.
•	Expose Jaeger UI at http://localhost:16686.
•	Write collector logs to ~/.gemini/tmp/<projectHash>/otel/collector.log.

	2.	In a second terminal, run Gemini CLI normally:

gemini --telemetry "Refactor this function to be more idiomatic TypeScript"

	3.	Open http://localhost:16686 to view traces and inspect logs/metrics in the collector log file.  ￼
	4.	Stop everything with Ctrl+C in the terminal running npm run telemetry.

⸻

3.3 Direct export to a generic OTLP backend

If you already have an OTEL Collector or vendor endpoint, you can send telemetry straight there.

3.3.1 Configure Gemini CLI
Example: send OTLP over HTTP to a collector at http://otel-collector:4318:

{
"telemetry": {
"enabled": true,
"target": "local",           // "local" is fine; target just affects helper scripts
"otlpEndpoint": "http://otel-collector:4318",
"otlpProtocol": "http",
"logPrompts": false
}
}

You can also override via env:

export GEMINI_TELEMETRY_ENABLED=true
export GEMINI_TELEMETRY_OTLP_ENDPOINT="http://otel-collector:4318"
export GEMINI_TELEMETRY_OTLP_PROTOCOL=http
gemini "Check this Spring Boot controller for bugs"

Gemini CLI will send OTLP telemetry (logs, metrics, traces) to that endpoint using the chosen protocol.  ￼

3.3.2 Example OTEL Collector config (logs+metrics+traces)
A minimal collector pipeline that receives OTLP and just dumps everything for debugging:

receivers:
otlp:
protocols:
grpc:
endpoint: 0.0.0.0:4317
http:
endpoint: 0.0.0.0:4318

processors:
batch: {}

exporters:
debug:
verbosity: detailed

service:
pipelines:
logs:
receivers: [otlp]
processors: [batch]
exporters: [debug]
metrics:
receivers: [otlp]
processors: [batch]
exporters: [debug]
traces:
receivers: [otlp]
processors: [batch]
exporters: [debug]

This is standard OTEL Collector configuration; you can swap debug for vendor-specific exporters (Datadog, OTLP to Loki/Tempo, etc.).  ￼

⸻

3.4 Google Cloud telemetry

Gemini has first-class GCP integration – you can either export directly to Cloud Logging / Monitoring / Trace or via a collector.  ￼

3.4.1 Prerequisites
Before using GCP export:  ￼
1.	Set your GCP project ID:

# Telemetry in separate project:
export OTLP_GOOGLE_CLOUD_PROJECT="your-telemetry-project-id"

# Or same project as inference:
export GOOGLE_CLOUD_PROJECT="your-project-id"

	2.	Authenticate:

# User account:
gcloud auth application-default login

# Or service account:
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"

	3.	Ensure your account/service account has these roles on the telemetry project:

	•	roles/cloudtrace.agent (Cloud Trace Agent)
	•	roles/monitoring.metricWriter (Monitoring Metric Writer)
	•	roles/logging.logWriter (Logs Writer)

	4.	Enable APIs (once per project):

gcloud services enable \
cloudtrace.googleapis.com \
monitoring.googleapis.com \
logging.googleapis.com \
--project="$OTLP_GOOGLE_CLOUD_PROJECT"

3.4.2 Direct export (recommended)
No collector; CLI sends directly to GCP OTEL-backed services.  ￼
1.	Settings:

{
"telemetry": {
"enabled": true,
"target": "gcp",
"logPrompts": false
}
}

	2.	Optionally use Gemini CLI OAuth credentials instead of ADC:

{
"telemetry": {
"enabled": true,
"target": "gcp",
"useCliAuth": true
}
}

useCliAuth requires direct export and must not be combined with useCollector: true. If both are enabled, telemetry is disabled and an error is logged.  ￼

	3.	Run Gemini CLI and then open:

	•	Logs: Google Cloud Console → Logging  ￼
	•	Metrics: Monitoring → Metrics Explorer
	•	Traces: Trace → Trace List

3.4.3 Collector-based export to GCP
Use a local OTEL Collector that forwards to Google Cloud.
1.	Settings:

{
"telemetry": {
"enabled": true,
"target": "gcp",
"useCollector": true
}
}

	2.	From the repo root, run:  ￼

npm run telemetry -- --target=gcp

The script will:
•	Download and start otelcol-contrib (if needed).
•	Configure the collector to export to your GCP project.
•	Update .gemini/settings.json (enable telemetry, often disable sandbox).
•	Provide direct links to Logs / Metrics / Traces in Cloud Console.
•	Write collector logs to ~/.gemini/tmp/<projectHash>/otel/collector-gcp.log.

	3.	Run Gemini CLI in another terminal and inspect telemetry in Cloud Console.
	4.	Stop the collector with Ctrl+C; the script attempts to restore your original settings.  ￼

⸻

4. Logs & metrics reference (what you actually get)

Gemini attaches session.id, installation.id and optionally user.email as common attributes on all logs/metrics.  ￼

Below is a condensed view; the official doc has the full list.

4.1 Log events

All logs are timestamped OTEL events.

4.1.1 Sessions  ￼
•	gemini_cli.config: emitted once at startup; describes CLI configuration.
•	Examples: model, sandbox_enabled, approval_mode, mcp_servers, extensions, output_format, etc.
•	gemini_cli.user_prompt: every user prompt.
•	Attributes: prompt_length, prompt_id, prompt (if logPrompts), auth_type.

4.1.2 Tools  ￼
•	gemini_cli.tool_call: every tool (function) call.
•	function_name, function_args, duration_ms, success, decision (accept/reject/auto_accept/modify), error, tool_type (native/mcp), mcp_server_name, extension_name, content_length, optional metadata.
•	gemini_cli.tool_output_truncated: a tool’s output was truncated.
•	gemini_cli.smart_edit_strategy / smart_edit_correction: Smart Edit behavior.
•	gen_ai.client.inference.operation.details: detailed GenAI event following OTEL GenAI semantic conventions (model, token counts, messages, finish reasons, temperature, etc.).  ￼

4.1.3 Files  ￼
•	gemini_cli.file_operation: every file operation from tools.
•	tool_name, operation (“create”/“read”/“update”), optional lines, mimetype, extension, programming_language.

4.1.4 API  ￼
•	gemini_cli.api_request: request to Gemini API.
•	model, prompt_id, request_text (optional).
•	gemini_cli.api_response: response from Gemini API.
•	status_code, duration_ms, detailed token counts (input_token_count, output_token_count, cached_content_token_count, thoughts_token_count, tool_token_count, total_token_count), response_text (optional), finish_reasons, auth_type.
•	gemini_cli.api_error: failed API request, with error, error_type, status_code, duration_ms.

4.1.5 Model routing & chat  ￼
•	gemini_cli.slash_command, gemini_cli.slash_command.model
•	gemini_cli.model_routing: router decision, latency, reason.
•	gemini_cli.chat_compression: tokens before/after compression.
•	gemini_cli.chat.invalid_chunk, chat.content_retry, chat.content_retry_failure
•	gemini_cli.conversation_finished, gemini_cli.next_speaker_check

4.1.6 Resilience, extensions, agent runs, IDE, UI  ￼
•	Resilience: flash_fallback, ripgrep_fallback, web_fetch_fallback_attempt
•	Extensions: install/uninstall/enable/disable/update events with extension id/version/source.
•	Agent runs: gemini_cli.agent.start / agent.finish (duration, turns, termination reason).
•	IDE: gemini_cli.ide_connection
•	UI: kitty_sequence_overflow, with sequence_length, truncated_sequence.

⸻

4.2 Metrics

Metric names and types are defined in the telemetry docs.  ￼

Highlights:

Sessions
•	gemini_cli.session.count (Counter) – increments once per CLI startup.

Tools
•	gemini_cli.tool.call.count (Counter) – tool calls; attributes: function_name, success, decision, tool_type.
•	gemini_cli.tool.call.latency (Histogram, ms) – tool latency by function_name.

API
•	gemini_cli.api.request.count (Counter) – all API requests; attributes: model, status_code, error_type.
•	gemini_cli.api.request.latency (Histogram) – request latency by model.

Token usage
•	gemini_cli.token.usage (Counter) – token usage; attributes: model, type (input, output, thought, cache, tool).

Files
•	gemini_cli.file.operation.count (Counter) – file ops; attributes: operation, plus optional lines, mimetype, extension, programming_language.
•	gemini_cli.lines.changed (Counter) – lines added/removed per function_name and type (added / removed).  ￼

Chat & routing
•	gemini_cli.chat_compression (Counter) – tokens before/after compression.
•	gemini_cli.chat.invalid_chunk.count, chat.content_retry.count, chat.content_retry_failure.count.
•	gemini_cli.slash_command.model.call_count (Counter).
•	gemini_cli.model_routing.latency (Histogram).
•	gemini_cli.model_routing.failure.count (Counter).

Agent runs, UI, performance
•	gemini_cli.agent.run.count (Counter), gemini_cli.agent.duration (Histogram), gemini_cli.agent.turns (Histogram).
•	gemini_cli.ui.flicker.count (Counter).
•	Performance: startup duration, memory usage, CPU usage, tool queue depth, phase breakdowns, token efficiency, regression detection, etc. (various histograms/counters).  ￼

⸻

5. Example use cases / dashboards

Once telemetry is flowing into your OTEL pipeline, some practical things to chart:
1.	Request volume & error rate per model
•	gemini_cli.api.request.count grouped by model and status_code.
•	Error rate: percentage of counts where status_code ≥ 400 or error_type not null.
2.	Latency SLOs
•	gemini_cli.api.request.latency histogram → p95 latency per model.
•	gemini_cli.tool.call.latency per function_name.
3.	Token usage & cost modeling
•	gemini_cli.token.usage grouped by model and type.
•	Combine with pricing table externally to estimate costs per project or per user.
4.	Code change analytics
•	gemini_cli.lines.changed and gemini_cli.file.operation.count to measure how many lines are added/removed by AI vs user.
5.	Stability & resilience
•	gemini_cli.chat.content_retry.count / chat.content_retry_failure.count.
•	gemini_cli.flash_fallback counts, to see how often you fall back to flash models.
6.	Agent workflow health
•	gemini_cli.agent.run.count, agent.duration, agent.turns by agent_name.
•	Check which agents are noisy/slow or frequently terminated with specific reasons.

⸻

6. Privacy & governance

A few knobs you’ll probably care about:
•	Prompt logging:
•	telemetry.logPrompts / --telemetry-log-prompts controls whether the actual prompt text is included in logs.
•	When disabled, you still get prompt_length and other metadata.  ￼
•	User identity:
•	user.email may be included when authenticated with a Google account – treat this as personal data.  ￼
•	Separation of concerns:
•	Use different projects / OTEL endpoints per environment (dev/staging/prod).
•	Consider Collector processors to redact or hash sensitive fields before exporting.

⸻

7. Checklist
    1.	Pick a destination
          •	Local file, local OTEL Collector+Jaeger, your existing OTEL pipeline, or Google Cloud.
    2.	Enable telemetry
          •	Set "telemetry": { "enabled": true, ... } in .gemini/settings.json or use --telemetry.
    3.	Configure target + OTLP details
          •	target: "local" for generic OTLP/file.
          •	target: "gcp" for Google Cloud; optionally useCliAuth or useCollector.
    4.	Wire a collector/backend
          •	For generic OTLP: run otelcol with OTLP receiver and exporters (debug, vendor).
          •	For GCP: npm run telemetry -- --target=gcp or direct export.
    5.	Verify
          •	Send a few prompts, then:
          •	Inspect file logs or collector logs.
          •	Visit Jaeger (http://localhost:16686) or Cloud Logging/Trace.
    6.	Build dashboards & alerts
          •	Use the metric and log names above as the basis for SLOs, usage analytics, and governance.
