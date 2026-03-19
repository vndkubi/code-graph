---
description: 'TypeScript coding standards. Strict mode, type safety, no any, discriminated unions, proper generics, and error handling.'
applyTo: '**/*.ts, **/*.tsx, **/*.mts'
---

# TypeScript Standards

## Strict Configuration

`tsconfig.json` must have `"strict": true`. No exceptions.

## Type Safety

```typescript
// ❌ Never use `any`
const data: any = fetchData();

// ✅ Use `unknown` and narrow
const data: unknown = fetchData();
if (isOrder(data)) { /* now typed */ }

// ✅ Discriminated unions for state
type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };
```

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Interface | PascalCase, no `I` prefix | `OrderResponse` |
| Type alias | PascalCase | `OrderStatus` |
| Enum | PascalCase type, PascalCase values | `OrderStatus.Pending` |
| Function | camelCase | `calculateDiscount()` |
| Constant | UPPER_SNAKE or camelCase | `MAX_RETRIES`, `defaultConfig` |
| File (component) | PascalCase | `OrderList.tsx` |
| File (utility) | camelCase | `formatCurrency.ts` |

## Imports

- Use path aliases: `@/components/...` instead of `../../../components`
- Import types with `import type`: `import type { Order } from '@/types'`
- Organize: external → internal → types → styles

## Error Handling

```typescript
// ✅ Custom error classes
class ApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ✅ Type-safe error handling
function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
```

## Generics

```typescript
// ✅ Constrained generics
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

// ✅ Default generic types
interface PaginatedResponse<T = unknown> {
  data: T[];
  total: number;
  page: number;
}
```

## Null Safety

- Use optional chaining: `order?.customer?.name`
- Use nullish coalescing: `value ?? defaultValue` (not `||`)
- Avoid non-null assertions (`!`) — narrow the type instead
