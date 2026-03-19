---
description: 'Python coding standards for Django/FastAPI/Flask, SQLAlchemy/Django ORM, type hints, async patterns, testing with pytest, and PEP compliance.'
applyTo: '**/*.py, **/pyproject.toml, **/requirements*.txt'
---

# Python Development Standards

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Module/Package | snake_case | `order_service.py` |
| Class | PascalCase | `OrderService` |
| Function/Variable | snake_case | `get_order_by_id()` |
| Constant | UPPER_SNAKE | `MAX_RETRY_COUNT` |
| Private | _prefix | `_internal_method()` |
| Enum member | UPPER_SNAKE | `OrderStatus.PENDING` |

## PEP Compliance

- **PEP 8** (style), **PEP 257** (docstrings), **PEP 484** (type hints)
- Use `list[str]` not `List[str]` (PEP 585), `X | None` not `Optional[X]` (PEP 604)

## Type Hints — Mandatory

```python
def calculate_discount(order: Order, customer: Customer) -> Decimal: ...
def find_order(order_id: int) -> Order | None: ...
def process_items(items: list[OrderItem]) -> dict[str, int]: ...
```

## Error Handling

- Define custom exceptions per domain with error code + message
- Use exception handlers at framework boundary, never catch broad `Exception`
- Always log exceptions with context

## Async Best Practices

- `async/await` for I/O-bound operations
- `asyncio.gather()` for concurrent independent operations
- Use `httpx.AsyncClient` (not `requests`) in async code
- Always close async resources with `async with`

## Database & Migrations

- Use Alembic (SQLAlchemy) or Django migrations — never modify DB manually
- Always include downgrade in Alembic migrations
- Optimize queries: `select_related`/`prefetch_related` (Django), `joinedload`/`selectinload` (SQLAlchemy)

## Testing (pytest)

- Use `pytest` + `pytest-asyncio` for async tests
- AAA pattern: Arrange → Act → Assert
- Use `factory_boy` or `model-bakery` for test data, minimize mocks
- Test naming: `test_<method>_<scenario>_<expected_result>`
- Target 90%+ coverage with `pytest-cov`

## Code Quality

- **Lint & format**: `ruff` (replaces flake8, isort, black)
- **Type check**: `mypy` strict mode
- **Deps**: `pyproject.toml` as single source, use `uv` or `poetry`
- **Security**: parameterized queries, env vars for secrets, no `allow_origins=["*"]`
- **Pre-commit hooks** for automated checks
