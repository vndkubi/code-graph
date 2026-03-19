---
description: 'React/Next.js component standards. Functional components, hooks, state management, performance patterns, testing with React Testing Library.'
applyTo: '**/*.tsx, **/*.jsx'
---

# React Standards

## Component Patterns

```tsx
// ✅ Functional component with typed props
interface OrderCardProps {
  order: Order;
  onSelect: (orderId: string) => void;
}

export function OrderCard({ order, onSelect }: OrderCardProps) {
  return (
    <article role="listitem" onClick={() => onSelect(order.id)}>
      <h3>{order.title}</h3>
      <p>{order.status}</p>
    </article>
  );
}
```

- **Functional components only** — no class components
- **Named exports** — `export function`, not `export default`
- **Props interface**: Define above component, suffix with `Props`
- **Destructure props** in function signature

## Hooks

- Custom hooks for shared logic: `useOrders()`, `useAuth()`
- Follow Rules of Hooks: top level only, React functions only
- Use `useMemo`/`useCallback` for expensive computations and stable references
- Prefer `useReducer` over `useState` for complex state

## State Management

- **Server state**: React Query / SWR — NOT Redux for API data
- **Client state**: Zustand / Jotai for global, Context for theme/auth
- **Form state**: React Hook Form — NOT manual `useState` per field
- **URL state**: Search params for filterable/shareable state

## Performance

- `React.lazy()` + `Suspense` for route-level code splitting
- `React.memo()` for list item components
- Virtualize lists > 100 items
- Avoid inline object/array/function creation in JSX

## Testing (React Testing Library)

```tsx
// ✅ Test user behavior, not implementation
it('should display order details when loaded', async () => {
  render(<OrderDetails orderId="123" />);
  
  expect(await screen.findByRole('heading', { name: /order #123/i })).toBeInTheDocument();
  expect(screen.getByText('Pending')).toBeInTheDocument();
});

it('should call onSubmit when form is valid', async () => {
  const onSubmit = vi.fn();
  render(<OrderForm onSubmit={onSubmit} />);
  
  await userEvent.type(screen.getByRole('textbox', { name: /title/i }), 'New Order');
  await userEvent.click(screen.getByRole('button', { name: /submit/i }));
  
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'New Order' }));
});
```

- Query by **role**, **text**, **label** — avoid `getByTestId`
- Use `userEvent` over `fireEvent` for realistic interactions
- Test loading, success, and error states
- Mock API calls at the network level (MSW), not component level
