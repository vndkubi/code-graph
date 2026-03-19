---
name: generate-mobile-tests
description: 'Generate comprehensive unit and UI tests for Android (JUnit 5, MockK, Turbine, Compose Testing) and iOS (XCTest, Swift Testing) mobile applications. Analyzes all code branches, creates test builders and fake repositories, uses real objects over mocks whenever possible. Outputs structured tests covering all UI states and business logic branches. Use when asked to write tests, improve coverage, or generate tests for mobile code.'
---

# Generate Mobile Tests

Create comprehensive, fast tests for Android and iOS applications with minimal mocking.

## When to Use

- Writing tests for new mobile code (ViewModel, UseCase, Repository)
- Improving test coverage for existing code
- Replacing mock-heavy tests with fakes and real objects
- Creating test builders and fixtures
- Writing Compose UI tests or SwiftUI snapshot tests

## Workflow

### Step 1: Detect Platform & Test Framework

**Android:**
- JUnit 5 + AssertJ/Truth for unit tests
- MockK for mocking (when necessary)
- Turbine for Flow/StateFlow testing
- Compose Testing for UI tests
- Robolectric for Android framework classes

**iOS:**
- Swift Testing (`@Test`, `@Suite`) for iOS 18+
- XCTest (`XCTestCase`) for iOS 14+
- ViewInspector for SwiftUI view tests

### Step 2: Analyze Target Class

1. Read the source class to test
2. Identify ALL branches: `if/else`, `when/switch`, ternary, `try/catch`, `Result.onSuccess/onFailure`, sealed class states
3. Count expected test cases (one per branch path minimum)
4. Identify dependencies: which can use fakes, which need mocks

### Step 3: Create Test Infrastructure

#### Fake Repositories (preferred over mocks)

**Android:**
```kotlin
class FakeOrderRepository : OrderRepository {
    private val orders = mutableListOf<Order>()
    private var shouldFail = false

    fun setOrders(newOrders: List<Order>) { orders.clear(); orders.addAll(newOrders) }
    fun setShouldFail(fail: Boolean) { shouldFail = fail }

    override suspend fun getOrders(): Result<List<Order>> =
        if (shouldFail) Result.failure(IOException("Network error"))
        else Result.success(orders.toList())
}
```

**iOS:**
```swift
final class FakeOrderRepository: OrderRepositoryProtocol {
    var orders: [Order] = []
    var shouldFail = false

    func fetchOrders() async throws -> [Order] {
        if shouldFail { throw TestError.networkError }
        return orders
    }
}
```

#### Test Builders

**Android:**
```kotlin
object OrderBuilder {
    fun anOrder() = Builder()
    class Builder {
        private var id: Long = 1L
        private var status: String = "CREATED"
        fun withId(id: Long) = apply { this.id = id }
        fun withStatus(s: String) = apply { this.status = s }
        fun build() = Order(id = id, status = status)
    }
}
```

**iOS:**
```swift
extension Order {
    static func stub(id: UUID = UUID(), status: OrderStatus = .pending) -> Order {
        Order(id: id, customerId: UUID(), status: status, total: 99.99, items: [])
    }
}
```

### Step 4: Write Tests

#### Android ViewModel Test Structure
```kotlin
@ExtendWith(MainDispatcherExtension::class)
class OrderViewModelTest {
    private val fakeRepository = FakeOrderRepository()
    private lateinit var viewModel: OrderViewModel

    @BeforeEach
    fun setup() {
        viewModel = OrderViewModel(GetOrdersUseCase(fakeRepository))
    }

    @Nested
    @DisplayName("loadOrders")
    inner class LoadOrders {
        @Test
        @DisplayName("should emit Content when repository succeeds")
        fun success() = runTest {
            fakeRepository.setOrders(listOf(OrderBuilder.anOrder().build()))
            viewModel.uiState.test {
                assertThat(awaitItem()).isInstanceOf(UiState.Loading::class.java)
                val content = awaitItem() as UiState.Content
                assertThat(content.orders).hasSize(1)
            }
        }

        @Test
        @DisplayName("should emit Error when repository fails")
        fun failure() = runTest {
            fakeRepository.setShouldFail(true)
            viewModel.uiState.test {
                skipItems(1) // Loading
                assertThat(awaitItem()).isInstanceOf(UiState.Error::class.java)
            }
        }
    }
}
```

#### iOS ViewModel Test Structure
```swift
@Suite("OrderViewModel")
struct OrderViewModelTests {
    @Suite("loadOrders")
    struct LoadOrders {
        @Test("should set loaded state when repository succeeds")
        func success() async {
            let repo = FakeOrderRepository()
            repo.orders = [.stub()]
            let vm = OrderViewModel(repository: repo)
            await vm.loadOrders()
            guard case .loaded(let orders) = vm.state else { Issue.record("Expected loaded"); return }
            #expect(orders.count == 1)
        }
    }
}
```

### Step 5: Write UI Tests (if applicable)

**Android Compose:**
```kotlin
@get:Rule val composeRule = createComposeRule()

@Test
fun shouldDisplayOrdersWhenContentState() {
    val orders = listOf(OrderUiModel(1, "Order #1", "Confirmed"))
    composeRule.setContent {
        OrderListScreen(uiState = UiState.Content(orders), onOrderClick = {})
    }
    composeRule.onNodeWithText("Order #1").assertIsDisplayed()
}
```

### Step 6: Verify Coverage

- [ ] All `if/when/switch` branches (true AND false)
- [ ] All UI states (Loading, Content, Error, Empty)
- [ ] All `Result.onSuccess/onFailure` paths
- [ ] Null/nil/empty inputs
- [ ] Boundary values (0, max, empty list)
- [ ] Exception/error handling paths
- [ ] Each test < 100ms
- [ ] No shared mutable state between tests

## Mock Strategy Priority

```
Real Objects > Test Builders > Fakes > Stubs > Mocks
     ✅            ✅           ✅      ⚠️      ⚠️
```

- **Real objects**: Mappers, validators, converters, use cases, formatters
- **Test builders**: Factory methods/builders for domain models, DTOs
- **Fakes**: In-memory repositories, fake API services
- **Stubs**: Simple return-value mocks for platform APIs
- **Mocks**: Only for interaction testing (verify method was called)

## Validation

- [ ] Tests compile and pass
- [ ] Zero unnecessary mocks (every mock is justified)
- [ ] All business branches covered
- [ ] All UI states covered
- [ ] Test names describe behavior, not implementation
- [ ] Tests are independent — can run in any order
