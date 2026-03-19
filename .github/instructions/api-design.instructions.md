---
description: 'REST API design standards including versioning, naming conventions, pagination, error responses, HATEOAS, and HTTP method semantics.'
applyTo: '**/*Resource*.java,**/*Controller*.java'
---

# REST API Design Standards

## URL Naming
- Use plural nouns: `/api/v1/orders`, not `/api/v1/order`
- Use kebab-case for multi-word: `/api/v1/order-items`
- Nest resources for relationships: `/api/v1/orders/{id}/items`
- Limit nesting to 2 levels maximum
- Use query parameters for filtering: `/api/v1/orders?status=PENDING&customerId=123`

## HTTP Methods
- `GET` — read, never modifies state, cacheable
- `POST` — create new resource, returns 201 with Location header
- `PUT` — full update, idempotent, returns 200
- `PATCH` — partial update, returns 200
- `DELETE` — remove resource, idempotent, returns 204 (no body)

## Versioning
- Use URL path versioning: `/api/v1/`, `/api/v2/`
- Never break existing API contracts within a version
- Deprecate before removing (add `@Deprecated` + `Sunset` header)

## Response Format

### Success
```json
{
  "data": { ... },
  "meta": { "timestamp": "...", "requestId": "..." }
}
```

### Collection with Pagination
```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalElements": 150,
    "totalPages": 8
  }
}
```

### Error
```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "Order with ID 123 was not found",
    "details": [ ... ],
    "timestamp": "...",
    "path": "/api/v1/orders/123"
  }
}
```

## Status Codes
- `200` — Success (GET, PUT, PATCH)
- `201` — Created (POST) — include `Location` header
- `204` — No Content (DELETE)
- `400` — Bad Request (validation errors)
- `401` — Unauthorized (missing/invalid auth)
- `403` — Forbidden (insufficient permissions)
- `404` — Not Found
- `409` — Conflict (duplicate, optimistic lock)
- `422` — Unprocessable Entity (business rule violation)
- `500` — Internal Server Error (never expose stack traces)

## Pagination
- Use query parameters: `?page=1&size=20&sort=createdAt,desc`
- Default page size: 20, max: 100
- Always return pagination metadata in response
- Use Oracle `OFFSET/FETCH` or `ROW_NUMBER()` for efficient pagination

## Request Validation
- Validate at the API boundary — fail fast with 400
- Use Bean Validation annotations (`@NotNull`, `@Size`, `@Pattern`)
- Return all validation errors at once, not one at a time
- Include field name and constraint in error details

## Headers
- `Content-Type: application/json` for all JSON endpoints
- `Accept: application/json` for API consumers
- `X-Request-Id` — correlation ID for tracing (generate if not provided)
- `X-Total-Count` — total elements for paginated responses
- `Cache-Control` — set appropriate caching for GET endpoints
