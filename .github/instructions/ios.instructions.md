---
description: 'iOS development conventions for SwiftUI, UIKit, Combine, async/await, Core Data, dependency injection, and MVVM architecture patterns.'
applyTo: '**/*.swift'
---

# iOS Development Conventions

## Architecture: MVVM + Coordinator

### Layer Structure

```
Presentation Layer (UI)
    ├── SwiftUI Views / UIKit ViewControllers
    ├── ViewModels (@Observable / ObservableObject)
    └── View State (enum)
          ↓
Domain Layer
    ├── Use Cases / Services
    ├── Domain Models
    └── Repository Protocols
          ↓
Data Layer
    ├── Repository Implementations
    ├── Network Service (URLSession / Alamofire)
    ├── Local Storage (CoreData / SwiftData / UserDefaults)
    └── DTOs / Managed Objects
```

### Project Structure (Feature-Based)

```
App/
├── App.swift                    # @main entry point
├── AppCoordinator.swift
├── DI/                          # Dependency container
├── Core/
│   ├── Network/                 # API client, interceptors
│   ├── Storage/                 # CoreData/SwiftData stack
│   ├── Extensions/              # Swift extensions
│   └── UI/                      # Shared views, modifiers, theme
├── Features/
│   ├── Orders/
│   │   ├── Data/
│   │   │   ├── OrderDTO.swift
│   │   │   ├── OrderRepository.swift
│   │   │   └── OrderAPIService.swift
│   │   ├── Domain/
│   │   │   ├── Order.swift
│   │   │   ├── OrderRepositoryProtocol.swift
│   │   │   └── GetOrdersUseCase.swift
│   │   └── Presentation/
│   │       ├── OrderListView.swift
│   │       ├── OrderDetailView.swift
│   │       └── OrderViewModel.swift
│   └── Customers/
│       └── ...
├── Navigation/                  # Navigation router
└── Resources/                   # Assets, Localizable
```

## SwiftUI

```swift
// ✅ Stateless view — receives data, emits actions
struct OrderListView: View {
    let orders: [Order]
    let onOrderTap: (Order) -> Void
    let onRefresh: () async -> Void
    
    var body: some View {
        List(orders) { order in
            OrderRowView(order: order)
                .onTapGesture { onOrderTap(order) }
        }
        .refreshable { await onRefresh() }
    }
}

// ✅ Container view connecting ViewModel
struct OrderListContainerView: View {
    @State private var viewModel: OrderViewModel
    
    init(repository: OrderRepositoryProtocol) {
        _viewModel = State(initialValue: OrderViewModel(repository: repository))
    }
    
    var body: some View {
        Group {
            switch viewModel.state {
            case .idle:
                Color.clear.onAppear { viewModel.loadOrders() }
            case .loading:
                ProgressView()
            case .loaded(let orders):
                OrderListView(
                    orders: orders,
                    onOrderTap: viewModel.selectOrder,
                    onRefresh: viewModel.refresh
                )
            case .error(let message):
                ErrorView(message: message, onRetry: viewModel.loadOrders)
            }
        }
        .navigationTitle("Orders")
    }
}
```

## ViewModel (Swift 6 @Observable)

```swift
// ✅ @Observable (iOS 17+)
@Observable
final class OrderViewModel {
    private(set) var state: ViewState<[Order]> = .idle
    private let repository: OrderRepositoryProtocol
    
    init(repository: OrderRepositoryProtocol) {
        self.repository = repository
    }
    
    func loadOrders() {
        state = .loading
        Task {
            do {
                let orders = try await repository.fetchOrders()
                state = .loaded(orders)
            } catch {
                state = .error(error.localizedDescription)
            }
        }
    }
    
    func refresh() async {
        state = .loading
        do {
            let orders = try await repository.fetchOrders()
            state = .loaded(orders)
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}

// ✅ Generic ViewState
enum ViewState<T> {
    case idle
    case loading
    case loaded(T)
    case error(String)
}
```

## Legacy ViewModel (ObservableObject — iOS 14+)

```swift
// ✅ ObservableObject for pre-iOS 17
final class OrderViewModel: ObservableObject {
    @Published private(set) var state: ViewState<[Order]> = .idle
    private let repository: OrderRepositoryProtocol
    private var cancellables = Set<AnyCancellable>()
    
    init(repository: OrderRepositoryProtocol) {
        self.repository = repository
    }
}
```

## Networking

```swift
// ✅ API client with async/await
protocol APIClientProtocol {
    func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T
}

final class APIClient: APIClientProtocol {
    private let session: URLSession
    private let decoder: JSONDecoder
    
    func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        let (data, response) = try await session.data(for: endpoint.urlRequest)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NetworkError.invalidResponse
        }
        
        guard (200...299).contains(httpResponse.statusCode) else {
            throw NetworkError.httpError(statusCode: httpResponse.statusCode)
        }
        
        return try decoder.decode(T.self, from: data)
    }
}

// ✅ Endpoint pattern
struct Endpoint {
    let path: String
    let method: HTTPMethod
    let queryItems: [URLQueryItem]?
    let body: Encodable?
    
    var urlRequest: URLRequest {
        // Build URLRequest from components
    }
}
```

## SwiftData / Core Data

```swift
// ✅ SwiftData model (iOS 17+)
@Model
final class OrderEntity {
    @Attribute(.unique) var id: UUID
    var customerId: UUID
    var status: String
    var totalAmount: Decimal
    var createdAt: Date
    
    @Relationship(deleteRule: .cascade)
    var items: [OrderItemEntity]
}

// ✅ Core Data (pre-iOS 17)
extension OrderEntity {
    @nonobjc public class func fetchRequest() -> NSFetchRequest<OrderEntity> {
        return NSFetchRequest<OrderEntity>(entityName: "OrderEntity")
    }
    
    @NSManaged public var id: UUID
    @NSManaged public var status: String
}
```

## Dependency Injection

```swift
// ✅ Simple DI container
final class DependencyContainer {
    static let shared = DependencyContainer()
    
    lazy var apiClient: APIClientProtocol = APIClient(session: .shared)
    
    lazy var orderRepository: OrderRepositoryProtocol =
        OrderRepository(apiClient: apiClient, dao: orderDao)
    
    lazy var orderViewModel: OrderViewModel =
        OrderViewModel(repository: orderRepository)
}

// ✅ Protocol-based injection (testable)
final class OrderRepository: OrderRepositoryProtocol {
    private let apiClient: APIClientProtocol
    private let dao: OrderDAOProtocol
    
    init(apiClient: APIClientProtocol, dao: OrderDAOProtocol) {
        self.apiClient = apiClient
        self.dao = dao
    }
}
```

## Navigation

```swift
// ✅ Type-safe navigation (iOS 16+)
enum AppRoute: Hashable {
    case orderList
    case orderDetail(id: UUID)
    case customerProfile(id: UUID)
}

struct ContentView: View {
    @State private var path = NavigationPath()
    
    var body: some View {
        NavigationStack(path: $path) {
            OrderListContainerView()
                .navigationDestination(for: AppRoute.self) { route in
                    switch route {
                    case .orderList:
                        OrderListContainerView()
                    case .orderDetail(let id):
                        OrderDetailContainerView(orderId: id)
                    case .customerProfile(let id):
                        CustomerProfileView(customerId: id)
                    }
                }
        }
    }
}
```

## Guidelines

- Use `@Observable` (iOS 17+) over `ObservableObject` in new code
- Use `SwiftData` over Core Data in iOS 17+ projects
- Prefer `async/await` over Combine for new async code
- Use `NavigationStack` (iOS 16+) over `NavigationView`
- Keep Views thin — logic belongs in ViewModels
- Use protocol-based DI for testability
- Use `@Environment` for shared dependencies in SwiftUI
- Mark classes `final` by default
- Use `MARK:` comments for code sections
- Localize all user-facing strings
- Support Dynamic Type and accessibility
- Use SPM (Swift Package Manager) over CocoaPods for new projects
