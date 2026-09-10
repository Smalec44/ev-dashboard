This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Configuration

All optional: the app runs without any of them.

| Variable | Default | What it does |
|---|---|---|
| `ROUTING_URL` | `https://routing.openstreetmap.de/routed-car` | OSRM server for trip-mode road routes. `off` disables routing, and trip mode falls back to straight-line distances. |
| `OVERPASS_ENDPOINTS` | the public Overpass instances | Comma-separated Overpass API URLs for the food, green-space and parking lookups. |

The default router is the free instance FOSSGIS runs for the OpenStreetMap
community. Its [terms](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
allow at most one request a second, ask for a User-Agent that names the app
(it is sent), and rule out high-traffic or commercial-core use — for that,
self-host OSRM and point `ROUTING_URL` at it. The app spaces its calls a
second apart and caches routes for 24 hours, but the spacing holds per server
instance: several instances each keep their own.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
