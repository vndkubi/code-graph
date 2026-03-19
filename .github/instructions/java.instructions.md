---
description: 'Java coding standards for enterprise applications. Naming conventions, error handling, logging, null safety, and code organization. Includes version-specific guidance for Java 8, Java 11+, and Java 17+.'
applyTo: '**/*.java'
---

# Java Coding Standards

> **Version Note**: This file covers Java 8 baseline standards applicable to all Java projects.
> Additional modern idioms are marked with **[Java 11+]** or **[Java 17+]** — only apply them if the project's detected Java version matches.
> Java version is detected from `<java.version>` in `pom.xml`, `sourceCompatibility` in `build.gradle`, or `release` flag in compiler config.

## Naming Conventions

- **Classes**: `PascalCase` — `OrderService`, `CustomerRepository`
- **Methods/Variables**: `camelCase` — `findById`, `customerName`
- **Constants**: `UPPER_SNAKE_CASE` — `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT`
- **Packages**: lowercase, dot-separated — `com.company.project.orders`
- **Enums**: `PascalCase` type, `UPPER_SNAKE_CASE` values — `OrderStatus.PENDING`

## Imports

```java
// ❌ Avoid wildcard imports
import java.util.*;

// ✅ Prefer explicit imports
import java.util.List;
import java.util.Optional;
import java.util.Map;
```

Import ordering:
1. `java.*`
2. `javax.*` / `jakarta.*`
3. Third-party libraries
4. Project-internal packages
5. Static imports (last)

## Null Safety

```java
// ❌ Avoid returning null
public Customer findById(Long id) {
    return em.find(Customer.class, id); // may return null
}

// ✅ Use Optional for nullable returns
public Optional<Customer> findById(Long id) {
    return Optional.ofNullable(em.find(Customer.class, id));
}

// ❌ Don't use Optional as parameter
public void process(Optional<String> name) { }

// ✅ Use @Nullable annotation or overload
public void process(@Nullable String name) { }
```

## Error Handling

```java
// ✅ Use custom exception hierarchy with error codes
public class BusinessException extends RuntimeException {
    private final String errorCode;

    public BusinessException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }
}

// ✅ Specific exceptions for specific cases
public class EntityNotFoundException extends BusinessException {
    public EntityNotFoundException(String entity, Long id) {
        super("NOT_FOUND", entity + " with ID " + id + " not found");
    }
}

// ❌ Avoid catching generic Exception
try { ... } catch (Exception e) { ... }

// ✅ Catch specific exceptions
try { ... } catch (EntityNotFoundException e) { ... }
```

## Logging

```java
// ✅ SLF4J with parameterized messages
private static final Logger log = LoggerFactory.getLogger(OrderService.class);

log.info("Processing order {} for customer {}", orderId, customerId);
log.error("Failed to process order {}", orderId, exception);
log.debug("Order details: {}", order);

// ❌ Avoid string concatenation in logs
log.info("Processing order " + orderId); // evaluates even when INFO disabled
```

## Method Design

- Maximum 30 lines per method (excluding blank lines and comments)
- One responsibility per method
- Maximum 4 parameters — use an object for more
- Early return for guard clauses

```java
// ✅ Early return pattern
public OrderDto processOrder(Long orderId) {
    Order order = repository.findById(orderId)
        .orElseThrow(() -> new EntityNotFoundException("Order", orderId));

    if (order.isProcessed()) {
        return mapper.toDto(order); // early return
    }

    order.process();
    repository.save(order);
    return mapper.toDto(order);
}
```

## Object Construction

```java
// ✅ Builder pattern for objects with many fields
var response = OrderResponse.builder()
    .id(order.getId())
    .status(order.getStatus())
    .total(order.getTotal())
    .createdAt(order.getCreatedAt())
    .build();
```

## Resource Management

```java
// ✅ Try-with-resources for AutoCloseable
try (var connection = dataSource.getConnection();
     var statement = connection.prepareStatement(sql)) {
    // use resources
}
```

## Version-Specific Features

### [Java 11+] — Use if project targets Java 11 or higher

```java
// ✅ Local variable type inference
var orders = new ArrayList<Order>();
var result = orderService.findById(id);

// ✅ String methods
String trimmed = value.strip();           // Unicode-aware (prefer over trim())
boolean blank  = value.isBlank();
String repeated = "-".repeat(40);

// ✅ Collection factory methods (available since Java 9, common from 11)
List<String> names = List.of("Alice", "Bob");
Map<String, Integer> codes = Map.of("PENDING", 1, "ACTIVE", 2);
```

### [Java 17+] — Use if project targets Java 17 or higher

```java
// ✅ Records for immutable data carriers (replaces Lombok @Value / manual builders for DTOs)
public record OrderSummary(Long id, String status, BigDecimal total) {}

// ✅ Sealed classes for closed type hierarchies
public sealed interface PaymentResult
    permits PaymentSuccess, PaymentFailure, PaymentPending {}

public record PaymentSuccess(String transactionId) implements PaymentResult {}
public record PaymentFailure(String reason, int code) implements PaymentResult {}

// ✅ Pattern matching for instanceof (no more explicit cast)
// ❌ Old style
if (result instanceof PaymentSuccess) {
    PaymentSuccess s = (PaymentSuccess) result;
    log.info("Transaction: {}", s.transactionId());
}
// ✅ New style
if (result instanceof PaymentSuccess s) {
    log.info("Transaction: {}", s.transactionId());
}

// ✅ Switch expressions with pattern matching
String label = switch (result) {
    case PaymentSuccess s  -> "OK: " + s.transactionId();
    case PaymentFailure f  -> "FAIL: " + f.reason();
    case PaymentPending p  -> "PENDING";
};

// ✅ Text blocks for multiline strings (SQL, JSON, HTML)
String query = """
    SELECT o.id, o.status, c.name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.status = :status
    """;
```

> **Anti-pattern**: Do NOT use Records for JPA `@Entity` classes — JPA requires mutable classes with a no-arg constructor. Records are for DTOs, response objects, and value types only.

## Documentation

```java
// ✅ JavaDoc for public API methods
/**
 * Creates a new order for the given customer.
 *
 * @param request the order creation request with customer and items
 * @return the created order DTO
 * @throws EntityNotFoundException if the customer does not exist
 * @throws BusinessException if validation fails
 */
public OrderDto createOrder(CreateOrderRequest request) { }
```
