import mongoose from "mongoose";
import dotenv from "dotenv";
import Project from "../models/project";

dotenv.config();

type CoordinatePair = {
  latitude: number;
  longitude: number;
};

type GeoPoint = {
  type: "Point";
  coordinates: [number, number];
};

type GeocodeResult = {
  coordinates: CoordinatePair;
  countryCode: string | null;
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const isValidLatLng = (latitude: number, longitude: number): boolean => {
  if (latitude < -90 || latitude > 90) {
    return false;
  }
  if (longitude < -180 || longitude > 180) {
    return false;
  }
  return true;
};

const getLegacyCoordinates = (distance: any): CoordinatePair | null => {
  const coords = distance?.coordinates;
  if (coords) {
    const latitude = parseNumber(coords.latitude ?? coords.lat);
    const longitude = parseNumber(coords.longitude ?? coords.lng);
    if (latitude !== null && longitude !== null) {
      if (!isValidLatLng(latitude, longitude)) {
        console.warn(`Discarding invalid legacy coordinates: lat=${latitude}, lng=${longitude}`);
        return null;
      }
      return { latitude, longitude };
    }
  }
  return null;
};

const hasLegacyCoordinates = (distance: any) =>
  Object.prototype.hasOwnProperty.call(distance || {}, "coordinates");

const buildLocation = (coords: CoordinatePair): GeoPoint | null => {
  if (!isValidLatLng(coords.latitude, coords.longitude)) {
    console.warn(`Discarding invalid coordinates when building location: lat=${coords.latitude}, lng=${coords.longitude}`);
    return null;
  }
  return {
    type: "Point",
    coordinates: [coords.longitude, coords.latitude],
  };
};

const hasValidLocation = (distance: any) => {
  const location = distance?.location;
  if (!location || location.type !== "Point") return false;
  if (!Array.isArray(location.coordinates) || location.coordinates.length !== 2) {
    return false;
  }
  const longitude = parseNumber(location.coordinates[0]);
  const latitude = parseNumber(location.coordinates[1]);
  if (longitude === null || latitude === null) return false;
  return isValidLatLng(latitude, longitude);
};

const getLocationCoordinates = (distance: any): [number, number] | null => {
  const location = distance?.location;
  if (!location || location.type !== "Point") return null;
  const coords = location.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const longitude = parseNumber(coords[0]);
  const latitude = parseNumber(coords[1]);
  if (longitude === null || latitude === null) return null;
  if (!isValidLatLng(latitude, longitude)) {
    console.warn(`Discarding invalid location coordinates: lat=${latitude}, lng=${longitude}`);
    return null;
  }
  return [longitude, latitude];
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GEOCODE_TIMEOUT_MS = 10_000;

const extractCountryCode = (addressComponents: any[]): string | null => {
  if (!Array.isArray(addressComponents)) return null;
  const countryComponent = addressComponents.find(
    (comp: any) => Array.isArray(comp.types) && comp.types.includes("country")
  );
  const shortName = countryComponent?.short_name;
  if (typeof shortName === "string" && /^[A-Z]{2}$/.test(shortName)) {
    return shortName;
  }
  return null;
};

const geocodeAddress = async (address: string, apiKey: string): Promise<GeocodeResult | null> => {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Google Maps API error: ${response.status}`);
    }
    const data = await response.json();
    if (data.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
      return null;
    }
    const result = data.results[0];
    const location = result?.geometry?.location;
    const latitude = parseNumber(location?.lat);
    const longitude = parseNumber(location?.lng);
    if (latitude === null || longitude === null) {
      return null;
    }
    if (!isValidLatLng(latitude, longitude)) {
      console.warn(`Discarding invalid geocoded coordinates: lat=${latitude}, lng=${longitude}`);
      return null;
    }
    const countryCode = extractCountryCode(result?.address_components);
    return { coordinates: { latitude, longitude }, countryCode };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      console.warn(`Geocoding request timed out after ${GEOCODE_TIMEOUT_MS}ms for address: ${address}`);
      return null;
    }
    throw error;
  }
};

async function backfillProjectGeo() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY || "";
  const dryRunEnv = process.env.DRY_RUN;
  const dryRun = dryRunEnv === "true" || dryRunEnv === "1";
  const geocodeDelayMs = parseInt(process.env.GEOCODE_DELAY_MS || "200", 10);
  if (!Number.isFinite(geocodeDelayMs) || geocodeDelayMs < 0) {
    throw new Error("GEOCODE_DELAY_MS must be a non-negative number");
  }
  const logEvery = 100;

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");
  console.log("Geocoding enabled:", Boolean(apiKey));
  console.log("Dry run (set DRY_RUN=true or DRY_RUN=1 to enable):", dryRun);
  console.log("Geocode delay (ms):", geocodeDelayMs);

  let scanned = 0;
  let updated = 0;
  let geocoded = 0;
  let fromLegacyCoords = 0;
  let removedLegacyCoords = 0;
  let alreadyHasLocation = 0;
  let skipped = 0;
  let skippedMissingAddress = 0;
  let skippedMissingKey = 0;
  let warnedMissingKey = false;
  let skippedGeocodeFailed = 0;
  let skippedNoChange = 0;
  let errors = 0;

  const cursor = Project.find({
    $or: [
      { "distance.address": { $exists: true, $ne: "" } },
      { "distance.coordinates": { $exists: true } }
    ]
  })
    .lean()
    .cursor();

  for await (const project of cursor) {
    scanned += 1;
    try {
      const distance = project.distance || {};
      const address = typeof distance.address === "string" ? distance.address.trim() : "";
      const legacyCoords = getLegacyCoordinates(distance);
      const hasCoordinates = hasLegacyCoordinates(distance);
      const locationCoords = getLocationCoordinates(distance);
      const hasLocation = locationCoords !== null && hasValidLocation(distance);
      if (hasLocation) {
        alreadyHasLocation += 1;
      }

      let nextLocation: GeoPoint | null = locationCoords
        ? { type: "Point", coordinates: locationCoords }
        : null;
      let nextCountryCode: string | null = null;
      const existingCountryCode = typeof distance.countryCode === "string" ? distance.countryCode : null;

      if (!nextLocation && legacyCoords) {
        const builtLocation = buildLocation(legacyCoords);
        if (builtLocation) {
          nextLocation = builtLocation;
          fromLegacyCoords += 1;
        }
      }

      // If we need location or country code, try geocoding
      const needsLocation = !nextLocation;
      const needsCountryCode = !existingCountryCode;

      if (needsLocation || needsCountryCode) {
        if (!address) {
          if (needsLocation) {
            skippedMissingAddress += 1;
            if (!hasCoordinates) {
              skipped += 1;
              continue;
            }
            // Fall through to clean up invalid legacy coordinates
          }
        } else if (!apiKey) {
          if (needsLocation) {
            if (!warnedMissingKey) {
              console.warn(`Missing GOOGLE_MAPS_API_KEY, will skip projects needing geocoding`);
              warnedMissingKey = true;
            }
            skippedMissingKey += 1;
            if (!hasCoordinates) {
              skipped += 1;
              continue;
            }
            // Fall through to clean up invalid legacy coordinates
          }
        } else {
          const geocodeResult = await geocodeAddress(address, apiKey);
          if (!geocodeResult) {
            if (needsLocation) {
              console.warn(`Geocoding failed for project ${project._id}`);
              skippedGeocodeFailed += 1;
              if (!hasCoordinates) {
                skipped += 1;
                continue;
              }
              // Fall through to clean up invalid legacy coordinates
            }
          } else {
            if (needsLocation) {
              nextLocation = buildLocation(geocodeResult.coordinates);
            }
            if (needsCountryCode) {
              nextCountryCode = geocodeResult.countryCode;
            }
            geocoded += 1;
            await delay(geocodeDelayMs);
          }
        }
      }

      // Skip only if there's nothing to set and no legacy coordinates to clean up
      if (!nextLocation && !existingCountryCode && !nextCountryCode && !hasCoordinates) {
        skipped += 1;
        continue;
      }

      const setUpdate: Record<string, unknown> = {};
      const unsetUpdate: Record<string, unknown> = {};
      if (!hasLocation && nextLocation) {
        setUpdate["distance.location"] = nextLocation;
      }
      if (!existingCountryCode && nextCountryCode) {
        setUpdate["distance.countryCode"] = nextCountryCode;
      }
      if (hasCoordinates) {
        unsetUpdate["distance.coordinates"] = "";
        removedLegacyCoords += 1;
      }

      if (Object.keys(setUpdate).length === 0 && Object.keys(unsetUpdate).length === 0) {
        skippedNoChange += 1;
        skipped += 1;
        continue;
      }

      if (dryRun) {
        console.log(`[Dry Run] Would update project ${project._id}`, {
          ...(Object.keys(setUpdate).length ? { $set: setUpdate } : {}),
          ...(Object.keys(unsetUpdate).length ? { $unset: unsetUpdate } : {}),
        });
        updated += 1;
        continue;
      }

      const updateCommand: Record<string, unknown> = {};
      if (Object.keys(setUpdate).length > 0) {
        updateCommand.$set = setUpdate;
      }
      if (Object.keys(unsetUpdate).length > 0) {
        updateCommand.$unset = unsetUpdate;
      }
      await Project.updateOne({ _id: project._id }, updateCommand);
      updated += 1;

      if (scanned % logEvery === 0) {
        console.log(`Progress: ${scanned} scanned, ${updated} updated`);
      }
    } catch (error) {
      console.error(`Failed processing project ${project._id}:`, error);
      errors += 1;
    }
  }

  const missingLocation = await Project.countDocuments({
    $or: [
      { "distance.location": { $exists: false } },
      { "distance.location.coordinates": { $size: 0 } },
      { "distance.location.coordinates.0": { $type: "null" } },
      { "distance.location.coordinates.1": { $type: "null" } },
      { "distance.location.coordinates.0": { $not: { $type: "number" } } },
      { "distance.location.coordinates.1": { $not: { $type: "number" } } },
      { "distance.location.coordinates.0": { $lt: -180 } },
      { "distance.location.coordinates.0": { $gt: 180 } },
      { "distance.location.coordinates.1": { $lt: -90 } },
      { "distance.location.coordinates.1": { $gt: 90 } },
    ],
  });

  console.log("Backfill summary:");
  console.log(`  scanned: ${scanned}`);
  console.log(`  updated: ${updated}`);
  console.log(`  geocoded: ${geocoded}`);
  console.log(`  from legacy coords: ${fromLegacyCoords}`);
  console.log(`  removed legacy coords: ${removedLegacyCoords}`);
  console.log(`  already had location: ${alreadyHasLocation}`);
  console.log(`  skipped: ${skipped}`);
  console.log(`    missing address: ${skippedMissingAddress}`);
  console.log(`    missing API key: ${skippedMissingKey}`);
  console.log(`    geocode failed: ${skippedGeocodeFailed}`);
  console.log(`    no changes needed: ${skippedNoChange}`);
  console.log(`  errors: ${errors}`);
  console.log(`  missing location after run: ${missingLocation}`);

  await mongoose.disconnect();
  console.log("Disconnected from MongoDB");
}

if (require.main === module) {
  backfillProjectGeo()
    .then(() => {
      console.log("Backfill script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Backfill script failed:", error);
      process.exit(1);
    });
}

export { backfillProjectGeo };
