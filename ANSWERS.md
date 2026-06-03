# ANSWERS.md

## 1.

The current `OrdersService` stores orders in a module-level `const ORDERS: Order[]` array in `orders.service.ts`. This works for a demo but fails in production for several reasons: state is lost on every restart, it cannot be shared across multiple server instances (horizontal scaling breaks), and there is no transactional safety for concurrent writes.

**Data access layer changes:**
- Replace the in-memory array with a proper database — PostgreSQL is a natural fit for a B2B SaaS since orders, garments, customers, and billing all have relational structure. An ORM such as TypeORM or Prisma (both have first-class NestJS support) maps cleanly onto the existing `Order` and `Garment` interfaces, which would become entity classes with `@Entity()` / `@Column()` decorators.
- Introduce a **Repository pattern** inside `OrdersService`. Instead of `ORDERS.find(...)` the service calls `this.orderRepository.findOne({ where: { id } })`. This keeps database logic out of the controller and makes the service unit-testable by mocking the repository.
- Add **database indexes** on frequently queried columns (`id`, `customerName`, `createdAt`, `garments.status`) so that listing and filtering thousands of orders stays fast.
- Use **database transactions** for any multi-step writes (e.g., updating multiple garment statuses atomically) to avoid partial updates on failure.

**Service design changes:**
- Add **pagination** (`findAll` should accept `page` and `limit` parameters and return a `{ data, total }` shape) so the endpoint does not load thousands of rows into memory.
- Add **DTOs with validation** (`class-validator`) on the input side so the service never receives malformed data.
- Consider a **read/write service split** (CQRS-lite) if read patterns (dashboard queries) differ substantially from write patterns (POS garment updates).

## 2.

The current pattern in `orders.controller.ts` is:

```typescript
getOrder(@Param('id') id: string): Order | { error: string }
```

If the order is not found it returns `{ error: "Order with id X not found" }` with an implicit **200 OK** status.

**Tradeoffs of the current approach:**
- *Pro:* Simple to implement; callers always get a JSON body.
- *Con:* Clients must inspect the response body shape to detect an error — they cannot rely on the HTTP status code. This breaks standard REST conventions, confuses API clients, CDNs, and monitoring tools that all use status codes to detect failures.
- *Con:* The union return type `Order | { error: string }` pollutes the TypeScript signature and makes generated API clients (OpenAPI, etc.) produce inaccurate types.
- *Con:* There is no consistent error envelope across endpoints, so frontend error handling is ad-hoc.

**Improvements:**
- Use NestJS's built-in `NotFoundException` (which automatically returns 404) instead of returning an error object:
  ```typescript
  if (!order) throw new NotFoundException(`Order ${id} not found`);
  return order;
  ```
- Add a **global exception filter** (`@Catch(HttpException)`) that serialises every error into a consistent shape, e.g. `{ statusCode, message, timestamp, path }`, so all endpoints share one error contract.
- Document the API with **Swagger / OpenAPI** (`@nestjs/swagger`) so consumers have machine-readable knowledge of possible response shapes.
- For validation errors (400), use `ValidationPipe` with `class-validator` DTOs rather than manual checks.

## 3.

The current `App.tsx` does a single `fetch('http://localhost:3001/api/orders')` inside a `useEffect` with an empty dependency array. This is fine for a single-screen prototype but becomes unmaintainable as the dashboard grows.

**Structural improvements for a complex dashboard:**

1. **Centralise API calls in a dedicated layer** — move all `fetch` calls into a `src/api/ordersApi.ts` module that exports typed async functions (`fetchOrders`, `fetchOrderById`, `fetchStatusSummary`). Components never call `fetch` directly; they call these functions. This makes mocking in tests trivial and avoids duplicating base URLs and headers.

2. **Use a data-fetching library** — React Query (TanStack Query) or SWR handle loading/error state, caching, background refetching, pagination, and deduplication automatically. The current manual `useState<boolean>(false)` / `useState<string | null>(null)` pattern would need to be replicated for every new API call; a library eliminates that boilerplate entirely.

3. **Lift shared state, keep local state local** — `selectedStatus` belongs in `App` (shared between the dropdown and the list). Deeply nested UI state (e.g., an expanded order card) belongs in that component. For cross-cutting state (auth, theme) use React Context or a lightweight store like Zustand.

4. **Paginate and filter server-side** — instead of fetching all orders and filtering in the browser, pass `status`, `page`, and `limit` as query params to the backend. This keeps the payload small regardless of database size.

5. **Extract reusable hooks** — `useOrders(filter)`, `useOrderSummary()` — so that any new page or widget can reuse the data-fetching logic without duplicating it.

## 4.

**Missing fields / edge cases in the current domain model:**

| Gap | Why it matters |
|-----|---------------|
| No `customerId` / customer contact | Orders are linked to a name string only; impossible to look up a customer's full history or send SMS/email notifications. |
| No `totalPrice` / `itemPrice` on `Garment` | Billing requires per-garment pricing, discounts, and tax. There is no way to generate an invoice. |
| No `updatedAt` or status history on `Garment` | Without an audit trail there is no way to know how long a garment sat in `in_cleaning`, which is critical for SLA tracking and disputes. |
| No `estimatedReadyAt` / `dueDate` on `Order` | POS staff and customers need promised ready times; missed deadlines are a core business risk. |
| No `paymentStatus` on `Order` | Prepaid packages, partial payments, and outstanding balances are core QDC workflows; a boolean or enum (`unpaid \| paid \| prepaid \| refunded`) is needed. |
| No `deliveryAddress` / `deliveryMethod` | Pickup vs. home-delivery are fundamentally different workflows with different statuses. |
| `id` is a plain `string` | Auto-generated IDs (UUIDs or DB sequences) should be set by the persistence layer, not hardcoded strings like `'ORD-1001'`. |
| `createdAt` is set to `new Date()` at module load | All orders get the same timestamp when the server starts rather than when each order is actually created. |

**Evolved domain model direction:** Separate `Customer`, `Order`, `Garment`, `Payment`, and `Package` as distinct entities with proper foreign keys. Add a `GarmentStatusHistory` table for audit trails. Use an enum or a separate `DeliveryMethod` entity for delivery types.

## 5.

AI-generated code in this codebase shows typical patterns: flat in-memory storage without concurrency handling, union return types instead of proper HTTP exceptions, and no input validation. The risks and mitigations are:

**Risks:**
1. **Silent incorrectness** — AI code often looks plausible but contains subtle bugs (e.g., the `createdAt: new Date().toISOString()` evaluated at module load time, not at order creation time). These pass a quick read but fail in production.
2. **Missing error and edge-case handling** — `findOne` returns `undefined` silently; the controller returns a 200 with an error body instead of a 404. AI tools rarely generate robust error propagation without explicit prompting.
3. **Security gaps** — No input validation on route params or bodies. A production endpoint accepting `:id` with no sanitisation is a injection surface.
4. **Hallucinated APIs** — AI occasionally generates calls to library methods that don't exist or uses deprecated APIs (e.g., wrong NestJS decorator arguments). These break at compile time but can slip through if TypeScript is loose.
5. **Overfitting to the happy path** — generated code almost always covers the single happy-path scenario; concurrent writes, empty arrays, null values, and network failures are typically not handled.

**Review and debugging practices:**
- **Run the TypeScript compiler with strict mode** (`"strict": true` in `tsconfig.json`) as the first gate — it surfaces type mismatches that AI code often introduces.
- **Write unit tests before trusting the logic** — a test for `getGarmentStatusSummary` with zero orders, one order with zero garments, and mixed statuses would immediately surface edge cases.
- **Code review checklist** focused on: error paths, auth/auth missing, missing validation, hardcoded values, and side-effects.
- **Manual API testing with edge inputs** (empty strings, very long IDs, missing fields) before merging.
- **Add a linter (`eslint` with `@typescript-eslint`)** with rules like `@typescript-eslint/no-explicit-any` to catch the `catch (e: any)` pattern already present in `App.tsx`.

## 6.

The current architecture is pure REST (request/response). Adding a real-time garment status board requires the server to **push** updates to connected clients. The main options, with tradeoffs:

**Option 1 — Server-Sent Events (SSE)**
NestJS supports SSE with `@Sse()` decorator and `EventEmitter`. The server emits an event whenever a garment status changes. The client uses the browser's native `EventSource` API.
- ✅ Simple, HTTP/1.1 compatible, no extra infrastructure, automatic reconnect built into `EventSource`.
- ❌ Unidirectional (server → client only), each client holds an open HTTP connection, which limits concurrency under load.
- Best fit for a read-only status board.

**Option 2 — WebSockets**
Add `@nestjs/websockets` with the `socket.io` adapter. The server emits `garment:status-changed` events to a room; clients subscribe to that room.
- ✅ Bidirectional, low latency, battle-tested for dashboards.
- ❌ Stateful connections require sticky sessions or a Redis pub/sub adapter when running multiple server instances. More operational complexity.
- Best fit if the board also needs client → server interaction (e.g., drag-and-drop status updates).

**Option 3 — Client-side polling**
Keep REST, add a `setInterval` on the frontend that re-calls `GET /api/orders` every 5–10 seconds.
- ✅ Zero backend changes, simplest to ship quickly.
- ❌ Not truly real-time (up to 10 s lag), wastes bandwidth and server resources, does not scale gracefully.
- Only acceptable as a short-term stopgap.

**Recommendation for QDC:** Start with **SSE** since the garment board is read-only and the infrastructure is already NestJS+Express. When the app moves to a multi-instance deployment backed by a real database, emit status-change events from the service layer (triggered by DB writes) through an in-process `EventEmitter2`, and later swap to a Redis pub/sub channel if fan-out across instances is needed — without changing the client-facing SSE contract.
