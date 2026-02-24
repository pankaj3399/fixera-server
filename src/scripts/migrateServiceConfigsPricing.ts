import mongoose from 'mongoose'
import { config } from 'dotenv'
import ServiceConfiguration from '../models/serviceConfiguration'

config()

async function migrate() {
    const rawMongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fixera'
    
    // Redact URI for logging
    const redactedURI = rawMongoURI.replace(/\/\/.*:.*@/, '//****:****@')
    console.log(`Connecting to ${redactedURI}...`)
    
    await mongoose.connect(rawMongoURI)
    console.log('Connected to MongoDB')

    let updated = 0
    let inspected = 0

    console.log('Inspecting service configurations...')
    const cursor = ServiceConfiguration.find({}).cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        inspected++
        let changed = false
        const typedDoc = doc as any

        // 1. Migrate pricingModel to pricingModelName/Type/Unit OR Normalize existing pricingModelName
        const hasLegacyField = !!typedDoc.pricingModel;
        const hasNewNameField = !!typedDoc.pricingModelName;

        if (hasLegacyField && !hasNewNameField) {
            console.log(`Migrating legacy pricing for: ${typedDoc.service} (${typedDoc.category})`)
            typedDoc.pricingModelName = typedDoc.pricingModel
            changed = true
        }

        // Always run normalization if name exists but type/unit are missing or need update
        if (typedDoc.pricingModelName && (!typedDoc.pricingModelType || (typedDoc.pricingModelType === 'Price per unit' && !typedDoc.pricingModelUnit))) {
            const name = typedDoc.pricingModelName.toLowerCase().replace('m²', 'm2')
            
            if (name.includes('per') || name.includes('m2') || name.includes('hour') || name.includes('day') || name.includes('meter') || name.includes('room')) {
                typedDoc.pricingModelType = 'Price per unit'
                if (name.includes('m2')) typedDoc.pricingModelUnit = 'm2'
                else if (name.includes('hour')) typedDoc.pricingModelUnit = 'hour'
                else if (name.includes('day')) typedDoc.pricingModelUnit = 'day'
                else if (name.includes('meter')) typedDoc.pricingModelUnit = 'meter'
                else if (name.includes('room')) typedDoc.pricingModelUnit = 'room'
                else typedDoc.pricingModelUnit = 'unit'
            } else {
                typedDoc.pricingModelType = 'Fixed price'
                typedDoc.pricingModelUnit = undefined
            }
            changed = true
        }

        if (hasLegacyField) {
            typedDoc.set('pricingModel', undefined, { strict: false })
            changed = true
        }

        if (!typedDoc.pricingModelName) {
            // Default if nothing exists
            typedDoc.pricingModelName = 'Total price'
            typedDoc.pricingModelType = 'Fixed price'
            changed = true
        }

        // 2. Migrate country to activeCountries
        if (typedDoc.country && (!typedDoc.activeCountries || typedDoc.activeCountries.length === 0)) {
            typedDoc.activeCountries = [typedDoc.country]
            typedDoc.set('country', undefined, { strict: false })
            changed = true
        } else if (!typedDoc.activeCountries || typedDoc.activeCountries.length === 0) {
            typedDoc.activeCountries = ['BE']
            changed = true
        }

        // 3. Ensure isActive defaults to true
        if (typeof typedDoc.isActive !== 'boolean') {
            typedDoc.isActive = true
            changed = true
        }

        // 4. Initialize arrays
        if (!typedDoc.projectTypes) {
            typedDoc.projectTypes = []
            changed = true
        }
        if (!typedDoc.professionalInputFields) {
            typedDoc.professionalInputFields = []
            changed = true
        }
        if (!typedDoc.requiredCertifications) {
            typedDoc.requiredCertifications = []
            changed = true
        }

        if (changed) {
            await typedDoc.save()
            updated++
        }
    }

    console.log(`\nMigration Summary:`)
    console.log(`- Inspected: ${inspected}`)
    console.log(`- Updated:   ${updated}`)
    
    await mongoose.disconnect()
    console.log('Disconnected from MongoDB')
}

migrate().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
})
