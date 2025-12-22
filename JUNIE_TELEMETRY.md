To configure OpenTelemetry or Langfuse traces for junie-cli in non-interactive mode, you can use environment variables.    
junie-cli supports standard OpenTelemetry environment variables for exporting traces.

1. OpenTelemetry Configuration

You can configure junie-cli to export traces to any OpenTelemetry-compatible backend like Jaeger, Honeycomb, or a local    
collector by setting the following environment variables:

# Enable OpenTelemetry exporting
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"                                                                 
export OTEL_SERVICE_NAME="junie-cli"
# Optional: Specify protocol (grpc or http/protobuf)
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"

2. Langfuse Configuration

Since Langfuse supports receiving traces via the OpenTelemetry protocol, you can route Junie's traces to Langfuse using    
their OTLP endpoint. You will need your Langfuse project's public and secret keys.

# Langfuse OTLP endpoint (check your region, e.g., cloud.langfuse.com)
export OTEL_EXPORTER_OTLP_ENDPOINT="https://cloud.langfuse.com/api/public/otlp"
# Langfuse authentication (Base64 encoded "pk-xxx:sk-xxx")
# You can generate this header or use Langfuse specific SDK vars if supported by the shim
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64_encoded_keys>"                                              
export OTEL_SERVICE_NAME="junie-cli"

3. Running in Non-Interactive Mode

When running junie-cli in a CI/CD environment or a script, ensure these variables are exported before executing the        
command:

OTEL_EXPORTER_OTLP_ENDPOINT="https://your-otel-collector:4317" \                                                           
OTEL_SERVICE_NAME="junie-task-agent" \                                                                                     
junie "Refactor the login logic in src/auth.py"

Summary of Key Environment Variables

| Variable | Description |                                                                                                 
   | :--- | :--- |                                                                                                            
| OTEL_EXPORTER_OTLP_ENDPOINT | The target URL for traces e.g., http://localhost:4317. |                                   
| OTEL_SERVICE_NAME | The name of the service as it will appear in your tracing UI. |                                      
| OTEL_EXPORTER_OTLP_HEADERS | Used for authentication e.g., API keys for Langfuse or Honeycomb. |                         
| OTEL_SDK_DISABLED | Set to true to explicitly disable tracing. |                                                         

Note: junie-cli automatically detects these standard variables and initializes the OpenTelemetry SDK accordingly during    
execution.                    
