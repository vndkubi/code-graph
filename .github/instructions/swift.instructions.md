---
description: 'Swift coding standards for iOS, macOS, and multiplatform projects. Naming conventions, optionals, protocols, value types, error handling, concurrency with async/await, and Swift idioms.'
applyTo: '**/*.swift'
---

# Swift Coding Standards

## Naming Conventions

- **Types**: `PascalCase` — `OrderViewModel`, `UserService`
- **Functions/Properties/Variables**: `camelCase` — `fetchOrders()`, `userName`
- **Constants**: `camelCase` — `maxRetryCount`, `defaultTimeout`
- **Enum cases**: `camelCase` — `case pending`, `case inProgress`
- **Protocols**: `PascalCase`, descriptive — `OrderManaging`, `Cacheable`, `DataProviding`
- **Files**: Match primary type — `OrderViewModel.swift`

## Optionals

```swift
// ❌ Avoid force unwrapping
let name: String = user.name!

// ✅ Optional binding
if let name = user.name {
    displayName(name)
}

// ✅ Guard for early exits
guard let user = currentUser else {
    showLoginScreen()
    return
}

// ✅ Nil coalescing
let displayName = user.name ?? "Unknown"

// ✅ Optional chaining
let city = user?.address?.city

// ✅ map/flatMap for transformations
let uppercaseName = user.name.map { $0.uppercased() }
```

## Value Types vs Reference Types

```swift
// ✅ Prefer structs for data models
struct OrderItem: Equatable, Hashable {
    let id: UUID
    let productName: String
    let quantity: Int
    let price: Decimal
}

// ✅ Use classes when identity matters or inheritance is needed
final class OrderViewModel: ObservableObject {
    @Published private(set) var orders: [Order] = []
    private let repository: OrderRepositoryProtocol
    
    init(repository: OrderRepositoryProtocol) {
        self.repository = repository
    }
}

// ✅ Use enums for finite states
enum OrderStatus: String, Codable, CaseIterable {
    case pending
    case confirmed
    case shipped
    case delivered
    case cancelled
}
```

## Protocols & Protocol-Oriented Design

```swift
// ✅ Define protocols for abstraction
protocol OrderRepositoryProtocol {
    func fetchOrders() async throws -> [Order]
    func getOrder(by id: UUID) async throws -> Order
    func createOrder(_ request: CreateOrderRequest) async throws -> Order
}

// ✅ Protocol extensions for default implementations
extension OrderRepositoryProtocol {
    func fetchActiveOrders() async throws -> [Order] {
        try await fetchOrders().filter { $0.status != .cancelled }
    }
}

// ✅ Protocol composition
typealias DataManager = OrderManaging & CustomerManaging & PaymentProcessing
```

## Async/Await & Concurrency

```swift
// ✅ Use async/await for asynchronous operations
func loadOrders() async {
    state = .loading
    do {
        let orders = try await repository.fetchOrders()
        state = .loaded(orders)
    } catch {
        state = .error(error.localizedDescription)
    }
}

// ✅ Use TaskGroup for parallel work
func loadDashboard() async throws -> Dashboard {
    async let orders = repository.fetchOrders()
    async let customers = repository.fetchCustomers()
    async let stats = repository.fetchStats()
    
    return Dashboard(
        orders: try await orders,
        customers: try await customers,
        stats: try await stats
    )
}

// ✅ Use @MainActor for UI updates
@MainActor
final class OrderViewModel: ObservableObject {
    @Published private(set) var state: ViewState = .idle
    
    func refresh() async {
        state = .loading
        let orders = try? await repository.fetchOrders()
        state = .loaded(orders ?? [])
    }
}

// ✅ Use Task with cancellation
func startPolling() {
    pollingTask = Task {
        while !Task.isCancelled {
            await refresh()
            try await Task.sleep(for: .seconds(30))
        }
    }
}
```

## Error Handling

```swift
// ✅ Use typed errors (Swift 6+) or custom error enums
enum OrderError: LocalizedError {
    case notFound(id: UUID)
    case invalidStatus(current: OrderStatus, expected: OrderStatus)
    case paymentFailed(reason: String)
    
    var errorDescription: String? {
        switch self {
        case .notFound(let id):
            return "Order \(id) not found"
        case .invalidStatus(let current, let expected):
            return "Expected status \(expected) but got \(current)"
        case .paymentFailed(let reason):
            return "Payment failed: \(reason)"
        }
    }
}

// ✅ Use Result type for expected failures
func fetchUser(id: UUID) -> Result<User, NetworkError> {
    // ...
}

// ❌ Avoid catching all errors silently
do { try operation() } catch { /* swallowed */ }

// ✅ Handle specific errors
do {
    try await processOrder(order)
} catch let error as OrderError {
    handleOrderError(error)
} catch {
    logger.error("Unexpected error: \(error)")
}
```

## Access Control

```swift
// ✅ Use most restrictive access level
public struct Order {
    public let id: UUID
    public private(set) var status: OrderStatus
    internal let customerId: UUID
    private var internalState: ProcessingState
}

// ✅ Mark classes as final by default
final class OrderService {
    // ...
}
```

## Extensions

```swift
// ✅ Group related functionality in extensions
// MARK: - Formatting
extension Order {
    var formattedTotal: String {
        NumberFormatter.currency.string(from: total as NSDecimalNumber) ?? "$0.00"
    }
    
    var formattedDate: String {
        DateFormatter.shortDate.string(from: createdAt)
    }
}

// MARK: - Validation
extension Order {
    var isValid: Bool {
        !items.isEmpty && total > 0
    }
}
```

## Collections & Functional Patterns

```swift
// ✅ Use Swift collection methods
let activeUsers = users
    .filter { $0.isActive }
    .sorted(by: { $0.name < $1.name })
    .map(\.displayName)

// ✅ Use KeyPath shortcuts
let names = users.map(\.name)
let sorted = users.sorted(by: \.createdAt)

// ✅ Use first(where:) instead of filter().first
let admin = users.first(where: { $0.role == .admin })
```

## Method Design

- Maximum 20-30 lines per function
- Single responsibility
- Maximum 4 parameters — use struct for more
- Prefer descriptive parameter labels

```swift
// ✅ Clear parameter labels
func move(_ item: Item, from source: IndexPath, to destination: IndexPath)
func configure(with viewModel: CellViewModel, animated: Bool = true)

// ✅ Use @discardableResult when appropriate
@discardableResult
func save(_ order: Order) async throws -> Order
```

## Documentation

```swift
// ✅ DocC comments for public APIs
/// Creates a new order for the specified customer.
///
/// - Parameters:
///   - request: The order creation request containing customer and item details.
/// - Returns: The created order.
/// - Throws: `OrderError.paymentFailed` if payment processing fails.
func createOrder(_ request: CreateOrderRequest) async throws -> Order
```
