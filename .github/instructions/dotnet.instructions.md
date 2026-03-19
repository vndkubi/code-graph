---
description: '.NET/C# coding standards for ASP.NET Core, Entity Framework Core, dependency injection, middleware, and clean architecture patterns.'
applyTo: '**/*.cs, **/*.csproj, **/*.razor'
---

# .NET / C# Development Standards

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Namespace | PascalCase, match folder | `Company.Project.Domain` |
| Class/Record | PascalCase | `OrderService`, `OrderDto` |
| Interface | I + PascalCase | `IOrderRepository` |
| Method | PascalCase | `GetOrderByIdAsync()` |
| Property | PascalCase | `OrderDate` |
| Private field | _camelCase | `_orderRepository` |
| Parameter | camelCase | `orderId` |
| Constant | PascalCase | `MaxRetryCount` |
| Enum | PascalCase (singular) | `OrderStatus.Pending` |
| Async method | Suffix with Async | `CreateOrderAsync()` |

## Project Structure (Clean Architecture)

```
src/
├── Company.Project.Api/            # ASP.NET Core Web API
│   ├── Controllers/
│   ├── Middleware/
│   ├── Filters/
│   └── Program.cs
├── Company.Project.Application/    # Use cases, DTOs, interfaces
│   ├── Common/
│   ├── Features/
│   │   └── Orders/
│   │       ├── Commands/
│   │       ├── Queries/
│   │       └── Validators/
│   └── Interfaces/
├── Company.Project.Domain/         # Entities, value objects, domain events
│   ├── Entities/
│   ├── ValueObjects/
│   ├── Enums/
│   └── Events/
├── Company.Project.Infrastructure/ # EF Core, external services, messaging
│   ├── Persistence/
│   ├── Services/
│   └── Repositories/
tests/
├── Company.Project.UnitTests/
├── Company.Project.IntegrationTests/
└── Company.Project.FunctionalTests/
```

## ASP.NET Core Patterns

### Controllers
```csharp
[ApiController]
[Route("api/v1/[controller]")]
[Produces("application/json")]
public class OrdersController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<OrdersController> _logger;

    public OrdersController(IMediator mediator, ILogger<OrdersController> logger)
    {
        _mediator = mediator;
        _logger = logger;
    }

    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(OrderDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetById(int id, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetOrderByIdQuery(id), ct);
        return result is null ? NotFound() : Ok(result);
    }
}
```

### Dependency Injection
- Register services in `Program.cs` or extension methods
- Use constructor injection — never `HttpContext.RequestServices`
- Prefer `IOptions<T>` / `IOptionsSnapshot<T>` for configuration
- Scope lifetimes correctly: Scoped for EF DbContext, Singleton for HttpClient factories, Transient for stateless services

### Middleware
- Order matters: Authentication → Authorization → Custom → Endpoints
- Use short-circuit middleware for cross-cutting concerns (logging, error handling, correlation IDs)
- Never read the request body more than once without `EnableBuffering()`

## Entity Framework Core

### DbContext
```csharp
public class AppDbContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
```

### Entity Configuration
- Use `IEntityTypeConfiguration<T>` — never configure in `OnModelCreating` directly
- Define max lengths, required fields, indexes explicitly
- Use value converters for enums and value objects
- Configure cascade delete behavior explicitly

### Migrations
- Use meaningful migration names: `AddOrderStatusColumn`
- Never edit published migrations
- Keep migrations small and focused
- Always test rollback: `dotnet ef migrations remove`

### Query Patterns
- Use `AsNoTracking()` for read-only queries
- Use projections (`.Select()`) instead of loading full entities when possible
- Avoid N+1 queries — use `.Include()` or split queries
- Use `AsSplitQuery()` for complex multi-join queries
- Never use `ToListAsync()` before filtering — filter in the query

## Error Handling

### Global Exception Handler
```csharp
app.UseExceptionHandler(appBuilder =>
{
    appBuilder.Run(async context =>
    {
        var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        var response = exception switch
        {
            NotFoundException => new ProblemDetails { Status = 404, Title = "Not Found" },
            ValidationException ve => new ProblemDetails { Status = 400, Title = "Validation Error" },
            _ => new ProblemDetails { Status = 500, Title = "Internal Server Error" }
        };
        context.Response.StatusCode = response.Status!.Value;
        await context.Response.WriteAsJsonAsync(response);
    });
});
```

### Exception Hierarchy
- `NotFoundException` — 404
- `ValidationException` — 400
- `ConflictException` — 409
- `ForbiddenException` — 403
- `BusinessRuleException` — 422

## Validation

- Use FluentValidation or Data Annotations at the API boundary
- Business rule validation in the Domain/Application layer
- Database constraints for data integrity
- **Do NOT duplicate validation across layers**

## Testing (.NET)

- Use xUnit as the test framework
- Use FluentAssertions for readable assertions
- Use NSubstitute or Moq for mocking (prefer NSubstitute)
- Use `WebApplicationFactory<T>` for integration tests
- Use Bogus or AutoFixture for test data generation
- Name tests: `MethodName_Scenario_ExpectedResult`
- Group tests with nested classes

## Async/Await Best Practices

- Always use `async/await` — never `.Result` or `.Wait()`
- Pass `CancellationToken` through the entire call chain
- Use `ConfigureAwait(false)` in library code
- Use `ValueTask<T>` for hot paths that often complete synchronously
- Avoid `async void` — always return `Task` or `Task<T>`

## Nullable Reference Types

- Enable `<Nullable>enable</Nullable>` in all projects
- Use `?` for nullable types, not null checks on non-nullable types
- Use `required` keyword for mandatory init properties
- Use `[NotNullWhen]`, `[MemberNotNull]` attributes for flow analysis

## Configuration

- Use `appsettings.json` + environment-specific overrides
- Bind configuration to strongly-typed classes with `IOptions<T>`
- Use User Secrets for local development
- Use Azure Key Vault or similar for production secrets
- Never hardcode connection strings or API keys

## Logging

- Use `ILogger<T>` with structured logging
- Use log levels appropriately: Trace < Debug < Information < Warning < Error < Critical
- Include correlation IDs for request tracing
- Log method entry/exit for critical business operations
- Never log sensitive data (passwords, tokens, PII)

## Security

- Use `[Authorize]` attribute with policies, not roles directly
- Validate and sanitize all input
- Use parameterized queries (EF Core does this by default)
- Enable HTTPS redirection and HSTS
- Configure CORS properly — never use `AllowAnyOrigin` in production
- Use anti-forgery tokens for forms
- Rate limit sensitive endpoints
