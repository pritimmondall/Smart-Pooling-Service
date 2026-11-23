# SmartPool

SmartPool groups nearby home-service bookings with overlapping time windows. Customers can compare an individual price with a pool estimate, track a booking, confirm completion and rate the technician. Technicians claim eligible jobs, inspect road routes, navigate to customers, complete stops and review estimated earnings.

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
2. Save a location in Profile to see open pools across services within 200 m on the dashboard. Manual booking groups specific services under a domain. On the customer dashboard, choose a service and preferred window, then select “Find my best pool” to compare the individual and pooled prices before confirming. The active booking card updates automatically when another customer joins and shows the estimated visit when the route is available. SmartPool starts a pool when there is no eligible match.
3. For a pool, select the entrance on the map or use address search. Same-building pools allow 10 members and match the normalized building/block name and pins within 100 m. The 200 m, 500 m and 1 km options allow 6, 4 and 2 members respectively, including the creator.
4. Another customer can join from the dashboard, an invitation, or a matching service in manual booking. Each join updates everyone's price. Customer-selected pools close when full or after 30 minutes. Automatic pools use the service’s dispatch cutoff before the shared appointment window. The system schedules a shared window after the service's dispatch lead time and estimates each visit in booking order with 15 minutes between visits.
5. For seeded AC service, sign in with `tech.ac@smartpool.demo` and password `TechDemo123!`. Set the technician's work location, services and availability. Ready pools and individual requests appear oldest first. Eligible technicians get in-app alerts and can claim work, accept it and complete each visit.

## Pricing and routes

Automatic matching requires the same service, room in the pool, a shared window long enough for the service and a maximum pairwise distance of 200 m. Eligible pools are ranked by 45% proximity to the centroid, 35% appointment overlap and 20% capacity filled. Automatic pools use the route planner to sequence visits. Customer-selected pools retain booking order.

The demo discount is based on confirmed pool size. One member pays the individual price. Two, three, four and five members receive 10%, 15%, 20% and 25% respectively. Each additional member adds one percentage point, up to 30%. A ₹600 service costs ₹540 each for two customers or ₹510 each for three. Estimated route savings are calculated separately once a technician and route are known.

The technician earnings view sums each completed customer's discounted service price in whole paise. For example, two completed visits priced at ₹540 each earn ₹1,080. The app records estimated earnings. Actual payment collection and transfers require a payment provider.

`ROUTING_PROVIDER=osrm` uses the configured road network. Use `ROUTING_PROVIDER=mock` for a self-contained demo with simulated distances. New scoped pools retain booking order when route estimates are generated.

## Verification

Run `npm run demo:verify` with Chrome installed to build the frontend and exercise the academic demo in three separate browser sessions. The test starts its own temporary MongoDB replica set, uses a two-member AC service and simulated routing, and checks the booking, shared price, technician stops, completion confirmations and ratings. Set `CHROME_PATH` for a custom Chrome installation.

Run `npm test` for the backend and frontend suites and `npm run build` for the production bundle. MongoDB-backed tests require local ports and a MongoDB binary. Set `MONGOMS_SYSTEM_BINARY` to an installed binary for offline runs. The standalone Atlas and historical pooling verification scripts use the configured database and should target an isolated test dataset.

The admin dashboard and AI/ML demand forecasting are deferred. Existing admin APIs support manual assignment and technician oversight.
