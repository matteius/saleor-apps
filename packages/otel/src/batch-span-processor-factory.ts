import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

export const createBatchSpanProcessor = (args: { accessToken: string | undefined }) => {
  // Support both ALB access token (legacy) and Elastic APM secret token
  const elasticSecretToken = process.env.ELASTIC_APM_SECRET_TOKEN;

  let headers: Record<string, string> | undefined;

  if (elasticSecretToken) {
    // Elastic APM uses Authorization header with Bearer token
    headers = { Authorization: `Bearer ${elasticSecretToken}` };
  } else if (args.accessToken) {
    // Legacy ALB access token
    headers = { "x-alb-access-token": args.accessToken };
  }

  return new BatchSpanProcessor(
    new OTLPTraceExporter({
      headers,
    }),
  );
};
