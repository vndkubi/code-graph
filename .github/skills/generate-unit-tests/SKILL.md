---
name: generate-unit-tests
description: 'Generate comprehensive unit tests for Java classes with minimal mocking. Analyzes all code branches (if/switch/ternary/try-catch/loops), creates test builder classes, uses real objects over mocks whenever possible, applies reflection only as last resort for private methods. Outputs JUnit 5 tests with @Nested grouping, @DisplayName, AssertJ assertions, and AAA pattern. Use when asked to write tests, improve test coverage, or generate tests for existing code.'
---

# Generate Unit Tests

Create comprehensive, fast unit tests that minimize mocking and cover all business logic branches.

## When to Use

- Writing tests for new code
- Improving test coverage for existing code
- Replacing mock-heavy tests with better alternatives
- Creating test builders and fixtures

## Workflow

### Step 1: Analyze Target Class

1. Read the source class to test
2. Identify ALL branches: `if/else`, `switch`, ternary `? :`, `try/catch`, loops, `Optional.map/orElse`
3. Count expected test cases (one per branch path minimum)
4. Identify dependencies: which can be real, which must be mocked

### Step 2: Create Test Builders

For each entity/DTO used as input, create or reuse a test builder:

```java
public class OrderBuilder {
    private Long id = 1L;
    private OrderStatus status = OrderStatus.CREATED;
    // ... defaults for all fields

    public static OrderBuilder anOrder() { return new OrderBuilder(); }
    public OrderBuilder withId(Long id) { this.id = id; return this; }
    public OrderBuilder withStatus(OrderStatus s) { this.status = s; return this; }
    public Order build() { /* construct and return */ }
}
```

### Step 3: Determine Mock Strategy

Priority order:
1. **Real objects** — use actual implementations
2. **Test builders** — construct test data with builders
3. **Fakes** — simplified implementations
4. **Stubs** — simple return-value mocks (for external deps only)
5. **Mocks** — interaction testing (only when behavior verification matters)
6. **Reflection** — private/protected access (last resort, only when refactoring is not an option)

### Step 4: Write Tests

Structure:
```java
@DisplayName("ClassName")
class ClassNameTest {
    @Nested
    @DisplayName("methodName")
    class MethodName {
        @Test
        @DisplayName("should [expected] when [condition]")
        void shouldExpectedWhenCondition() {
            // Arrange
            // Act
            // Assert (AssertJ)
        }
    }
}
```

### Step 5: Verify Coverage

- [ ] All `if` branches (true AND false)
- [ ] All `switch` cases + default
- [ ] All `try/catch` paths (success AND exception)
- [ ] Null/empty inputs
- [ ] Boundary values (0, max, min)
- [ ] Loop: zero iterations, one, many
- [ ] Each test < 100ms
- [ ] No shared mutable state between tests

## Validation

- [ ] Tests compile and pass with `mvn test`
- [ ] Zero unnecessary mocks (every mock is justified)
- [ ] All business branches covered
- [ ] Test names describe behavior, not implementation
