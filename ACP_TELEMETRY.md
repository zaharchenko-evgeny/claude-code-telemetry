# Agent Telemetry Export

* Author(s): [@codefromthecrypt](https://github.com/codefromthecrypt)
* Champion: [@benbrandt](https://github.com/benbrandt)

## Elevator pitch

> What are you proposing to change?

Define how agents export telemetry (logs, metrics, traces) to clients without tunneling it over the ACP transport. Clients run a local telemetry receiver and pass standard OpenTelemetry environment variables when launching agents. This keeps telemetry out-of-band and enables editors to display agent activity, debug issues, and integrate with observability backends.

## Status quo

> How do things work today and what problems does this cause? Why would we change things?

ACP defines how clients launch agents as subprocesses and communicate over stdio. The [meta-propagation RFD](./meta-propagation) addresses trace context propagation via `params._meta`, enabling trace correlation. However, there is no convention for how agents should export the actual telemetry data (spans, metrics, logs).

Without a standard approach:

1. **No visibility into agent behavior** - Editors cannot display what agents are doing (token usage, tool calls, timing)
2. **Difficult debugging** - When agents fail, there's no structured way to capture diagnostics
3. **Fragmented solutions** - Each agent/client pair invents their own telemetry mechanism
4. **Credential exposure risk** - If agents need to send telemetry directly to backends, they need credentials

Tunneling telemetry over the ACP stdio transport is problematic:

* **Head-of-line blocking** - Telemetry traffic could delay agent messages
* **Implementation burden** - ACP would need to define telemetry message formats
* **Coupling** - Agents would need ACP-specific telemetry code instead of standard SDKs

## What we propose to do about it

> What are you proposing to improve the situation?

Clients that want to receive agent telemetry run a local OTLP (OpenTelemetry Protocol) receiver and inject environment variables when launching agent subprocesses:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=agent-name
```

Agents using OpenTelemetry SDKs auto-configure from these variables. The client's receiver can:

* Display telemetry in the editor UI (e.g., token counts, timing, errors)
* Forward telemetry to the client's configured observability backend
* Add client-side context before forwarding

This follows the [OpenTelemetry collector deployment pattern](https://opentelemetry.io/docs/collector/deployment/agent/) where a local receiver proxies telemetry to backends.

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Client/Editor                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ ACP Handler  │    │OTLP Receiver │───▶│   Exporter   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
└────────┬─────────────────────▲──────────────────┬──────────┘
         │ stdio               │ HTTP             │
         ▼                     │                  ▼
┌─────────────────────┐        │         ┌───────────────────┐
│ Agent Process       │        │         │ Observability     │
│  ┌──────────────┐   │        │         │ Backend           │
│  │ ACP Agent    │   │        │         └───────────────────┘
│  ├──────────────┤   │        │
│  │ OTEL SDK     │────────────┘
│  └──────────────┘   │
└─────────────────────┘
```

### Discovery

Environment variables must be set before launching the subprocess, but ACP capability exchange happens after connection. Options for discovery:

1. **Optimistic injection** - Clients inject OTEL environment variables unconditionally. Agents without OpenTelemetry support simply ignore them. This is pragmatic since environment variables are low-cost and OTEL SDKs handle misconfiguration gracefully.

2. **Registry metadata** - Agent registries (like the one proposed in PR #289) could include telemetry support in agent manifests, letting clients know ahead of time.

3. **Manual configuration** - Users configure their client to enable telemetry collection for specific agents.

## Shiny future

> How will things will play out once this feature exists?

1. **Editor integration** - Editors can show agent activity: token usage, tool call timing, model switches, errors
2. **Unified debugging** - When agents fail, structured telemetry is available for diagnosis
3. **End-to-end traces** - Combined with `params._meta` trace propagation, traces flow from client through agent to any downstream services
4. **No credential sharing** - Agents never see backend credentials; the client handles authentication
5. **Standard SDKs** - Agent authors use normal OpenTelemetry SDKs that work in any context, not ACP-specific code

## Implementation details

> Tell me more about your implementation. What is your detailed implementation plan?

### 1. Create `docs/protocol/observability.mdx`

Add a new protocol documentation page covering observability practices for ACP. This page will describe:

**For Clients/Editors:**

* Running an OTLP receiver to collect agent telemetry
* Injecting `OTEL_EXPORTER_*` environment variables when launching agent subprocesses
* Respecting user-configured `OTEL_*` variables (do not override if already set)
* Forwarding telemetry to configured backends with client credentials

**For Agent Authors:**

* Using OpenTelemetry SDKs with standard auto-configuration
* Recommended spans, metrics, and log patterns for agent operations
* How telemetry flows when `OTEL_*` variables are present vs absent

### 2. Update `docs/protocol/extensibility.mdx`

Add a section linking to the new observability doc, similar to how extensibility concepts relate to other protocol features. Add a brief mention that observability practices (telemetry export) are documented separately.

### 3. Update `docs/docs.json`

Add `protocol/observability` to the Protocol navigation group.

## Frequently asked questions

> What questions have arisen over the course of authoring this document or during subsequent discussions?

### How does this relate to trace propagation in `params._meta`?

They are complementary:

* **Trace propagation** (`params._meta` with `traceparent`, etc.) passes trace context so spans can be correlated
* **Telemetry export** (this RFD) defines where agents send the actual span/metric/log data

Both are needed for end-to-end observability.

### What if an agent doesn't use OpenTelemetry?

Agents without OTEL SDKs simply ignore the environment variables. No harm is done. Over time, as more agents adopt OpenTelemetry, the ecosystem benefits.

### What if the user already configured `OTEL_*` environment variables?

If `OTEL_*` variables are already set in the environment, clients should not override them. User-configured telemetry settings take precedence, allowing users to direct agent telemetry to their own backends when desired.

### Why not define ACP-specific telemetry messages?

This would duplicate OTLP functionality, add implementation burden to ACP, and force agent authors to use non-standard APIs. Using OTLP means agents work with standard tooling and documentation.

### What about agents that aren't launched as subprocesses?

This RFD focuses on the stdio transport where clients launch agents. For other transports (HTTP, etc.), agents would need alternative configuration mechanisms, which could be addressed in future RFDs.

### What alternative approaches did you consider, and why did you settle on this one?

1. **Tunneling telemetry over ACP** - Rejected due to head-of-line blocking concerns and implementation complexity
2. **Agents export directly to backends** - Rejected because it requires sharing credentials with agents
3. **File-based telemetry** - Rejected because it doesn't support real-time display and adds complexity

The environment variable approach:

* Uses existing standards (OTLP, OpenTelemetry SDK conventions)
* Keeps telemetry out-of-band from ACP messages
* Lets clients control where telemetry goes without exposing credentials
* Requires no changes to ACP message formats

## Revision history

* 2025-12-04: Initial draft


---

> To find navigation and other pages in this documentation, fetch the llms.txt file at: https://agentclientprotocol.com/llms.txt

Below is the ACP-native way to do telemetry, plus a Langfuse-specific wiring that fits ACP’s security model.

ACP itself is JSON-RPC over stdio and the telemetry story is intentionally out-of-band: the client/editor runs a local OTLP receiver and injects standard OpenTelemetry env vars into the agent process at launch, instead of tunneling telemetry over ACP.  ￼

⸻

1) ACP telemetry model (what to implement)

1.1 Export path: Agent → local OTLP receiver (client-owned)

ACP’s “Agent Telemetry Export” RFD proposes:  ￼
•	The client/editor runs a local OTLP receiver (typically an OpenTelemetry Collector).
•	The client injects env vars when spawning the agent process, e.g.:

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=agent-name

Agents that use an OpenTelemetry SDK will auto-configure from these variables.  ￼

Why this matters (ACP’s rationale): keeps telemetry off the stdio channel, avoids head-of-line blocking, and avoids giving backend credentials to the agent.  ￼

Discovery / compatibility

Because env vars must be set before ACP capability exchange, the RFD recommends optimistic injection (always set OTEL vars; agents without OTEL just ignore them).  ￼

Don’t override user OTEL settings

If users already set OTEL_* variables, ACP clients should not override them.  ￼

⸻

1.2 Trace correlation across ACP calls: params._meta

ACP also standardizes how to propagate trace context inside ACP messages using params._meta. The meta-propagation RFD says clients should reserve root keys for W3C Trace Context:  ￼
•	_meta.traceparent
•	_meta.tracestate
•	_meta.baggage

This gives you end-to-end traces where:
•	the client creates / continues a trace,
•	injects trace context into ACP params._meta,
•	the agent extracts it and continues spans,
•	the agent’s OTEL exporter ships the resulting spans to the client-owned collector.  ￼

⸻

2) How to configure OpenTelemetry export for an ACP agent

2.1 Client/editor side (recommended)

Step A — run a local OTLP receiver

The most common choice is an OpenTelemetry Collector listening on OTLP/HTTP 4318.

Minimal collector that just receives OTEL (you can add exporters later):

receivers:
otlp:
protocols:
http:
endpoint: 0.0.0.0:4318

processors:
batch: {}

exporters:
debug:
verbosity: detailed

service:
pipelines:
traces:
receivers: [otlp]
processors: [batch]
exporters: [debug]

Step B — spawn the agent with OTEL env vars

When launching the agent subprocess, inject (or merge) env:
•	OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
•	OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
•	OTEL_SERVICE_NAME=<your-agent-name>  ￼

Pseudo-code (Node):

spawn("my-agent", ["--stdio"], {
env: {
...process.env, // important: respect user OTEL_*
OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
OTEL_EXPORTER_OTLP_PROTOCOL: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME ?? "my-acp-agent",
}
});

2.2 Agent side (author guidance)

Step C — instrument with an OpenTelemetry SDK

ACP doesn’t require a specific SDK; any OTEL SDK works as long as it can export via OTLP and you extract context from _meta.

Step D — extract W3C trace context from params._meta

On every ACP request, read _meta.traceparent, _meta.tracestate, _meta.baggage and feed them into your OTEL propagator so the spans created for that request attach to the client’s trace.  ￼

Conceptually:
•	ACP request arrives
•	carrier = params._meta (or a small map built from it)
•	ctx = propagator.extract(carrier)
•	start spans under ctx

⸻

3) Exporting ACP agent telemetry to Langfuse

Langfuse can receive OpenTelemetry traces on /api/public/otel and authenticates with HTTP Basic Auth in OTLP headers. It does not support OTLP/gRPC; use HTTP/protobuf.  ￼

There are two approaches:

3.1 Recommended (ACP-friendly): Client collector forwards to Langfuse

This preserves ACP’s “no credentials in agent” goal.  ￼

Collector config: receive from agent, export to Langfuse

receivers:
otlp:
protocols:
http:
endpoint: 0.0.0.0:4318

processors:
batch: {}
memory_limiter:
limit_mib: 1500
spike_limit_mib: 512
check_interval: 5s

exporters:
otlphttp/langfuse:
endpoint: "https://cloud.langfuse.com/api/public/otel"   # EU
# endpoint: "https://us.cloud.langfuse.com/api/public/otel" # US
headers:
Authorization: "Basic ${AUTH_STRING}"

service:
pipelines:
traces:
receivers: [otlp]
processors: [memory_limiter, batch]
exporters: [otlphttp/langfuse]

Langfuse notes:
•	If your exporter needs a signal-specific endpoint, use /api/public/otel/v1/traces.  ￼
•	Set AUTH_STRING as base64(public_key:secret_key).  ￼
•	Ensure HTTP/protobuf, not gRPC.  ￼

Then your ACP client still injects only:

OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=my-acp-agent

…and Langfuse export happens entirely client-side.

3.2 Possible but usually not recommended: Agent exports directly to Langfuse

This works technically (Langfuse publishes OTEL endpoint + auth header requirements), but it violates ACP’s “don’t hand credentials to agents” rationale.  ￼

If you still want it, you’d set in the agent environment:

OTEL_EXPORTER_OTLP_ENDPOINT="https://cloud.langfuse.com/api/public/otel"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic ${AUTH_STRING}"
OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"

(Use /api/public/otel/v1/traces if your OTEL library requires the trace-specific endpoint.)  ￼

⸻

4) What to emit (practical span design for ACP)

A simple, interoperable convention:
•	1 trace per ACP “session” (or per user request, if that’s how your client is structured)
•	Spans inside:
•	acp.initialize
•	acp.session.create / resume
•	acp.message.handle (per JSON-RPC call)
•	llm.generate / gen_ai.* spans for model calls
•	tool.call spans for tools and filesystem edits
•	Put stable identifiers in span attributes:
•	acp.session_id, acp.request_id, agent.name, client.name
•	Make sure the parent context comes from _meta.traceparent so all of this connects to the client trace.  ￼

Langfuse will map OTEL spans into its trace/observation model and supports additional property mappings for GenAI attributes.  ￼

⸻

Quick checklist

In the ACP client/editor
1.	Run OTLP receiver (Collector)
2.	Inject OTEL_EXPORTER_OTLP_* + OTEL_SERVICE_NAME when spawning the agent, without overriding user OTEL vars  ￼
3.	Add _meta.traceparent / tracestate / baggage on requests  ￼

In the agent
4) Use an OTEL SDK and export via OTLP
5) Extract trace context from params._meta and create spans under it  ￼

For Langfuse
6) Prefer Collector → Langfuse (otlphttp exporter + Basic Auth); HTTP/protobuf only  ￼

