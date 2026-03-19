---
description: 'Logging and observability standards including structured logging, log levels, correlation IDs, metrics, and monitoring best practices for enterprise Java applications.'
applyTo: '**/*.java'
---

# Logging & Observability Standards

## Logging Framework
- Use SLF4J as the logging facade — never use `System.out.println` or `java.util.logging`
- Use parameterized messages — never concatenate strings
```java
// ✅ Parameterized
log.info("Processing order {} for customer {}", orderId, customerId);

// ❌ String concatenation
log.info("Processing order " + orderId + " for customer " + customerId);
```

## Log Levels
- **ERROR** — Something failed that requires immediate attention. System cannot fulfill the request. Include exception and context.
- **WARN** — Unexpected condition but system recovered. May require attention if recurring. Examples: fallback used, retry succeeded, deprecated API called.
- **INFO** — Key business events and state transitions. Examples: order created, payment processed, user logged in. Keep concise.
- **DEBUG** — Detailed diagnostic information for troubleshooting. Method entry/exit, intermediate calculations, query parameters.
- **TRACE** — Very detailed, high-volume data. Full request/response bodies, serialized objects. Typically disabled in production.

## What to Log

### Always Log (INFO)
- Request received: endpoint, key parameters (not full body)
- Business state transitions: status changes, key decisions
- External service calls: service name, duration, success/failure
- Scheduled job execution: start, end, items processed
- Security events: login, logout, authorization failures

### Log on Error (ERROR)
- Full exception with stack trace
- Input that caused the error (sanitized)
- Current state / context for debugging
- Correlation ID for request tracing

### Never Log
- Passwords, tokens, API keys, secrets
- Full credit card numbers, SSN, PII
- Full request/response bodies in production (use DEBUG/TRACE)
- Redundant messages in loops (log summary instead)

## Structured Logging
- Use MDC (Mapped Diagnostic Context) for correlation:
```java
MDC.put("requestId", requestId);
MDC.put("userId", userId);
try {
    log.info("Processing order {}", orderId);
    // ... business logic
} finally {
    MDC.clear();
}
```

## Correlation IDs
- Generate a unique `requestId` for every incoming HTTP request
- Propagate it via MDC to all log entries within the request
- Pass it to downstream services via `X-Request-Id` header
- Include it in error responses for client troubleshooting

## Performance Logging
- Log duration of external calls, database queries, and expensive operations
```java
long start = System.currentTimeMillis();
var result = externalService.call(request);
log.info("External service call completed in {}ms, status={}", 
    System.currentTimeMillis() - start, result.getStatus());
```

## Log Format
- Use consistent structured format (JSON in production recommended):
```
timestamp | level | requestId | class | message | exception
```

## Monitoring & Alerting
- Expose health check endpoints (`/health`, `/ready`)
- Track key metrics: request count, error rate, latency (p50/p95/p99)
- Set alerts on: error rate spikes, latency degradation, queue depth
- Use circuit breaker patterns for external service calls — log state changes
