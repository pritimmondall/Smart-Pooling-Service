# SmartPool

SmartPool groups nearby home-service bookings with overlapping time windows. Customers can compare an individual price with a pool estimate, track a booking, confirm completion and rate the technician. SmartPool assigns automatic visits to eligible technicians, who inspect road routes, navigate to customers, complete stops and review estimated earnings.

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
2. On the dashboard or **Book a Service**, select the service, pin the entrance, and enter a preferred start and end. Review the estimated price and confirm. SmartPool creates or joins a compatible group automatically.
3. When the original window has no match, SmartPool can offer a different window up to two hours earlier or later. Keeping the original time is the default. Accepting a shift records the original window and bonus on the booking. If the offer changes before confirmation, the customer can request a fresh quote.
4. The pool closes at capacity or the service cutoff. Every 30 seconds the dispatch worker checks waiting pools. It ranks eligible technicians by distance from their base to the group, then rating. It checks skills, service radius, availability, workload, overlapping jobs and the full shared window against working days and hours in Indian Standard Time. An unassigned visit that reaches the end of its window is cancelled with an in-app notice.
5. For the seeded AC service, sign in with `tech.ac@smartpool.demo` and password `TechDemo123!`. Set availability, inspect assigned jobs and acknowledge the assignment. The route planner sequences homes from the technician’s location and shows the visit order. Legacy manual pools and dedicated bookings are also available.

## Customer pooling options

Customers can set a maximum closing price before booking. SmartPool evaluates limits when a pool fills or reaches its deadline. If a cancellation raises the price, the remaining limits are checked again in the same transaction. A blank limit keeps the visit at the applicable rate.

A price watch sends one in-app notification when an automatic pool matches the selected service, location, window and budget. The pool worker checks watches during dispatch sweeps. Customers can remove pending watches. Reviewing the invitation checks availability again. After the technician accepts, each member’s dashboard displays the saved visit order on a collapsible map, highlights their home and shows the remaining stops ahead. Other homes appear at approximate neighbourhood grid centres. Road overviews connect these areas when available. Simulated routes, single-area pools and routing failures use a labelled schematic.

## Pricing and routes

Automatic matching requires the same service, room in the pool, a shared window long enough for every visit plus a ten-minute allowance between homes and a maximum pairwise distance of 200 m. Eligible pools are ranked by 45% proximity to the centroid, 35% appointment overlap and 20% capacity filled. Automatic pools use the route planner to sequence visits. Customer-selected pools retain booking order.

The demo discount is based on confirmed pool size. The standard one-member rate is the individual price. Two, three, four and five members receive 10%, 15%, 20% and 25% respectively. Each additional member adds one percentage point, up to 30%. A ₹600 service costs ₹540 each for two customers or ₹510 each for three. An accepted shift adds up to five percentage points off the base price for that customer, subject to the 30% combined cap. For two ₹600 visits, a customer keeping their time pays ₹540 and a customer accepting a shift pays ₹510. The ₹1,050 pool total is the sum of the two fares. SmartPool recalculates in whole paise while the group forms and applies each customer's closing limit to their own fare. Estimated route savings are calculated separately once a technician and route are known.

The technician earnings view sums each completed customer's discounted service price in whole paise. For example, two completed visits priced at ₹540 each earn ₹1,080. The app records estimated earnings. Actual payment collection and transfers require a payment provider.

`ROUTING_PROVIDER=osrm` uses the configured road network. Use `ROUTING_PROVIDER=mock` for a self-contained demo with simulated distances. New scoped pools retain booking order when route estimates are generated.

## Verification

Run `npm run demo:verify` with Chrome installed to build the frontend and exercise the academic demo in four separate browser sessions. The test starts its own temporary MongoDB replica set, uses a three-member AC pool and simulated routing, and checks booking, shared prices, the private map for each customer, stop progression, completion confirmations and ratings. Set `CHROME_PATH` for a custom Chrome installation.

Run `npm test` for the backend and frontend suites and `npm run build` for the production bundle. MongoDB-backed tests require local ports and a MongoDB binary. Set `MONGOMS_SYSTEM_BINARY` to an installed binary for offline runs. The standalone Atlas and historical pooling verification scripts use the configured database and should target an isolated test dataset.

The admin dashboard and AI/ML demand forecasting are deferred. Existing admin APIs support manual assignment and technician oversight.
