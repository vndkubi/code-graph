---
description: 'PHP coding standards for Laravel/Symfony, PSR compliance, Eloquent/Doctrine ORM, Composer, and modern PHP 8.x patterns.'
applyTo: '**/*.php, **/composer.json'
---

# PHP Development Standards

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Class | PascalCase | `OrderService` |
| Interface | PascalCase + suffix/prefix | `OrderRepositoryInterface` |
| Method | camelCase | `getOrderById()` |
| Property | camelCase | `$orderDate` |
| Variable | camelCase | `$orderTotal` |
| Constant | UPPER_SNAKE | `MAX_RETRY_COUNT` |
| Enum | PascalCase | `OrderStatus::Pending` |
| File name | Match class name | `OrderService.php` |
| Route | kebab-case | `/api/v1/order-items` |
| Database table | snake_case (plural) | `order_items` |
| Database column | snake_case | `created_at` |

## PSR Standards

- **PSR-1**: Basic coding standard
- **PSR-4**: Autoloading (via Composer)
- **PSR-7**: HTTP Message interfaces
- **PSR-12**: Extended coding style (supersedes PSR-2)
- **PSR-15**: HTTP Server Request Handlers (middleware)

## Project Structure (Laravel)

```
app/
├── Console/              # Artisan commands
├── Events/               # Event classes
├── Exceptions/           # Custom exceptions
├── Http/
│   ├── Controllers/
│   ├── Middleware/
│   ├── Requests/         # Form requests (validation)
│   └── Resources/        # API resources (DTOs)
├── Jobs/                 # Queue jobs
├── Listeners/            # Event listeners
├── Mail/                 # Mailable classes
├── Models/               # Eloquent models
├── Notifications/
├── Policies/             # Authorization policies
├── Providers/            # Service providers
├── Repositories/         # Repository pattern (optional)
└── Services/             # Business logic services
config/
database/
├── factories/            # Model factories
├── migrations/
└── seeders/
resources/
├── views/
└── lang/
routes/
├── api.php
├── web.php
└── console.php
tests/
├── Feature/
└── Unit/
```

## Project Structure (Symfony)

```
src/
├── Command/              # Console commands
├── Controller/
├── DTO/                  # Data transfer objects
├── Entity/               # Doctrine entities
├── EventListener/
├── EventSubscriber/
├── Exception/
├── Form/
├── Message/              # Messenger messages
├── MessageHandler/
├── Repository/           # Doctrine repositories
├── Security/
├── Service/
└── Validator/
config/
├── packages/
├── routes/
└── services.yaml
migrations/
templates/                # Twig templates
tests/
├── Functional/
└── Unit/
```

## Laravel Patterns

### Controller
```php
class OrderController extends Controller
{
    public function __construct(
        private readonly OrderService $orderService,
    ) {}

    public function show(int $id): JsonResponse
    {
        $order = $this->orderService->findById($id);

        return OrderResource::make($order)->response();
    }

    public function store(StoreOrderRequest $request): JsonResponse
    {
        $order = $this->orderService->create($request->validated());

        return OrderResource::make($order)
            ->response()
            ->setStatusCode(Response::HTTP_CREATED);
    }
}
```

### Form Request (Validation)
```php
class StoreOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('create', Order::class);
    }

    public function rules(): array
    {
        return [
            'customer_id' => ['required', 'integer', 'exists:customers,id'],
            'items' => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'integer', 'exists:products,id'],
            'items.*.quantity' => ['required', 'integer', 'min:1'],
        ];
    }
}
```

### Eloquent Model
```php
class Order extends Model
{
    use HasFactory, SoftDeletes;

    protected $fillable = ['customer_id', 'status', 'total'];

    protected $casts = [
        'status' => OrderStatus::class,
        'total' => 'decimal:2',
    ];

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->where('status', OrderStatus::Active);
    }
}
```

### API Resource (DTO)
```php
class OrderResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'customer' => CustomerResource::make($this->whenLoaded('customer')),
            'items' => OrderItemResource::collection($this->whenLoaded('items')),
            'status' => $this->status->value,
            'total' => $this->total,
            'created_at' => $this->created_at->toIso8601String(),
        ];
    }
}
```

## Symfony Patterns

### Controller
```php
#[Route('/api/v1/orders', name: 'order_')]
class OrderController extends AbstractController
{
    public function __construct(
        private readonly OrderService $orderService,
        private readonly SerializerInterface $serializer,
    ) {}

    #[Route('/{id}', name: 'show', methods: ['GET'])]
    public function show(int $id): JsonResponse
    {
        $order = $this->orderService->findById($id);

        return $this->json($order);
    }
}
```

## Modern PHP 8.x Features — Use Them

- **Constructor property promotion**: `public function __construct(private readonly OrderService $orderService)`
- **Enums**: Use backed enums (`enum OrderStatus: string`) instead of constants
- **Named arguments**: For readability in complex function calls
- **Match expressions**: Instead of switch with returns
- **Readonly properties/classes**: For immutable DTOs
- **Fibers**: For async patterns when needed
- **Attributes**: `#[Route]`, `#[Assert\NotBlank]`, `#[ORM\Entity]`
- **Union/intersection types**: For precise type declarations
- **Null-safe operator**: `$order?->customer?->name`

## Error Handling

- Throw specific exceptions: `OrderNotFoundException`, `InsufficientStockException`
- Catch at the boundary (controller/middleware) — not in business logic
- Use exception handler for global error formatting
- Always return structured error responses for APIs:
  ```json
  {
    "error": {
      "code": "ORDER_NOT_FOUND",
      "message": "Order with ID 123 was not found",
      "details": []
    }
  }
  ```
- Use HTTP problem details (RFC 7807) for REST APIs

## Database & Migrations

- Write migrations for ALL schema changes — never modify DB manually
- Migration naming: `YYYY_MM_DD_HHMMSS_description` (Laravel) or versioned (Symfony)
- Always include `down()` method for rollback
- Use database transactions for multi-table operations
- Index frequently queried columns
- Use eager loading to avoid N+1: `Order::with('items', 'customer')->get()`

## Testing

- Use PHPUnit or Pest for unit tests
- Use Laravel's `RefreshDatabase` trait for integration tests
- Use Model Factories for test data generation
- Name tests: `test_it_creates_order_with_valid_data()` or `it('creates order with valid data')`
- Mock external services, not internal classes
- Test validation rules, authorization policies, and business logic separately

## Security

- Never trust user input — validate everything
- Use prepared statements / query builder (Eloquent/Doctrine handle this)
- Sanitize output with `e()` or `htmlspecialchars()`
- Use CSRF tokens for forms
- Hash passwords with `bcrypt` or `argon2`
- Use authorization policies/gates — not manual role checks
- Rate limit API endpoints
- Never expose stack traces in production

## Dependency Management (Composer)

- Lock `composer.lock` in version control
- Use `^` for semver constraints: `"laravel/framework": "^11.0"`
- Separate `require` from `require-dev`
- Run `composer audit` regularly for vulnerability checks
- Use platform requirements: `"php": "^8.2"`

## Code Quality

- Run PHP CS Fixer or Laravel Pint for formatting
- Use PHPStan/Larastan at level 8+ for static analysis
- Use Rector for automated refactoring and PHP version upgrades
- Run `php artisan ide-helper:generate` for better IDE support
