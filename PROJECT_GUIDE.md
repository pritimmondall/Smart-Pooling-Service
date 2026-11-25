# SmartPool project and viva guide

## 1. What problem does it solve?

Imagine two neighbours booking AC servicing on the same morning. Each wants an individual appointment, but one technician could visit both homes in a single run. SmartPool keeps a separate booking for each household, finds compatible bookings, gives members a group price, and coordinates one technician's visits. Customers can also choose individual service.

Three decisions make the project easier to explain. **Matching** decides which bookings can share a pool. **Pricing** decides each member's estimated fare. **Routing** decides how the assigned technician visits the stops. They happen at different times, take different inputs, and produce different outputs.

## 2. Architecture and technology

SmartPool is a JavaScript MERN application. One React app presents different screens by role. One Express backend owns the business rules and serves a versioned JSON REST API. MongoDB stores the shared state. A periodic worker runs inside the backend process.

| Layer | Technology and purpose | Entry point |
|---|---|---|
| Browser application | React 18 and JSX render the screens. React Router 6 maps URLs to pages. React Context shares authentication and notification state. | [React entry](frontend/src/main.jsx), [routes and role selection](frontend/src/App.jsx), [contexts](frontend/src/context) |
| Interface | Tailwind CSS 3, page-specific CSS and Lucide React icons. Vite 5 builds the application. PostCSS and Autoprefixer process CSS. | [Customer styles](frontend/src/pages/CustomerDashboard.css), [technician styles](frontend/src/pages/TechnicianDashboard.css), [global styles](frontend/src/index.css), [package manifest](frontend/package.json) |
| Browser–server communication | A shared wrapper around browser fetch sends JSON, attaches the bearer token and handles API errors. Dashboard and notification data refresh through HTTP. | [API client](frontend/src/api/client.js), [notification refresh](frontend/src/context/NotificationContext.jsx) |
| Application server | Node.js, Express 4 and ES modules. Routes select handlers, controllers validate and coordinate requests, and services implement reusable decisions. | [Startup and worker](backend/src/server.js), [middleware and router registration](backend/src/app.js), [backend dependencies](backend/package.json) |
| Persistence | MongoDB with Mongoose 8 schemas, references, validation, indexes and sessions. Atlas or a local replica set supports multi-document transactions. | [Connection and transactions](backend/src/config/db.js), [models](backend/src/models) |
| Identity and request handling | bcryptjs hashes passwords. JSON Web Tokens identify signed-in users. Backend role and ownership checks control actions. Helmet sets HTTP headers, CORS configures browser origins, Morgan logs requests and dotenv loads configuration. | [User model](backend/src/models/User.js), [auth middleware](backend/src/middleware/auth.js), [request sanitization](backend/src/middleware/sanitize.js), [environment](backend/src/config/env.js) |
| Maps and routes | Leaflet displays OpenStreetMap tiles and markers. OSRM can supply road distances, durations and geometry. A separate mock provider gives repeatable simulated travel data. SmartPool's own solver uses the provider's matrix to select stop order. | [Map input](frontend/src/components/common/LocationPickerMap.jsx), [routing providers](backend/src/modules/routing/providers), [solver](backend/src/modules/routing/routeOptimization.service.js) |
| Build, hosting and testing | npm scripts coordinate both packages. Vercel configuration builds the frontend. Render configuration starts the Node backend. Node's test runner, mongodb-memory-server and Puppeteer Core cover different levels of testing. | [Root commands](package.json), [Vercel](vercel.json), [Render](render.yaml), [browser scenario](frontend/tests/academic-demo.mjs) |

**Follow a request through the code.** A customer asks for a price on the dashboard. The pool finder calls the API client, which sends a request to the booking quote endpoint. The booking controller looks up the category, invokes matching and pricing, and returns a quote. Confirming the booking sends a separate write request. The backend rechecks the conditions and updates the database in a transaction. This distinction matters because another member can join between viewing a quote and confirming it. [Pool finder](frontend/src/components/common/DashboardPoolMatcher.jsx) · [Booking routes](backend/src/modules/bookings/booking.routes.js) · [Booking controller](backend/src/modules/bookings/booking.controller.js)

## 3. Features and their source files

| User action | What the project does | Where to open the code |
|---|---|---|
| Register, sign in, select a role | Customers and technicians can self-register. The app directs technicians through work-profile setup. The admin role has a restricted approval screen. | [Register](frontend/src/pages/RegisterPage.jsx), [auth controller](backend/src/modules/auth/auth.controller.js), [protected routes](frontend/src/components/layout/ProtectedRoute.jsx), [technician setup](frontend/src/pages/TechnicianProfileSetup.jsx), [approvals](frontend/src/pages/TechnicianApprovals.jsx) |
| Browse services and set a location | A customer selects a category and specific job, enters a service address or picks a pin, and can save a location for nearby-pool alerts. Seed data covers Jadavpur, Ballygunge and Salt Lake Sector II in Kolkata. | [Catalogue](frontend/src/pages/ServicesPage.jsx), [profile](frontend/src/pages/ProfilePage.jsx), [booking form](frontend/src/pages/CreateBookingPage.jsx), [catalogue and scopes](backend/src/modules/pools/poolOptions.js), [seed data](backend/src/scripts/seed.js) |
| Find the best pool | The customer can compare individual and pooled estimates for a preferred window and review alternatives shifted by one or two hours. Confirmation rechecks the quote. An automatic booking can start a pool when none qualifies. | [Dashboard matcher](frontend/src/components/common/DashboardPoolMatcher.jsx), [quote and booking](backend/src/modules/bookings/booking.controller.js), [matching](backend/src/modules/pools/matching.service.js) |
| Discover, create, join or invite | The dashboard lists open pools around the selected location. The customer can explicitly start a pool, join a specific pool, or share an invitation. Discovery radius controls what is visible. Admission still checks the pool's own rules. A neighbour sees an opportunity and keeps their own booking history. | [Dashboard](frontend/src/pages/CustomerDashboard.jsx), [discovery](backend/src/modules/pools/discovery.controller.js), [nearby-pool hook](frontend/src/components/common/useNearbyPools.js), [booking details](frontend/src/pages/BookingDetailPage.jsx) |
| Control the price and closing time | A price watch sends an in-app alert when an eligible automatic pool meets a price target. A closing-price limit applies to an existing booking and can cancel it at closure. Remaining limits are rechecked after repricing. The active founder can edit the deadline while the pool is forming and its cutoff is still in the future. | [Watch service](backend/src/modules/pools/watch.service.js), [closing logic](backend/src/modules/pools/poolLock.service.js), [price-limit UI](frontend/src/components/common/ClosingPriceLimit.jsx), [ownership rule](backend/src/modules/pools/poolOwnership.js), [deadline editor](frontend/src/components/common/PoolCutoffEditor.jsx) |
| Follow a booking and review the visit | Customers can view their bookings, edit or cancel where the state permits, review the timeline, see their position after acceptance, confirm completion and submit feedback. | [My bookings](frontend/src/pages/MyBookingsPage.jsx), [details](frontend/src/pages/BookingDetailPage.jsx), [timeline](frontend/src/utils/bookingTimeline.js), [route view](frontend/src/components/common/CustomerVisitRoute.jsx), [feedback](frontend/src/components/common/CompletionFeedback.jsx), [rating rules](backend/src/modules/ratings/rating.service.js) |
| Set up a technician account | Technicians enter their service fields, base location, working radius, workload capacity and working hours. Approval, availability and eligibility affect which jobs they can take. | [Work-profile UI](frontend/src/pages/TechnicianProfileSetup.jsx), [profile model](backend/src/models/TechnicianProfile.js), [technician API](backend/src/modules/technicians/technician.controller.js) |
| Find and execute work | An eligible technician can reserve a forming pool, claim ready work, accept an assignment and follow its visits. The system records arrival, start, completion or cancellation at stop level. Individual jobs and multi-stop pools share the field dashboard. | [Field dashboard](frontend/src/pages/TechnicianDashboard.jsx), [opportunities](backend/src/modules/technicians/opportunities.controller.js), [assignment](backend/src/modules/pools/poolAssignment.service.js), [jobs](backend/src/modules/technicians/technicianJob.controller.js), [stop progression](backend/src/modules/technicians/technicianStopProgression.service.js) |
| Review a day's work | The technician can inspect their workload, planned routes, next visit, performance metrics, ratings and estimated earnings. The backend also accepts timestamped location updates. | [Day view](frontend/src/components/common/TechnicianDay.jsx), [workload](backend/src/modules/technicians/technicianWorkload.service.js), [routing](backend/src/modules/technicians/technicianRoute.service.js), [metrics](backend/src/modules/technicians/technicianMetrics.service.js), [location service](backend/src/modules/technicians/technicianLocation.service.js) |
| Administer and notify | The admin screen supports technician approval. Protected APIs also manage services, zones, account status and assignments. In-app notifications tell users about relevant pool, price and work events. | [Approvals screen](frontend/src/pages/TechnicianApprovals.jsx), [service routes](backend/src/modules/services/service.routes.js), [zone routes](backend/src/modules/zones/zone.routes.js), [user routes](backend/src/modules/users/user.routes.js), [notifications](backend/src/modules/notifications/notification.controller.js) |

## 4. The database, record by record

A **booking** belongs to one customer and can exist independently. A **pool** coordinates several bookings. One **technician profile** describes a worker, and the pool records the assigned technician. A customer's rating and completion belong to their particular visit. Keeping these identities separate allows one member to cancel or rate their visit while other members continue.

| Mongoose model | What it stores and why |
|---|---|
| [User](backend/src/models/User.js) | Identity, normalized email, password hash, role, active state, contact fields and optional pool-alert location. Customers, technicians and admins share this identity model. |
| [TechnicianProfile](backend/src/models/TechnicianProfile.js) | References a user and their service categories. Stores geographic coverage, hours, capacity, approval, availability and work-related metrics. |
| [ServiceCategory](backend/src/models/ServiceCategory.js) | Catalogue record with base individual price, estimated duration, pool parameters and active status. |
| [ServiceZone](backend/src/models/ServiceZone.js) | Named operating area with a city, centre and radius. A zone and an individual pool's joining radius serve different purposes. |
| [Booking](backend/src/models/Booking.js) | One service request with customer, service, coordinates, window, mode, status, estimated fare and optional pool or technician references. Also holds execution timestamps and route-savings data. |
| [ServicePool](backend/src/models/ServicePool.js) | Shared service, members, centroid, common time window, cutoff, capacity, pricing snapshot, technician reservation or assignment, visit order and shared geometry. |
| [PoolMembership](backend/src/models/PoolMembership.js) | Links booking, customer and pool. A partial unique index helps prevent one booking from holding duplicate active memberships. |
| [PoolClusterLock](backend/src/models/PoolClusterLock.js) | Coordinates concurrent pool creation by category and date so simultaneous requests can recheck whether a pool already exists. |
| [PoolWatch](backend/src/models/PoolWatch.js) | Stores a customer's desired service, location, time and maximum price. Expired watches have a time-to-live index. |
| [TechnicianLocation](backend/src/models/TechnicianLocation.js) | Timestamped positions and optional accuracy, heading and speed. Includes a 30-day expiration index. |
| [Notification](backend/src/models/Notification.js) | Per-user in-app messages, read state, event type and optional invitation or related record. |
| [Rating](backend/src/models/Rating.js) | Links a completed booking, its customer and technician to a score and optional comment. A unique booking reference limits duplicate reviews. |

**Why MongoDB fits this workflow.** GeoJSON points use longitude first, then latitude. A geospatial index narrows the candidate search before the application checks every active member. Transactions keep the pool, memberships and booking estimates consistent when a member joins or leaves. A partially saved join could otherwise leave two customers seeing different prices for the same pool size. [Geographic helpers](backend/src/utils/geo.js) · [Membership transaction](backend/src/modules/pools/matching.service.js) · [Rollback tests](backend/tests/pool-rollback.js)

## 5. The three algorithms to explain at the board

### A. Which customers can share a pool?

1. Find forming pools with the requested category, a future lock cutoff and a nearby centroid. Automatic matching uses 200 m.
2. Check specific service, capacity, active membership and scope. A same-building pool also requires a matching normalized building name.
3. Use Haversine distance with Earth radius 6,371 km. The new pin must be within the allowed radius of **every active member**. If A is close to B and B is close to C, A and C may still be too far apart.
4. Intersect the incoming window with the pool's shared window. Take the later start and earlier end. The overlap must be positive and at least one service duration. Routing assesses the actual sequence later.
5. Rank eligible automatic pools by the score below. The highest score wins. Scores are rounded to four decimal places and ties use earliest creation. On joining, update membership, centroid, common window and price.

```text
proximity = 1 − distance to centroid / radius
time fit  = common overlap duration / incoming booking-window duration
fill      = active members / maximum capacity
score     = 0.45 × proximity + 0.35 × time fit + 0.20 × fill
```

For an eligible pool with proximity 0.75, time fit 1 and fill 0.5, the score is **0.7875**. A high score only matters after all admission checks pass. The pairwise test protects geographic compatibility while the centroid provides a ranking preference. [Matcher and score](backend/src/modules/pools/matching.service.js) · [Matching tests](backend/tests/pool-matching-unit.test.js)

| Explicitly selected scope | Radius | Maximum members, including founder |
|---|---:|---:|
| Same building | 100 m | 10 |
| 200 m area | 200 m | 6 |
| 500 m area | 500 m | 4 |
| 1 km area | 1 km | 2 |

These capacities apply to customer-selected scopes. Automatically created pools use the category capacity. The seed gives AC servicing a ₹600 base price, 45-minute duration and four-member capacity. Plumbing uses ₹450/40 minutes, electrical ₹400/35 minutes, cleaning ₹800/60 minutes and appliance repair ₹550/45 minutes. Cleaning has a three-member automatic capacity and the other seeded categories have four. [Scopes](backend/src/modules/pools/poolOptions.js) · [Category defaults](backend/src/scripts/seed.js)

### B. What exactly earns the discount?

Active membership determines the fare tier. For pool sizes 1 through 10, the default percentages are **0, 10, 15, 20, 25, 26, 27, 28, 29 and 30**. The currency calculation uses integer paise.

```text
discountPaise = floor(basePricePaise × discountPercent / 100)
memberFare    = basePricePaise − discountPaise
poolFare      = memberFare × activeMemberCount
```

One ₹600 AC booking starts at ₹600. When a second compatible customer joins, the discount becomes ₹60 per person, the stored estimate becomes ₹540 each and the total estimated service fare is ₹1,080. A third member moves the fare to ₹510 each. If that member leaves while the pool can still reprice, the two-member rate returns. This is the clearest demonstration of a group decision changing an individual's bill. [Pricing engine](backend/src/modules/pools/pricing.service.js) · [Stored-price workflow test](backend/tests/customer-technician-workflow.test.js)

### C. How are the visits and travel savings calculated?

SmartPool builds a matrix from the technician's origin and the member stops. For a reorderable route of up to eight stops it uses exact branch-and-bound. For larger reorderable routes it uses nearest-neighbour followed by 2-opt improvements. Each candidate order accumulates travel, waiting, service time and late arrivals. A service can finish beyond the window end even when arrival was on time. Customer-created scoped pools preserve booking order. [Route solver](backend/src/modules/routing/routeOptimization.service.js) · [Order policy at acceptance](backend/src/modules/pools/routeSavings.service.js)

```text
route score = 1,000,000 × late arrivals + travel seconds + 0.5 × wait seconds
saved distance = max(0, sum of separate one-way trips from origin − pooled route distance)
estimated travel value = saved kilometres × configured rupees per kilometre
```

The default rate is ₹10/km. A 1 km saving gives ₹10 total. The customers collectively receive an estimated ₹5 share, the technician ₹2.50 and the platform ₹2.50, with deterministic rounding to whole paise. These are modelled allocations. The customer booking-detail screen shows the estimated travel credit for automatic pools. Service earnings use completed fares. Payments, live traffic and field-measured travel savings are outside this implementation. [Savings allocation](backend/src/modules/pools/routeSavings.service.js) · [Customer display](frontend/src/pages/BookingDetailPage.jsx) · [Earnings calculation](backend/src/modules/technicians/technician.controller.js)

## 6. Lifecycle, visibility and reliability

The usual pool sequence is **forming → locked → assigned → accepted → in progress → completed**. Cancellation and limited reopening have separate rules. Forming permits eligible joins. A full pool can lock immediately. The server also starts a worker at startup and schedules sweeps every 30 seconds for cutoffs, dispatch and price watches. A forming-pool reservation records technician interest before final assignment. Eligibility checks include account activity, approval, availability, service skills, coverage, capacity and scheduling conflicts. [State transitions](backend/src/models/ServicePool.js) · [Worker](backend/src/modules/pools/poolWorker.js) · [Eligibility](backend/src/modules/pools/poolAssignment.service.js)

**What each customer sees.** Personal history is scoped to the signed-in customer. A neighbour can discover an open pool and join with their own booking. After technician acceptance, a pool member can see the visit sequence, their own precise pin and approximate areas for other homes. Shared geometry uses area-centre coordinates and omits the technician's origin. If road geometry is unavailable, the ordered stops remain useful. [Shared route construction](backend/src/modules/routing/customerRoute.service.js) · [Geometry tests](backend/tests/customer-route-geometry.test.js)

**What happens under contention.** The server validates current pool conditions and pricing at write time. A stale quote can be rejected and refreshed. Multi-document transactions, conditional updates, membership indexes, a creation lock and retry logic address different races. The backend also enforces ownership even when the frontend hides an unauthorized button. [Database helpers](backend/src/config/db.js) · [Matching service](backend/src/modules/pools/matching.service.js) · [Concurrent requests](backend/tests/pool-concurrency.js) · [Authorization tests](backend/tests/auth-rbac.test.js)

## 7. What distinguishes the project and who benefits?

| Audience | Benefit | Observable evidence |
|---|---|---|
| Customers | Two households keep private bookings while earning a shared price. A customer can compare windows, set a closing limit, wait for a price alert and see their place in the visit sequence. | Join with a second account and reopen the first account's booking. Both estimates update. Each account retains its own address, history and review. |
| Technicians | A compatible group can be served as a multi-stop job. Coverage and capacity checks screen opportunities. A day view, visit order and stop-level progress reduce the need to coordinate every visit separately. | Claim an eligible pool, accept it, mark one visit complete and inspect the remaining visits and estimated earnings. |
| Developers | Matching, pricing, route optimization and provider access are separate modules. Domain decisions can be tested with small fixtures. A routing provider can be changed independently of the quote formula. | Follow a booking from the UI to a controller, then run the matching, pricing or route tests independently. |

The academic contribution is the integration of **pairwise service compatibility, group-wide repricing, customer price protection and technician execution** in one traceable workflow. Haversine, branch-and-bound and 2-opt are established methods. The project-specific work is choosing admission rules, weights, tiers, operating policies and how to keep them consistent across users. Claims about lower fuel use, reduced emissions, greater income or profit need field measurements. The software demonstrates the mechanism and estimates its effects.

## 8. Running, verifying and deploying

- **Install and configure.** The repository recommends Node.js 20.19 or later. Run `npm run setup` from the root, configure a backend environment using the example, and supply a database URI and signing secret. Use Atlas or a local MongoDB replica set for booking transactions. For a demo database, the seed script creates sample users, categories and zones. [Setup instructions](README.md) · [Environment template](backend/.env.example) · [Seed](backend/src/scripts/seed.js)
- **Develop locally.** Run `npm --prefix backend run dev` and `npm --prefix frontend run dev` in separate terminals. Alternatively, `npm run build` followed by `npm start` lets Express serve the built frontend and API together. The default API port is 5001 and the default Vite development port is 5173. [Scripts](package.json) · [Vite configuration](frontend/vite.config.js)
- **Deploy.** The repository provides Vercel configuration for the static client and Render configuration for the API. The client reads `VITE_API_BASE_URL`. The checked-in Render blueprint selects **mock routing**, while the backend's unoverridden provider default is **OSRM**. A presentation claiming road-network calculations should identify the provider actually shown in that run. [Render blueprint](render.yaml) · [Backend defaults](backend/src/config/env.js) · [Frontend API setup](frontend/src/api/client.js)
- **Verify.** `npm test --prefix frontend` runs frontend contract and utility tests. The backend package exposes focused pricing, geography, assignment, concurrency, rollback and workflow suites. The root `npm run demo:verify` builds the app and invokes a Puppeteer academic scenario using Chrome and a temporary replica set. Some supplementary backend scripts have distinct database prerequisites, so use the target's setup instructions. [Backend tests](backend/tests) · [Frontend tests](frontend/tests) · [Academic scenario](frontend/tests/academic-demo.mjs)

## 9. A five-minute academic demonstration

| Time | Show | What to explain |
|---|---|---|
| 0:00–0:40 | Customer A opens the automatic pool finder and requests AC service. | A booking carries one household's identity, place and time. With one member, the seeded example starts at ₹600. |
| 0:40–1:40 | Customer B uses **automatic matching** with the same specific service, an overlapping window and a nearby pin. Confirm, then reopen A's booking. | Both estimates become ₹540. Show the first customer's changed price as evidence that the backend repriced the group. |
| 1:40–2:20 | Show capacity, cutoff and nearby search. Close the pool through a supported condition, such as the founder setting a permitted near-term cutoff and allowing the worker to sweep. | Explain the difference between being able to see a pool and being eligible to join it. |
| 2:20–3:30 | Use an approved, available AC technician covering those homes. Claim the ready pool, accept it and inspect the order and route provider. | Skills and geography govern eligibility. Road or simulated travel times and appointment windows govern the reorderable route. |
| 3:30–4:20 | Switch back to a customer's booking and then advance a stop as the technician. | Each member can see their place in the sequence. Other homes use approximate points in the customer view. |
| 4:20–5:00 | Complete the visits, show estimated earnings, confirm as a customer and submit a rating. | Trace the example from two private requests to one coordinated dispatch and two independently completed visits. |

**Prepare the demo data.** Use distinct accounts, two pins roughly 100 m apart, the same service and a future window long enough for the visits. Give the technician suitable hours, coverage and capacity. Use the automatic path to demonstrate choosing a visit order. With a manually scoped pool, explain the booking-order policy instead. [Reproducible API scenario](backend/tests/customer-technician-workflow.test.js) · [Browser demonstration fixture](frontend/tests/academic-demo.mjs)

## 10. Short answers for viva questions

- **What did your team implement?** The compatibility rules and ranking, tiered repricing, work assignment and execution, route-order policy, estimated travel allocation, privacy-aware customer map and coordination across these steps.
- **Why check all member distances?** A chain of individually close neighbours can span a large distance. Testing every active member keeps the new home within the agreed radius of everyone.
- **Why use both Haversine and a routing provider?** Straight-line distance makes geographic admission predictable and inexpensive. Travel times on the road network can differ because of barriers and street layout.
- **Is it AI?** The implemented core uses deterministic rules and combinatorial optimization. It needs no training dataset. Demand forecasting is a future research direction.
- **What if nobody joins?** A forming pool can have one member. The one-member tier carries zero discount. The closing-price limit determines whether an otherwise unaffordable booking can be retained at closure.
- **Can you guarantee the fastest possible journey?** The exact search optimizes the implemented score for small reorderable pools using the supplied matrix. Large pools use a heuristic, scoped pools preserve join order, and actual traffic can differ.
- **Why a database transaction?** A join changes multiple records. If one write fails, the membership, pool count and fares must still describe the same outcome.
- **Is there a live tracker or payment gateway?** The project stores location updates, displays route and visit progress, and estimates earnings. Continuous customer-facing technician tracking and online settlement are separate capabilities.
- **Which code should an examiner read first?** Start with [the end-to-end workflow test](backend/tests/customer-technician-workflow.test.js), then open [matching](backend/src/modules/pools/matching.service.js), [pricing](backend/src/modules/pools/pricing.service.js) and [routing](backend/src/modules/routing/routeOptimization.service.js). The test shows the outcome before the implementation details.
