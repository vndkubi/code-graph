---
description: 'Jakarta EE conventions for CDI, JPA, JAX-RS, EJB, Bean Validation, and transaction management.'
applyTo: '**/*.java'
---

# Jakarta EE Conventions

## CDI (Contexts and Dependency Injection)

```java
// ✅ Prefer @ApplicationScoped for stateless services
@ApplicationScoped
public class OrderService {
    @Inject
    private OrderRepository orderRepository;
}

// ❌ Avoid @New qualifier — it creates unmanaged instances
@Inject @New
private OrderService orderService;

// ✅ Use producer methods for configurable beans
@Produces
@ApplicationScoped
public ObjectMapper createObjectMapper() {
    return new ObjectMapper()
        .registerModule(new JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
}
```

## JPA (Jakarta Persistence)

```java
// ✅ Use sequence generator for Oracle
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "order_seq")
@SequenceGenerator(name = "order_seq", sequenceName = "ORDER_SEQ", allocationSize = 1)
private Long id;

// ✅ Default to LAZY fetch
@ManyToOne(fetch = FetchType.LAZY)
@JoinColumn(name = "CUSTOMER_ID")
private Customer customer;

// ❌ Never use EAGER fetch on collections
@OneToMany(fetch = FetchType.EAGER) // loads ALL items every time
private List<OrderItem> items;

// ✅ Use @EntityGraph when you need eager loading
@EntityGraph(attributePaths = {"items", "customer"})
@Query("SELECT o FROM Order o WHERE o.id = :id")
Optional<Order> findByIdWithDetails(@Param("id") Long id);

// ✅ Use @NamedQuery for reusable queries
@NamedQuery(name = "Order.findByStatus",
    query = "SELECT o FROM Order o WHERE o.status = :status ORDER BY o.createdAt DESC")

// ✅ Optimistic locking
@Version
private Long version;

// ✅ Audit fields
@Column(name = "CREATED_AT", updatable = false)
private LocalDateTime createdAt;

@Column(name = "UPDATED_AT")
private LocalDateTime updatedAt;

@PrePersist
void onCreate() { createdAt = LocalDateTime.now(); updatedAt = createdAt; }

@PreUpdate
void onUpdate() { updatedAt = LocalDateTime.now(); }
```

## JAX-RS (REST API)

```java
// ✅ REST Resource pattern
@Path("/api/v1/orders")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class OrderResource {

    @Inject
    private OrderService orderService;

    @GET
    @Path("/{id}")
    public Response getOrder(@PathParam("id") Long id) {
        OrderDto order = orderService.findById(id);
        return Response.ok(order).build();
    }

    @POST
    public Response createOrder(@Valid CreateOrderRequest request) {
        OrderDto created = orderService.create(request);
        return Response.status(Response.Status.CREATED)
            .entity(created)
            .build();
    }
}

// ✅ ExceptionMapper for consistent error responses
@Provider
public class BusinessExceptionMapper implements ExceptionMapper<BusinessException> {
    @Override
    public Response toResponse(BusinessException ex) {
        return Response.status(Response.Status.BAD_REQUEST)
            .entity(new ErrorResponse(ex.getErrorCode(), ex.getMessage()))
            .build();
    }
}
```

## Bean Validation

```java
// ✅ Validate DTOs at the API boundary
public class CreateOrderRequest {
    @NotNull(message = "Customer ID is required")
    private Long customerId;

    @NotEmpty(message = "At least one item is required")
    @Valid  // validates nested objects
    private List<@Valid OrderItemRequest> items;

    @Size(max = 500, message = "Notes must not exceed 500 characters")
    private String notes;
}
```

## Transaction Management

```java
// ✅ Keep transaction scope minimal
@Transactional
public OrderDto createOrder(CreateOrderRequest request) {
    // All DB operations in one transaction
    var order = mapper.toEntity(request);
    repository.save(order);
    return mapper.toDto(order);
}

// ❌ Don't put non-transactional operations inside transaction
@Transactional
public void processOrder(Long id) {
    var order = repository.findById(id);
    httpClient.callExternalService(order); // ❌ HTTP call inside transaction
    order.setStatus(PROCESSED);
    repository.save(order);
}

// ✅ Separate transactional and non-transactional operations
public void processOrder(Long id) {
    var order = findOrder(id);  // transactional read
    var result = httpClient.callExternalService(order); // outside transaction
    updateOrderStatus(id, PROCESSED, result); // transactional write
}
```
