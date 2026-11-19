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
2. Save a location in Profile to see open pools across services within 200 m on the dashboard. Manual booking groups specific services under a domain. Individual bookings retain a preferred visit window.
3. For a pool, select the entrance on the map or use address search. Same-building pools allow 10 members and match the normalized building/block name and pins within 100 m. The 200 m, 500 m and 1 km options allow 6, 4 and 2 members respectively, including the creator.
4. Another customer can join from the dashboard, an invitation, or a matching service in manual booking. Each join updates everyone's price. Pools close when full or after 30 minutes. The system schedules a shared window after the service's dispatch lead time and estimates each visit in booking order with 15 minutes between visits.
5. For seeded AC service, sign in with `tech.ac@smartpool.demo` and password `TechDemo123!`. Set the technician's work location, services and availability. Ready pools and individual requests appear oldest first. Eligible technicians get in-app alerts and can claim work, accept it and complete each visit.

## Pricing and routes

The technician earnings view sums each completed customer's discounted service price in whole paise. For example, two completed visits priced at ₹540 each earn ₹1,080. The app records estimated earnings. Actual payment collection and transfers require a payment provider.

`ROUTING_PROVIDER=osrm` uses the configured road network. Use `ROUTING_PROVIDER=mock` for a self-contained demo with simulated distances. New scoped pools retain booking order when route estimates are generated.

## Verification

Run `npm test` for the backend and frontend suites and `npm run build` for the production bundle. MongoDB-backed tests require local ports and a MongoDB binary. Set `MONGOMS_SYSTEM_BINARY` to an installed binary for offline runs. The standalone Atlas and historical pooling verification scripts use the configured database and should target an isolated test dataset.

The admin dashboard and AI/ML demand forecasting are deferred. Existing admin APIs support manual assignment and technician oversight.
