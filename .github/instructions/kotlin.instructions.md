---
description: 'Kotlin coding standards for Android and multiplatform projects. Naming conventions, null safety, coroutines, extension functions, data classes, and idiomatic Kotlin patterns.'
applyTo: '**/*.kt'
---

# Kotlin Coding Standards

## Naming Conventions

- **Classes**: `PascalCase` — `OrderViewModel`, `UserRepository`
- **Functions/Properties**: `camelCase` — `fetchOrders`, `userName`
- **Constants**: `UPPER_SNAKE_CASE` — `MAX_RETRY_COUNT`, `BASE_URL`
- **Packages**: lowercase, dot-separated — `com.company.app.feature.orders`
- **Files**: `PascalCase` matching primary class — `OrderViewModel.kt`
- **Extension files**: `TypeExtensions.kt` — `StringExtensions.kt`, `ViewExtensions.kt`

## Null Safety

```kotlin
// ❌ Avoid force-unwrap (!!)
val name: String = user.name!!

// ✅ Use safe calls and elvis operator
val name: String = user.name ?: "Unknown"
val length: Int = user.name?.length ?: 0

// ✅ Use let for nullable chains
user?.address?.let { address ->
    displayAddress(address)
}

// ✅ Use require/check for preconditions
fun processOrder(order: Order?) {
    requireNotNull(order) { "Order must not be null" }
    check(order.isValid()) { "Order must be valid" }
}
```

## Data Classes & Sealed Classes

```kotlin
// ✅ Data classes for DTOs and value objects
data class UserDto(
    val id: Long,
    val name: String,
    val email: String,
    val role: UserRole = UserRole.REGULAR
)

// ✅ Sealed classes for restricted hierarchies
sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(val exception: Throwable) : Result<Nothing>()
    data object Loading : Result<Nothing>()
}

// ✅ Sealed interface for UI states
sealed interface UiState {
    data object Loading : UiState
    data class Content(val items: List<Item>) : UiState
    data class Error(val message: String) : UiState
}
```

## Coroutines

```kotlin
// ✅ Use structured concurrency
class OrderViewModel(
    private val orderRepository: OrderRepository,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO
) : ViewModel() {

    fun loadOrders() {
        viewModelScope.launch {
            _uiState.value = UiState.Loading
            try {
                val orders = withContext(dispatcher) {
                    orderRepository.getOrders()
                }
                _uiState.value = UiState.Content(orders)
            } catch (e: Exception) {
                _uiState.value = UiState.Error(e.message ?: "Unknown error")
            }
        }
    }
}

// ✅ Use Flow for reactive streams
fun observeOrders(): Flow<List<Order>> = flow {
    while (true) {
        emit(repository.getOrders())
        delay(REFRESH_INTERVAL)
    }
}.flowOn(Dispatchers.IO)

// ❌ Avoid GlobalScope
GlobalScope.launch { /* ... */ }

// ✅ Use appropriate scope
viewModelScope.launch { /* ... */ }
lifecycleScope.launch { /* ... */ }
```

## Extension Functions

```kotlin
// ✅ Keep extensions focused and discoverable
fun String.toSlug(): String =
    lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')

fun View.visible() { visibility = View.VISIBLE }
fun View.gone() { visibility = View.GONE }

// ✅ Extension properties for computed values
val String.isValidEmail: Boolean
    get() = Patterns.EMAIL_ADDRESS.matcher(this).matches()

// ❌ Avoid extension functions that modify internal state of receiver
fun MutableList<Item>.sortAndFilter() { /* modifies list and filters */ }
```

## Scope Functions

```kotlin
// ✅ let — null checks and transformations
user?.let { saveUser(it) }

// ✅ apply — object configuration
val textView = TextView(context).apply {
    text = "Hello"
    textSize = 16f
    setTextColor(Color.BLACK)
}

// ✅ with — calling multiple methods on an object
with(binding) {
    titleText.text = item.title
    descriptionText.text = item.description
    priceText.text = item.formattedPrice
}

// ✅ run — computing a result with an object
val result = service.run {
    configure()
    execute()
}

// ✅ also — side effects (logging, validation)
val user = createUser(request).also { log.info("Created user: ${it.id}") }
```

## Collections

```kotlin
// ✅ Use Kotlin collection functions
val activeUsers = users
    .filter { it.isActive }
    .sortedBy { it.name }
    .map { it.toDto() }

// ✅ Use sequences for large collections
val result = largeList.asSequence()
    .filter { it.isValid() }
    .map { it.transform() }
    .take(10)
    .toList()

// ✅ Use destructuring
val (name, email) = user
for ((key, value) in map) { /* ... */ }
```

## Error Handling

```kotlin
// ✅ Use Result type or sealed classes for expected errors
suspend fun fetchUser(id: Long): Result<User> =
    try {
        Result.Success(api.getUser(id))
    } catch (e: HttpException) {
        Result.Error(e)
    }

// ✅ Use runCatching for compact error handling
val result = runCatching { api.getUser(id) }
    .getOrElse { User.default() }

// ❌ Avoid catching generic Exception silently
try { /* ... */ } catch (e: Exception) { /* swallowed */ }

// ✅ Catch specific exceptions
try { /* ... */ } catch (e: IOException) { handleNetworkError(e) }
```

## Method Design

- Maximum 20-30 lines per function
- Single responsibility — one function, one purpose
- Maximum 4 parameters — use data class for more
- Use default parameters instead of overloads
- Use named arguments for clarity

```kotlin
// ✅ Named arguments for readability
createNotification(
    title = "Order Confirmed",
    message = "Your order #$orderId has been shipped",
    priority = NotificationPriority.HIGH,
    channelId = ORDERS_CHANNEL
)

// ✅ Default parameters
fun fetchUsers(
    page: Int = 0,
    pageSize: Int = 20,
    sortBy: SortField = SortField.NAME
): List<User>
```

## Logging

```kotlin
// ✅ Use Timber (Android) or structured logging
Timber.d("Loading orders for user %s", userId)
Timber.e(exception, "Failed to process order %s", orderId)

// ❌ Avoid string concatenation
Timber.d("Loading orders for user " + userId)

// ❌ Avoid Log.d in production code
Log.d("TAG", "message")
```

## Documentation

```kotlin
// ✅ KDoc for public APIs
/**
 * Creates a new order for the specified customer.
 *
 * @param request The order creation request containing customer and item details.
 * @return The created order wrapped in [Result].
 * @throws IllegalArgumentException if the request contains invalid items.
 */
suspend fun createOrder(request: CreateOrderRequest): Result<Order>
```
