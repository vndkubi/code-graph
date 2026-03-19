---
description: 'Android development conventions for Jetpack Compose, ViewModel, Hilt/Dagger, Room, Retrofit, Navigation, and multi-module architecture patterns.'
applyTo: '**/src/main/**/*.kt'
---

# Android Development Conventions

## Architecture: MVVM + Clean Architecture

### Layer Structure

```
Presentation Layer (UI)
    ├── Composables / Fragments / Activities
    ├── ViewModels (AndroidX)
    └── UI State (sealed class/interface)
          ↓
Domain Layer (Optional but recommended)
    ├── Use Cases / Interactors
    ├── Domain Models
    └── Repository Interfaces
          ↓
Data Layer
    ├── Repository Implementations
    ├── Remote Data Source (Retrofit/Ktor)
    ├── Local Data Source (Room/DataStore)
    └── DTOs / Entities
```

### Package Structure (Feature-Based)

```
com.company.app/
├── di/                          # Hilt modules
├── core/
│   ├── common/                  # Shared utilities
│   ├── data/                    # Base data classes
│   ├── network/                 # Retrofit setup, interceptors
│   ├── database/                # Room database, DAOs base
│   └── ui/                      # Shared composables, theme
├── feature/
│   ├── orders/
│   │   ├── data/
│   │   │   ├── remote/          # API service, DTOs
│   │   │   ├── local/           # Room entities, DAOs
│   │   │   └── repository/      # Repository implementation
│   │   ├── domain/
│   │   │   ├── model/           # Domain models
│   │   │   ├── repository/      # Repository interface
│   │   │   └── usecase/         # Use cases
│   │   └── presentation/
│   │       ├── OrderListScreen.kt
│   │       ├── OrderDetailScreen.kt
│   │       └── OrderViewModel.kt
│   └── customers/
│       └── ...
└── navigation/                  # Nav graph, routes
```

## Jetpack Compose

```kotlin
// ✅ Stateless composables — receive state, emit events
@Composable
fun OrderListScreen(
    uiState: OrderListUiState,
    onOrderClick: (Long) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier
) {
    when (uiState) {
        is OrderListUiState.Loading -> LoadingIndicator()
        is OrderListUiState.Content -> OrderList(
            orders = uiState.orders,
            onOrderClick = onOrderClick,
            modifier = modifier
        )
        is OrderListUiState.Error -> ErrorView(
            message = uiState.message,
            onRetry = onRefresh
        )
    }
}

// ✅ Stateful wrapper that connects ViewModel
@Composable
fun OrderListRoute(
    viewModel: OrderViewModel = hiltViewModel(),
    onOrderClick: (Long) -> Unit
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    OrderListScreen(
        uiState = uiState,
        onOrderClick = onOrderClick,
        onRefresh = viewModel::refresh
    )
}
```

## ViewModel

```kotlin
// ✅ ViewModel with StateFlow
@HiltViewModel
class OrderViewModel @Inject constructor(
    private val getOrdersUseCase: GetOrdersUseCase,
    private val savedStateHandle: SavedStateHandle
) : ViewModel() {

    private val _uiState = MutableStateFlow<OrderListUiState>(OrderListUiState.Loading)
    val uiState: StateFlow<OrderListUiState> = _uiState.asStateFlow()

    init {
        loadOrders()
    }

    fun refresh() {
        loadOrders()
    }

    private fun loadOrders() {
        viewModelScope.launch {
            _uiState.value = OrderListUiState.Loading
            getOrdersUseCase()
                .onSuccess { orders ->
                    _uiState.value = OrderListUiState.Content(orders)
                }
                .onFailure { error ->
                    _uiState.value = OrderListUiState.Error(error.message ?: "Unknown error")
                }
        }
    }
}
```

## Dependency Injection (Hilt)

```kotlin
// ✅ Module organization
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideRetrofit(okHttpClient: OkHttpClient): Retrofit =
        Retrofit.Builder()
            .baseUrl(BuildConfig.BASE_URL)
            .client(okHttpClient)
            .addConverterFactory(MoshiConverterFactory.create())
            .build()

    @Provides
    @Singleton
    fun provideOrderApiService(retrofit: Retrofit): OrderApiService =
        retrofit.create(OrderApiService::class.java)
}

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {

    @Binds
    @Singleton
    abstract fun bindOrderRepository(impl: OrderRepositoryImpl): OrderRepository
}
```

## Room Database

```kotlin
// ✅ Entity
@Entity(tableName = "orders")
data class OrderEntity(
    @PrimaryKey val id: Long,
    @ColumnInfo(name = "customer_id") val customerId: Long,
    val status: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "total_amount") val totalAmount: Double
)

// ✅ DAO
@Dao
interface OrderDao {
    @Query("SELECT * FROM orders ORDER BY created_at DESC")
    fun observeOrders(): Flow<List<OrderEntity>>

    @Query("SELECT * FROM orders WHERE id = :id")
    suspend fun getById(id: Long): OrderEntity?

    @Upsert
    suspend fun upsertAll(orders: List<OrderEntity>)

    @Query("DELETE FROM orders WHERE id = :id")
    suspend fun deleteById(id: Long)
}
```

## Retrofit

```kotlin
// ✅ API service interface
interface OrderApiService {

    @GET("api/v1/orders")
    suspend fun getOrders(
        @Query("page") page: Int = 0,
        @Query("size") size: Int = 20
    ): ApiResponse<List<OrderDto>>

    @GET("api/v1/orders/{id}")
    suspend fun getOrder(@Path("id") id: Long): ApiResponse<OrderDto>

    @POST("api/v1/orders")
    suspend fun createOrder(@Body request: CreateOrderRequest): ApiResponse<OrderDto>
}
```

## Navigation (Compose)

```kotlin
// ✅ Type-safe navigation routes
@Serializable
data object OrderList

@Serializable
data class OrderDetail(val orderId: Long)

// ✅ NavHost setup
NavHost(navController = navController, startDestination = OrderList) {
    composable<OrderList> {
        OrderListRoute(
            onOrderClick = { id -> navController.navigate(OrderDetail(id)) }
        )
    }
    composable<OrderDetail> { backStackEntry ->
        val route = backStackEntry.toRoute<OrderDetail>()
        OrderDetailRoute(orderId = route.orderId)
    }
}
```

## Guidelines

- Use `StateFlow` for UI state; avoid `LiveData` in new code
- Collect flows with `collectAsStateWithLifecycle()` in Compose
- Use `SavedStateHandle` for process death survival
- Prefer `Upsert` over separate insert/update in Room
- Use `sealed interface` for UI states (Loading, Content, Error)
- Use `@Immutable` or `@Stable` for Compose performance
- Keep Composables pure — no side effects in composition
- Use `LaunchedEffect` / `SideEffect` for one-time actions
- Multi-module: feature modules should not depend on each other
- Use ProGuard/R8 rules for release builds
