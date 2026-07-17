import prisma from "../lib/prisma";

/**
 * Backfill hospital latitude/longitude from `address` using the Google
 * Geocoding API. Only rows that HAVE an address and are MISSING coordinates
 * are touched — safe to re-run.
 *
 * Requirements:
 *   - env GEOCODING_API_KEY (or MAPS_API_KEY) — a Google Cloud key with the
 *     "Geocoding API" enabled. (This is a server-side key; keep it separate
 *     from the Android Maps SDK key in production.)
 *   - hospitals must already have an `address` filled in (see the manual SQL
 *     option in docs if you only have coordinates and no address).
 *
 * Run (from myopiaBackend/):
 *   GEOCODING_API_KEY=... npx tsx src/migration/geocode_hospitals.ts
 *   # or compile + node dist/migration/geocode_hospitals.js
 */

const API_KEY = process.env.GEOCODING_API_KEY || process.env.MAPS_API_KEY || "";

async function geocode(
  address: string,
): Promise<{ lat: number; lng: number } | null> {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) +
    "&key=" +
    API_KEY;
  const resp = await fetch(url);
  const data = (await resp.json()) as {
    status: string;
    results: { geometry: { location: { lat: number; lng: number } } }[];
  };
  if (data.status !== "OK" || !data.results[0]) return null;
  return data.results[0].geometry.location;
}

async function main() {
  if (!API_KEY) {
    console.error(
      "Missing GEOCODING_API_KEY (or MAPS_API_KEY). Aborting so no rows are touched.",
    );
    process.exit(1);
  }

  const targets = await prisma.hospital.findMany({
    where: {
      address: { not: null },
      OR: [{ latitude: null }, { longitude: null }],
    },
    select: { id: true, name: true, address: true },
  });

  console.log(`Geocoding ${targets.length} hospital(s) with an address…`);
  let ok = 0;
  let miss = 0;

  for (const h of targets) {
    try {
      const loc = await geocode(h.address as string);
      if (!loc) {
        miss++;
        console.warn(`  ✗ no result: ${h.name} (${h.address})`);
        continue;
      }
      await prisma.hospital.update({
        where: { id: h.id },
        data: { latitude: loc.lat, longitude: loc.lng },
      });
      ok++;
      console.log(`  ✓ ${h.name} → ${loc.lat}, ${loc.lng}`);
    } catch (e) {
      miss++;
      console.warn(`  ✗ error: ${h.name}: ${(e as Error).message}`);
    }
    // Stay well under the default Geocoding QPS limit.
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log(`Done. Updated ${ok}, unresolved ${miss}.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
