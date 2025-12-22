What telemetry does Copilot CLI expose that you can reuse?

1) Session usage stats (interactive)

Copilot CLI provides a /usage slash command that shows:
•	premium requests used (current session)
•	session duration
•	lines of code edited
•	token usage breakdown per model  ￼

2) Debug logs and session state (files)

From the Copilot CLI repo announcements/issues:
•	sessions are stored in ~/.copilot/session-state (and legacy in ~/.copilot/history-session-state)  ￼
•	you can set a persistent log_level in ~/.copilot/config with values like none|error|warning|info|debug|all|default  ￼
•	logs are written under ~/.copilot/logs (example issue references DEBUG logs there)  ￼

These are useful inputs, but they aren’t already OTLP traces—you still need to transform them into spans/events.

⸻

How Langfuse wants OpenTelemetry data

Langfuse can act as an OpenTelemetry backend and receive OTLP over HTTP at:
•	https://cloud.langfuse.com/api/public/otel (EU)
•	https://us.cloud.langfuse.com/api/public/otel (US)
…and it authenticates via Basic Auth in the OTLP headers.  ￼

Important constraint: Langfuse does not support OTLP/gRPC for this endpoint; use OTLP/HTTP (http/protobuf).  ￼

Langfuse also documents attribute mapping you can use so your spans become rich Langfuse “traces / generations” (e.g., langfuse.trace.name, langfuse.observation.type, gen_ai.prompt, gen_ai.completion, model + usage fields).  ￼

⸻

Recommended bridge design (works today)

Option A (recommended): Wrap non-interactive Copilot CLI calls and emit OTEL spans

GitHub docs show you can run Copilot CLI with flags like:

copilot --agent=refactor-agent --prompt "Refactor this code block"

￼

So you can build a wrapper that:
1.	Executes copilot ... --prompt ... via subprocess
2.	Captures stdout/stderr + timing
3.	Emits an OTEL trace/span with Langfuse-friendly attributes
4.	Exports OTEL → Langfuse (directly or via an OTEL Collector)

This gives you clean “1 prompt = 1 trace” observability.

⸻

Configuration: exporting OTEL to Langfuse

1) Set Langfuse OTEL env vars (direct export)

Langfuse example (EU region):

export OTEL_EXPORTER_OTLP_ENDPOINT="https://cloud.langfuse.com/api/public/otel"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic ${AUTH_STRING}"
# IMPORTANT: must be HTTP/protobuf (Langfuse doesn’t support gRPC)
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"

(They also mention a traces-specific endpoint /api/public/otel/v1/traces if needed.)  ￼

To build AUTH_STRING, Langfuse recommends base64 encoding public_key:secret_key.  ￼

2) Or route through an OpenTelemetry Collector (often easier operationally)

Langfuse provides a collector snippet (receiver OTLP, exporter otlphttp/langfuse):  ￼

receivers:
otlp:
protocols:
grpc:
endpoint: 0.0.0.0:4317
http:
endpoint: 0.0.0.0:4318

processors:
batch:
memory_limiter:
limit_mib: 1500
spike_limit_mib: 512
check_interval: 5s

exporters:
otlphttp/langfuse:
endpoint: "https://cloud.langfuse.com/api/public/otel"
headers:
Authorization: "Basic ${AUTH_STRING}"

service:
pipelines:
traces:
receivers: [otlp]
processors: [memory_limiter, batch]
exporters: [otlphttp/langfuse]


⸻

Example: Python “copilot → Langfuse (OTEL)” wrapper

Install deps:

pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http

copilot_trace.py:

import os
import subprocess
import time
import json

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

def setup_tracing():
# Exports are driven by OTEL_EXPORTER_OTLP_* env vars; you can also hardcode here.
# Ensure OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf for Langfuse.
resource = Resource.create({
"service.name": "copilot-cli-bridge",
})

    provider = TracerProvider(resource=resource)
    trace.set_tracer_provider(provider)

    exporter = OTLPSpanExporter(
        endpoint=os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
                 or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        headers=dict(
            h.split("=", 1) for h in os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "").split(",") if "=" in h
        ) or None,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))

def run_copilot(prompt: str, agent: str | None = None) -> tuple[int, str, str, float]:
cmd = ["copilot"]
if agent:
cmd += [f"--agent={agent}"]
cmd += ["--prompt", prompt]

    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    dur = time.time() - t0
    return p.returncode, p.stdout, p.stderr, dur

def main():
setup_tracing()
tracer = trace.get_tracer("copilot-cli-bridge")

    prompt = os.environ.get("COPILOT_PROMPT", "Explain what this repo does.")
    agent = os.environ.get("COPILOT_AGENT")  # optional

    rc, out, err, dur = run_copilot(prompt, agent=agent)

    # Create a trace + generation-like span for Langfuse mapping
    with tracer.start_as_current_span("copilot-cli") as span:
        # Trace-level fields (appear on Langfuse trace)
        span.set_attribute("langfuse.trace.name", "copilot-cli-run")  # Langfuse trace name  [oai_citation:12‡langfuse.com](https://langfuse.com/integrations/native/opentelemetry)
        span.set_attribute("langfuse.trace.input", prompt)
        span.set_attribute("langfuse.trace.output", out.strip())

        # Observation-level fields (span mapped to generation/event/span)
        span.set_attribute("langfuse.observation.type", "generation")  #  [oai_citation:13‡langfuse.com](https://langfuse.com/integrations/native/opentelemetry)
        span.set_attribute("gen_ai.prompt", prompt)                    #  [oai_citation:14‡langfuse.com](https://langfuse.com/integrations/native/opentelemetry)
        span.set_attribute("gen_ai.completion", out.strip())           #  [oai_citation:15‡langfuse.com](https://langfuse.com/integrations/native/opentelemetry)

        # Useful metadata
        span.set_attribute("langfuse.observation.metadata.exit_code", str(rc))
        span.set_attribute("langfuse.observation.metadata.duration_s", f"{dur:.3f}")
        if agent:
            span.set_attribute("langfuse.observation.metadata.agent", agent)
        if err.strip():
            span.set_attribute("langfuse.observation.metadata.stderr", err.strip())

        # If you can extract token usage (e.g. from /usage in interactive mode),
        # you can also set gen_ai.usage.* to populate usage in Langfuse.  [oai_citation:16‡langfuse.com](https://langfuse.com/integrations/native/opentelemetry)

if __name__ == "__main__":
main()

Run it (example using Langfuse Cloud EU):

export AUTH_STRING="$(echo -n "pk-lf-xxx:sk-lf-yyy" | base64)"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://cloud.langfuse.com/api/public/otel"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic ${AUTH_STRING}"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"

export COPILOT_PROMPT="Refactor this function to be iterative instead of recursive."
export COPILOT_AGENT="refactor-agent"

python copilot_trace.py


⸻

Option B: Bridge from ~/.copilot/logs / ~/.copilot/session-state (interactive sessions)

This is doable, but more work:
•	You’d watch ~/.copilot/session-state (and/or parse ~/.copilot/logs)  ￼
•	For each user prompt / model response you detect, you emit an OTEL span with gen_ai.prompt / gen_ai.completion and Langfuse attributes  ￼
•	Export via OTLP/HTTP to Langfuse  ￼
