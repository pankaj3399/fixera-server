import mongoose from 'mongoose'
import { config } from 'dotenv'
import ServiceConfiguration from '../models/serviceConfiguration'
import Project from '../models/project'
import { PricingModelType, PricingModelUnit } from '../models/serviceConfiguration'

config()

/**
 * Migration: Service Configuration Pricing Model
 * 
 * This script handles the migration from the legacy pricing model to the new
 * structured pricing model with pricingModelName, pricingModelType, and pricingModelUnit.
 * 
 * What it does:
 * 1. Migrates legacy `pricingModel` field → `pricingModelName`
 * 2. Derives `pricingModelType` (Fixed price | Price per unit) from the pricing name
 * 3. Derives `pricingModelUnit` (m2, hour, day, meter, room, unit) for unit-based pricing
 * 4. Migrates legacy `country` field → `activeCountries` array
 * 5. Backfills default values for missing fields (isActive, arrays)
 * 6. Adds pricingModelType/Unit to existing Project documents based on their priceModel
 * 
 * Usage:
 *   DRY_RUN=true  npx tsx src/scripts/migrateServiceConfigsPricing.ts   # preview changes
 *   DRY_RUN=false npx tsx src/scripts/migrateServiceConfigsPricing.ts   # apply changes
 */

const DRY_RUN = process.env.DRY_RUN !== 'false'

// Precompiled word-boundary regexes for pricing classification
const RE_PER   = /\bper\b/
const RE_M2    = /\bm2\b/
const RE_HOUR  = /\bhour\b/
const RE_DAY   = /\bday\b/
const RE_METER = /\bmeter\b/
const RE_ROOM  = /\broom\b/

/**
 * Classify a single pricing component (no " or " conjunctions).
 * Uses word-boundary regex matching to avoid false positives
 * (e.g. "today" should not match "day").
 */
function classifySingleComponent(text: string): { type: PricingModelType, unit?: PricingModelUnit } {
    const normalized = text.toLowerCase().replace('m²', 'm2').trim()

    if (
        RE_PER.test(normalized) ||
        RE_M2.test(normalized) ||
        RE_HOUR.test(normalized) ||
        RE_DAY.test(normalized) ||
        RE_METER.test(normalized) ||
        RE_ROOM.test(normalized)
    ) {
        let unit: PricingModelUnit = PricingModelUnit.UNIT
        if (RE_M2.test(normalized)) unit = PricingModelUnit.M2
        else if (RE_HOUR.test(normalized)) unit = PricingModelUnit.HOUR
        else if (RE_DAY.test(normalized)) unit = PricingModelUnit.DAY
        else if (RE_METER.test(normalized)) unit = PricingModelUnit.METER
        else if (RE_ROOM.test(normalized)) unit = PricingModelUnit.ROOM

        return { type: PricingModelType.UNIT, unit }
    }

    return { type: PricingModelType.FIXED }
}

/**
 * Derive pricing type from a name that may contain " or " conjunctions.
 * e.g. "Total price or Price per m²" → splits into ["Total price", "Price per m²"],
 * classifies each independently. If all components agree on UNIT with the same unit,
 * returns UNIT; otherwise returns FIXED (mixed/ambiguous → FIXED).
 */
function derivePricingType(name: string): { type: PricingModelType, unit?: PricingModelUnit } {
    const parts = name.split(/\s+or\s+/i).map(p => p.trim()).filter(Boolean)

    if (parts.length <= 1) {
        return classifySingleComponent(name)
    }

    const classified = parts.map(classifySingleComponent)

    // If all components are UNIT with the same unit, return UNIT
    const allUnit = classified.every(c => c.type === PricingModelType.UNIT)
    if (allUnit) {
        const units = new Set(classified.map(c => c.unit))
        if (units.size === 1) {
            return { type: PricingModelType.UNIT, unit: classified[0].unit }
        }
    }

    // Mixed or ambiguous composites → FIXED
    return { type: PricingModelType.FIXED }
}

async function migrateServiceConfigurations() {
    let updated = 0
    let inspected = 0

    console.log('\n=== Migrating ServiceConfiguration documents ===\n')
    const cursor = ServiceConfiguration.find({}).cursor()

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        inspected++
        const typedDoc = doc as any

        try {
            let changed = false

            // 1. Migrate pricingModel → pricingModelName (legacy field)
            //    Read from _doc to bypass the virtual getter which returns pricingModelName
            const rawPricingModel = typedDoc._doc?.pricingModel
            const rawCountry = typedDoc.get('country', null, { strict: false })
            const hasLegacyField = !!rawPricingModel && !typedDoc.pricingModelName
            if (hasLegacyField) {
                console.log(`  [LEGACY] Migrating pricingModel → pricingModelName for: ${typedDoc.service} (${typedDoc.category})`)
                typedDoc.pricingModelName = rawPricingModel
                changed = true
            }

            // 2a. Clear stale pricingModelUnit if type is already FIXED
            if (typedDoc.pricingModelType === PricingModelType.FIXED && typedDoc.pricingModelUnit) {
                console.log(`  [CLEAN] Clearing stale pricingModelUnit="${typedDoc.pricingModelUnit}" for FIXED service: ${typedDoc.service} (${typedDoc.category})`)
                typedDoc.pricingModelUnit = undefined
                changed = true
            }

            // 2b. Derive pricingModelType and pricingModelUnit if missing
            if (typedDoc.pricingModelName && (!typedDoc.pricingModelType || (typedDoc.pricingModelType === PricingModelType.UNIT && !typedDoc.pricingModelUnit))) {
                const derived = derivePricingType(typedDoc.pricingModelName)
                console.log(`  [DERIVE] ${typedDoc.service}: "${typedDoc.pricingModelName}" → type=${derived.type}, unit=${derived.unit || 'none'}`)
                typedDoc.pricingModelType = derived.type
                if (derived.unit) {
                    typedDoc.pricingModelUnit = derived.unit
                } else {
                    typedDoc.pricingModelUnit = undefined
                }
                changed = true
            }

            // 3. Clear legacy pricingModel field from raw document
            //    Use native collection $unset to bypass the virtual setter
            if (hasLegacyField && !DRY_RUN) {
                await mongoose.connection.collection('serviceconfigurations').updateOne(
                    { _id: typedDoc._id },
                    { $unset: { pricingModel: '' } }
                )
            }

            // 4. Default if nothing exists
            if (!typedDoc.pricingModelName) {
                console.log(`  [DEFAULT] No pricing info for: ${typedDoc.service} (${typedDoc.category}) — defaulting to "Total price" / Fixed`)
                typedDoc.pricingModelName = 'Total price'
                typedDoc.pricingModelType = PricingModelType.FIXED
                changed = true
            }

            // 5. Migrate country → activeCountries
            if (rawCountry && (!typedDoc.activeCountries || typedDoc.activeCountries.length === 0)) {
                console.log(`  [COUNTRY] Migrating country "${rawCountry}" → activeCountries`)
                typedDoc.activeCountries = [rawCountry]
                if (!DRY_RUN) {
                    await mongoose.connection.collection('serviceconfigurations').updateOne(
                        { _id: typedDoc._id },
                        { $unset: { country: '' } }
                    )
                }
                changed = true
            } else if (!typedDoc.activeCountries || typedDoc.activeCountries.length === 0) {
                typedDoc.activeCountries = ['BE']
                changed = true
            }

            // 6. Ensure isActive defaults to true
            if (typeof typedDoc.isActive !== 'boolean') {
                typedDoc.isActive = true
                changed = true
            }

            // 7. Initialize arrays
            if (!typedDoc.projectTypes) { typedDoc.projectTypes = []; changed = true }
            if (!typedDoc.professionalInputFields) { typedDoc.professionalInputFields = []; changed = true }
            if (!typedDoc.requiredCertifications) { typedDoc.requiredCertifications = []; changed = true }

            if (changed) {
                if (!DRY_RUN) {
                    await typedDoc.save()
                }
                updated++
            }
        } catch (err: any) {
            console.error(`  [ERROR] Failed to migrate ServiceConfiguration _id=${typedDoc._id} service="${typedDoc.service}" category="${typedDoc.category}": ${err.message}`)
        }
    }

    return { inspected, updated }
}

async function migrateProjects() {
    let updated = 0
    let inspected = 0

    console.log('\n=== Migrating Project documents (adding pricingModelType/Unit) ===\n')

    // Find projects that need pricing backfill:
    //  - have priceModel but no pricingModelType, OR
    //  - have pricingModelType=UNIT but missing pricingModelUnit
    const cursor = Project.find({
        priceModel: { $exists: true },
        $or: [
            { pricingModelType: { $exists: false } },
            { pricingModelType: PricingModelType.UNIT, pricingModelUnit: { $exists: false } }
        ]
    }).cursor()

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        inspected++
        const typedDoc = doc as any
        const priceModel = typedDoc.priceModel

        if (!priceModel) continue

        try {
            const derived = derivePricingType(priceModel)
            console.log(`  [PROJECT] "${typedDoc.title?.substring(0, 40)}..." priceModel="${priceModel}" → type=${derived.type}, unit=${derived.unit || 'none'}`)

            typedDoc.pricingModelType = derived.type
            if (derived.unit && derived.type !== PricingModelType.FIXED) {
                typedDoc.pricingModelUnit = derived.unit
            } else {
                typedDoc.pricingModelUnit = undefined
            }

            if (!DRY_RUN) {
                await typedDoc.save({ validateBeforeSave: false })
            }
            updated++
        } catch (err: any) {
            console.error(`  [ERROR] Failed to migrate Project _id=${typedDoc._id} title="${typedDoc.title?.substring(0, 40)}" priceModel="${priceModel}": ${err.message}`)
        }
    }

    return { inspected, updated }
}

async function migrate() {
    const rawMongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fixera'
    const redactedURI = rawMongoURI.replace(/\/\/.*:.*@/, '//****:****@')

    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no writes)' : '⚡ LIVE (writing changes)'}`)
    console.log(`Connecting to ${redactedURI}...\n`)

    await mongoose.connect(rawMongoURI)
    console.log('Connected to MongoDB')

    try {
        const scResult = await migrateServiceConfigurations()
        const projResult = await migrateProjects()

        console.log('\n========== Migration Summary ==========')
        console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
        console.log(`\nServiceConfigurations:`)
        console.log(`  Inspected: ${scResult.inspected}`)
        console.log(`  Updated:   ${scResult.updated}`)
        console.log(`\nProjects:`)
        console.log(`  Inspected: ${projResult.inspected}`)
        console.log(`  Updated:   ${projResult.updated}`)
        console.log('========================================\n')
    } finally {
        await mongoose.disconnect()
        console.log('Disconnected from MongoDB')
    }
}

migrate().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
})
