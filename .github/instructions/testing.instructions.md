---
description: 'Java unit testing standards with JUnit 5, minimal mocking, full branch coverage, and fast execution.'
applyTo: '**/*Test*.java'
---

# Java Unit Testing Standards

## Test Structure

```java
// ✅ Use @Nested to group by method, @DisplayName for readability
@DisplayName("OrderService")
class OrderServiceTest {

    @Nested
    @DisplayName("createOrder")
    class CreateOrder {

        @Test
        @DisplayName("should create order when request is valid")
        void shouldCreateOrderWhenRequestIsValid() {
            // Arrange — set up test data with real objects and builders
            var request = CreateOrderRequestBuilder.aRequest()
                .withCustomerId(1L)
                .withItems(List.of(OrderItemBuilder.anItem().build()))
                .build();

            // Act — call the method under test
            var result = service.createOrder(request);

            // Assert — verify with AssertJ
            assertThat(result).isNotNull();
            assertThat(result.getStatus()).isEqualTo(OrderStatus.CREATED);
        }

        @Test
        @DisplayName("should throw BusinessException when customer not found")
        void shouldThrowWhenCustomerNotFound() {
            // ...
        }
    }
}
```

## AAA Pattern (Arrange-Act-Assert)

Every test follows this strict order:
1. **Arrange** — set up test data, configure dependencies
2. **Act** — call exactly one method under test
3. **Assert** — verify the result with fluent assertions

## Mock Minimization (Priority Order)

```java
// ✅ Priority 1: REAL OBJECTS — use actual implementations
var mapper = new OrderMapper();           // real mapper, no external deps
var validator = new OrderValidator();      // real validator, no external deps

// ✅ Priority 2: TEST BUILDERS — construct realistic test data
var order = OrderBuilder.anOrder().withStatus(OrderStatus.CREATED).build();

// ✅ Priority 3: FAKES — simplified implementations
var fakeNotifier = new FakeEmailNotifier(); // in-memory, records calls

// ✅ Priority 4: STUBS — simple return-value mocks for external deps ONLY
when(repository.findById(1L)).thenReturn(Optional.of(testOrder));

// ✅ Priority 5: MOCKS WITH VERIFY — only for interaction testing
verify(repository).save(any(Order.class));

// ✅ Priority 6: REFLECTION — last resort for private methods
Method method = OrderService.class.getDeclaredMethod("validateInternal", Order.class);
method.setAccessible(true);

// ❌ DON'T mock what you own (unless it has external deps)
var mapper = mock(OrderMapper.class);      // ❌ OrderMapper is pure logic, use real
var validator = mock(OrderValidator.class); // ❌ OrderValidator is pure logic, use real
```

## Test Builders

```java
// ✅ Create builders for test data reuse
public class OrderBuilder {
    private Long id = 1L;
    private OrderStatus status = OrderStatus.CREATED;
    private Long customerId = 1L;
    private List<OrderItem> items = List.of();
    private BigDecimal total = BigDecimal.TEN;

    public static OrderBuilder anOrder() { return new OrderBuilder(); }
    public OrderBuilder withId(Long id) { this.id = id; return this; }
    public OrderBuilder withStatus(OrderStatus s) { this.status = s; return this; }
    public OrderBuilder withCustomerId(Long id) { this.customerId = id; return this; }
    public OrderBuilder withItems(List<OrderItem> items) { this.items = items; return this; }
    public OrderBuilder withTotal(BigDecimal total) { this.total = total; return this; }

    public Order build() {
        var order = new Order();
        order.setId(id);
        order.setStatus(status);
        order.setCustomerId(customerId);
        order.setItems(items);
        order.setTotal(total);
        return order;
    }
}
```

## Branch Coverage

Cover **ALL** branches — every decision point must be tested:

```java
// Given this source method with 4 branches:
public BigDecimal calculateDiscount(Order order) {
    if (order.getType() == CustomerType.VIP) {          // branch 1-2
        if (order.getTotal().compareTo(THRESHOLD) > 0) { // branch 3-4
            return order.getTotal().multiply(HIGH_RATE);
        }
        return order.getTotal().multiply(LOW_RATE);
    }
    return BigDecimal.ZERO;
}

// You MUST write tests for ALL 4 paths:
// 1. VIP + above threshold → HIGH_RATE
// 2. VIP + at/below threshold → LOW_RATE
// 3. Non-VIP → ZERO
// Also test: null order, null total, boundary (exactly at threshold)
```

Branch types to cover:
- `if/else` — both TRUE and FALSE
- `switch` — every case + default
- `try/catch` — success path AND exception path
- Ternary `? :` — both outcomes
- `Optional.map/orElse` — present AND empty
- Loops — 0 iterations, 1, many

## AssertJ Assertions

```java
// ✅ Fluent, readable assertions
assertThat(result).isNotNull();
assertThat(result.getStatus()).isEqualTo(OrderStatus.CREATED);
assertThat(result.getItems()).hasSize(3)
    .extracting(Item::getName)
    .containsExactly("A", "B", "C");

// ✅ Exception assertions
assertThatThrownBy(() -> service.process(null))
    .isInstanceOf(BusinessException.class)
    .hasMessageContaining("required");

// ✅ Soft assertions for multiple checks
assertSoftly(softly -> {
    softly.assertThat(result.getId()).isNotNull();
    softly.assertThat(result.getStatus()).isEqualTo(OrderStatus.CREATED);
    softly.assertThat(result.getTotal()).isEqualByComparingTo("100.00");
});
```

## Performance Rules

- **Target < 100ms per test** — unit tests must be fast
- **❌ No `Thread.sleep()`** — use mocked clocks or `Awaitility`
- **❌ No shared mutable state** — each test is fully independent
- **❌ No network calls** in unit tests — use WireMock for integration tests
- **❌ No database calls** in unit tests — mock repositories or use H2 for integration

## Test Naming

```java
// ✅ Descriptive: should [expected behavior] when [condition]
@DisplayName("should return empty list when no orders match status")
@DisplayName("should throw NotFoundException when customer ID is invalid")
@DisplayName("should apply VIP discount when customer type is VIP and total exceeds threshold")

// ❌ Non-descriptive
@DisplayName("test1")
@DisplayName("testCreateOrder")
```
