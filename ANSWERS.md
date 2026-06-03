# ANSWERS.md

## 1.

Right now orders live in a plain array (`const ORDERS: Order[]`) at the top of `orders.service.ts`. That's fine for a quick demo, but it has obvious problems in production — every server restart wipes all data, and if you run two server instances they each have their own copy of the array, so they'll diverge instantly.

The obvious first step is moving to a real database. PostgreSQL makes sense here because orders, garments, customers, and billing are all naturally relational — they reference each other a lot. I'd pair it with TypeORM or Prisma since both integrate cleanly with NestJS. The `Order` and `Garment` interfaces would become proper entity classes, and `OrdersService` would talk to a repository instead of the array directly (`this.orderRepository.findOne(...)` instead of `ORDERS.find(...)`). That also makes the service much easier to test because you can just mock the repository.

A few other things that'd need to change: `findAll` should accept pagination params (`page`, `limit`) so we're not loading thousands of rows into memory on every request. We'd also want database-level indexes on things like `status` and `createdAt` since those will be filtered and sorted constantly. And any multi-step writes — like updating several garment statuses at once — should be wrapped in a transaction so a halfway-done update can't corrupt data.

## 2.

The current `getOrder` endpoint returns `{ error: "Order with id X not found" }` with a **200 OK** status when the order doesn't exist. The HTTP status code tells the client "everything's fine" while the body says there's a problem — those two things contradict each other.

The tradeoff of the current approach is that it's slightly easier to write, but it means every client (the React frontend, any future mobile app, monitoring tools) has to parse the body to figure out if the request actually succeeded. That's non-standard and error-prone. It also makes the TypeScript signature messy — `Order | { error: string }` — and any auto-generated API client (from OpenAPI/Swagger) would generate inaccurate types.

The fix is straightforward: throw NestJS's built-in `NotFoundException` instead of returning an error object. It automatically sends a 404, and you get the correct HTTP semantics for free:

```typescript
if (!order) throw new NotFoundException(`Order ${id} not found`);
return order;
```

Beyond that, for a real API I'd add a global exception filter that wraps all errors in a consistent shape (`{ statusCode, message, timestamp, path }`), and use `ValidationPipe` with class-validator DTOs to handle bad input (400s) cleanly too.

## 3.

The current setup — a raw `fetch` call inside `useEffect` in `App.tsx` — works for one API call, but it won't scale well once you add filters, pagination, and multiple endpoints. You'd end up copy-pasting the same loading/error state boilerplate everywhere.

The first thing I'd do is pull all API calls into a separate file like `src/api/ordersApi.ts` with typed async functions (`fetchOrders()`, `fetchOrderById()`, `fetchStatusSummary()`). No component should ever call `fetch` directly — they just call these functions. That makes it easy to change the base URL or add auth headers in one place, and trivial to mock in tests.

After that, I'd bring in React Query (TanStack Query). It handles loading states, caching, background refetching, and deduplication automatically. The `useState<boolean>(false)` + `useState<string | null>(null)` pattern you see in `App.tsx` would need to be repeated for every new API call without it — React Query eliminates all that.

For filters and pagination, those should be server-side rather than client-side filtering. Pass `status`, `page`, and `limit` as query params to the backend rather than fetching everything and filtering in the browser. That keeps responses small regardless of how many orders exist.

Finally, wrapping each endpoint in a custom hook (`useOrders(filter)`, `useOrderSummary()`) means any new page can reuse the data-fetching logic without duplicating anything.

## 4.

Looking at the current `Order` and `Garment` types, there are quite a few things missing that would matter in a real laundry business:

There's no `customerId` — orders are tied to a name string, which means you can't look up a customer's history, send them notifications, or link them to a prepaid package account.

Garments have no price. You can't generate an invoice, handle discounts, or track which items are covered by a prepaid package without some kind of `price` or `packageItemId` field.

There's no status history on garments. If a customer disputes that their shirt was damaged during cleaning, you have no way to know when it moved from `received` to `in_cleaning`, or how long it sat at each stage. A separate status change log (even just `{ status, changedAt }[]`) would be essential.

There's no `estimatedReadyAt` or `dueDate` on the order. POS staff need to be able to promise customers a pickup time, and the business needs to track missed deadlines.

`paymentStatus` is missing entirely — the order model has no way to represent whether it's been paid, is outstanding, is covered by a prepaid package, or has been refunded.

There's also no `deliveryMethod` — pickup and home delivery are different workflows with different statuses and staff actions.

One small bug worth noting: `createdAt: new Date().toISOString()` is evaluated when the module loads, so in the current mock data every order gets the same timestamp. In a real system the database sets this automatically.

## 5.

Looking at the code, it has some tell-tale signs of AI generation: in-memory storage with no concurrency handling, union return types instead of HTTP exceptions, no input validation, and `catch (e: any)` in `App.tsx`. These aren't necessarily wrong for a skeleton app, but they'd be risky to ship without review.

The specific risks I'd flag:

The `createdAt` bug mentioned above — it looks correct at a glance but is actually wrong. AI-generated code tends to cover the obvious case and miss subtle initialization issues like this.

Error handling is missing or misleading. The controller returns `{ error: ... }` with a 200 status — a client relying on HTTP status codes would silently treat this as a success. The frontend `catch (e: any)` suppresses TypeScript's type safety for the error path.

There's zero input validation. The `:id` route param goes straight into `ORDERS.find(...)` with no sanitisation. In a real DB-backed system that's a potential injection vector.

AI tools also sometimes call methods that don't exist or use deprecated APIs — these often only show up at compile time, and only if TypeScript is configured strictly.

**What I'd do before shipping:**
- Enable `"strict": true` in `tsconfig.json` — catches a lot of the type-level issues immediately.
- Write unit tests for edge cases (empty orders, missing garment, concurrent updates) before trusting any business logic.
- Do a focused code review pass specifically looking for: missing error paths, hardcoded values, missing auth, and any place where `any` is used.
- Test the API manually with bad inputs (empty string ID, very long strings, missing fields) before merging.

## 6.

The current REST setup is purely request/response — there's no way for the server to tell the client "this garment just became ready" without the client asking first.

There are three realistic ways to add near-real-time updates:

**Short-term — polling:** Just add a `setInterval` on the frontend that re-calls `GET /api/orders` every 5–10 seconds. Zero backend changes needed. It's not truly real-time (up to 10s delay), wastes some bandwidth, but it's the fastest thing to ship and works fine for a small team. Good enough as a stopgap.

**Better — Server-Sent Events (SSE):** NestJS has a `@Sse()` decorator built in. The server emits an event whenever a garment status changes; the browser listens with the native `EventSource` API and reconnects automatically if the connection drops. This is one-directional (server → client only), but that's all a status board needs. It runs over regular HTTP so there's no extra infrastructure, and it's much lower overhead than polling.

**Full solution — WebSockets:** Add `@nestjs/websockets` with the `socket.io` adapter. Bidirectional, low latency, and well-suited to a dashboard where staff might also drag garments between status columns. The downside is that WebSocket connections are stateful — if you run multiple server instances you need a Redis adapter for pub/sub to fan out events across them. More operational complexity.

For where QDC is right now I'd go with **SSE** — it solves the problem cleanly without any extra infrastructure, and if scaling ever becomes an issue you can layer Redis pub/sub behind it later without changing the client code at all.
