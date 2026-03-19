---
description: 'Error handling patterns for enterprise Java applications including exception hierarchy, error codes, retry policies, circuit breakers, and fault tolerance strategies.'
applyTo: '**/*.java'
---

# Error Handling Standards

## Exception Hierarchy
Design a clear exception hierarchy for the application:

```
RuntimeException
├── BusinessException              (422 — business rule violations)
│   ├── ValidationException        (400 — input validation failures)
│   ├── ResourceNotFoundException  (404 — entity not found)
│   ├── DuplicateResourceException (409 — conflict/duplicate)
│   └── InsufficientPermissionException (403 — authorization)
├── IntegrationException           (502 — external service failures)
│   ├── ServiceUnavailableException (503 — downstream not reachable)
│   └── TimeoutException           (504 — downstream timeout)
└── InfrastructureException        (500 — unexpected infrastructure errors)
```

## Exception Design
```java
public class BusinessException extends RuntimeException {
    private final String errorCode;    // Machine-readable: "ORDER_NOT_FOUND"
    private final String message;      // Human-readable: "Order with ID 123 was not found"

    // Optional: additional context
    private final Map<String, Object> details;
}
```

## Error Codes
- Use `DOMAIN_ACTION_REASON` format: `ORDER_CREATE_INSUFFICIENT_STOCK`
- Define error codes as constants or enums — never use magic strings
- Document all error codes in a central location
- Error codes are stable across versions — never change their meaning

## Exception Handling Rules

### Do
- Catch specific exceptions, not generic `Exception`
- Add context when rethrowing: wrap with domain-specific exception
- Log exceptions at the point of handling, not at every rethrow
- Use `try-with-resources` for all `AutoCloseable` resources
- Return appropriate HTTP status codes via exception mappers

### Don't
- Don't use exceptions for flow control (if/else is cheaper)
- Don't catch and ignore silently — at minimum log a warning
- Don't catch `Throwable` unless you're in a top-level error handler
- Don't log and rethrow the same exception (causes duplicate log entries)
- Don't expose implementation details in client-facing error messages

```java
// ✅ Good — catch specific, add context, rethrow domain exception
try {
    return externalService.getPrice(productId);
} catch (ConnectException ex) {
    throw new ServiceUnavailableException("PRICING_SERVICE_UNAVAILABLE",
        "Pricing service is not reachable", ex);
}

// ❌ Bad — catch generic, log and rethrow
try {
    return externalService.getPrice(productId);
} catch (Exception ex) {
    log.error("Error", ex);  // duplicate logging
    throw ex;                // loses context
}
```

## REST Exception Mappers
- Map each exception type to appropriate HTTP status
- Return consistent error response format
- Log ERROR for 5xx, WARN for 4xx (except 404 which may be INFO)
- Include `requestId` in error responses for troubleshooting

## Retry & Fault Tolerance

### Retry Policy
- Retry only **idempotent** operations (GET, PUT, DELETE — not POST)
- Retry only on **transient** failures (timeout, 503, connection reset)
- Use exponential backoff: 100ms → 200ms → 400ms (max 3 retries)
- Log each retry attempt with attempt number

### Circuit Breaker
- Use circuit breaker for external service calls
- States: CLOSED (normal) → OPEN (failing) → HALF-OPEN (testing)
- Log state transitions at WARN level
- Provide fallback behavior when circuit is OPEN

### Timeout Strategy
- Set explicit timeouts for all external calls (connect + read)
- Connection timeout: 2-5 seconds
- Read timeout: 5-30 seconds (depends on operation)
- Set database query timeout via JPA hints

## Null Handling
- Use `Optional<T>` for method returns that may be absent
- Use `@NotNull`/`@Nullable` annotations for method parameters
- Never return `null` from collections — return empty collections
- Validate inputs at the boundary — fail fast before business logic
