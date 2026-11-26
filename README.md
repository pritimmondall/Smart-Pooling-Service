# SmartPool

SmartPool books home services within each customer's chosen window. Nearby customers can share a technician when road travel and service time fit every appointment. Customers see their own fare, technician and ETA, then confirm completion and rate their visit.

## Run locally

Use Node.js 20.19 or later and MongoDB Atlas or a local MongoDB replica set. Booking, matching and assignment use multi-document transactions.

From the project root:

```sh
npm run setup
cp backend/.env.example backend/.env
```

Set `MONGODB_URI` and a strong `JWT_SECRET` in `backend/.env`. Then run:

```sh
npm --prefix backend run seed
npm run build
npm start
```

Open [SmartPool](http://localhost:5001). Express serves both the built frontend and the API. During development, run `npm --prefix backend run dev` and `npm --prefix frontend run dev` in separate terminals, and open [Vite](http://localhost:5173).

## Try the workflow

1. Sign in with the seeded customer account `customer1@smartpool.demo` and password `CustomerDemo123!`, or register a customer.
2. Open **Book a visit**, choose a specific service, confirm the address or pin, and enter the earliest start and latest finish. The form shows the service duration and quotes the requested window first.
3. Review the fare and savings. If a cheaper group needs a time change of up to two hours, the form shows one alternative. The requested window is selected by default. A changed or expired quote requires another confirmation.
4. Confirmation places even a single visit in the dispatch queue. The worker runs at startup and every 30 seconds. A nearby customer can join a feasible assigned or accepted route later. Five minutes after confirmation, a customer still awaiting assignment can keep waiting or quote a replacement window. Confirming a replacement cancels the waiting booking in the same transaction.
5. Sign in with `tech.ac@smartpool.demo` and password `TechDemo123!` for the seeded AC service. Alternatively, register a new technician, choose service fields and working hours, and save the work profile. New technician registrations are automatically approved. Set **Work availability → Available**, accept an assignment, then use **On the way**, **Mark Arrived**, **Start Service** and **Complete Service**. Declining before arrival releases the assignment for another technician.

## Visit tracking

After the technician accepts, each member’s dashboard displays the saved visit order on a collapsible map, highlights their home and shows the remaining stops ahead. Other homes appear at approximate neighbourhood grid centres. Road overviews connect these areas when available. Simulated routes, single-area pools and routing failures use a labelled schematic.

## Pricing and routes

Automatic matching checks the specific service, remaining capacity and the 200 m pairwise radius. It tries insertion positions in the existing stop order. The scheduler includes road travel, full service duration, working hours in India, and travel to and from adjacent jobs. A 10:00–10:30 service and ten minutes of travel can precede a 30-minute service in a 10:40–11:30 window. A forming pool can have a provisional stop sequence while waiting for a technician. Dispatch verifies the complete route before assigning it.

Technician selection favours the smallest additional road travel. Within an hour of service, a GPS reading up to 15 minutes old can supply the origin. For future work, the scheduler uses the preceding same-day appointment or the registered base. Once a technician departs, the destination stays fixed. An unverifiable addition gets a separate visit. ETA changes of five minutes or more generate customer notices.

The demo discount is based on confirmed pool size. The standard one-member rate is the individual price. Two, three, four and five members receive 10%, 15%, 20% and 25% respectively. Each additional member adds one percentage point, up to 30%. A ₹600 service costs ₹540 each for two customers or ₹510 each for three. An accepted shift adds up to five percentage points off the base price for that customer, subject to the 30% combined cap. For two ₹600 visits, a customer keeping their time pays ₹540 and a customer accepting a shift pays ₹510. The ₹1,050 pool total is the sum of the two fares. SmartPool recalculates in whole paise when membership changes. Each member keeps their confirmed maximum and any accepted flexibility bonus. A completed fare stays final. Estimated route savings are calculated separately once a technician and route are known.

The technician earnings view sums each completed customer's discounted service price in whole paise. For example, two completed visits priced at ₹540 each earn ₹1,080. The app records estimated earnings. Actual payment collection and transfers require a payment provider.

`ROUTING_PROVIDER=osrm` uses the configured road network. Use `ROUTING_PROVIDER=mock` for a self-contained demo with simulated distances. New scoped pools retain booking order when route estimates are generated.

## Home visit API and rollout

`POST /api/v1/visits/quote` accepts a service category ID, specific service, location and time window. It returns a five-minute `quoteToken`, the requested window, fare and savings, and an optional `shiftOffer`. Confirm with `POST /api/v1/visits` using the same inputs, the token and an `addressText`. Include `acceptShift` only when the customer selects the alternative. Retry a lost confirmation response with the same token and selection. The token identifies one booking. A stale offer returns HTTP 409 with the replacement in `error.details.quote` when the requested window can still be quoted.

Deploy the backend and frontend together. Stop previous cutoff-based workers and run at least one always-on backend instance for timed dispatch. Configure a transaction-capable MongoDB replica set and the same `JWT_SECRET` on all instances. For real road durations, set `ROUTING_PROVIDER=osrm` and `OSRM_BASE_URL` to the driving-profile provider. The checked-in Render blueprint uses simulated routing and a free instance. Verify worker uptime, dispatch latency and routing availability in the deployment.

For existing data, run this repeatable backfill against the intended database from the repository root:

```sh
node backend/src/scripts/migrate-home-visits.js
```

It sets missing automatic-booking ceilings to the stored fare, derives the five-minute deadline from each booking's creation time, and initializes admission from active membership and capacity. The worker also understands missing fields during rollout. Existing forming and locked automatic pools enter dispatch. Existing assigned routes with incomplete timing data receive no late additions until verified. Legacy closing-price limits are checked before automatic dispatch. Manual pools continue to use their configured cutoffs.

## Verification

Run `npm run demo:verify` with Chrome installed to build the frontend and exercise the academic demo in four separate browser sessions. The test starts its own temporary MongoDB replica set, uses a three-member AC pool and simulated routing, and checks booking, shared prices, the private map for each customer, stop progression, completion confirmations and ratings. Set `CHROME_PATH` for a custom Chrome installation.

Run `npm test` for the backend and frontend suites and `npm run build` for the production bundle. MongoDB-backed tests require local ports and a MongoDB binary. Set `MONGOMS_SYSTEM_BINARY` to an installed binary for offline runs. The standalone Atlas and historical pooling verification scripts use the configured database and should target an isolated test dataset.

The admin dashboard and AI/ML demand forecasting are deferred. Existing admin APIs support manual assignment and technician oversight.
