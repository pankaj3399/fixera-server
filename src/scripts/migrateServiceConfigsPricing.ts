import mongoose from 'mongoose'
import { config } from 'dotenv'
import ServiceConfiguration from '../models/serviceConfiguration'

config()

async function migrate() {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fixera'
    console.log(`Connecting to ${mongoURI}...`)
    await mongoose.connect(mongoURI)
    console.log('Connected to MongoDB')

    let updated = 0
    let inspected = 0

    const allConfigs = await ServiceConfiguration.find({}) as any[]
    console.log(`Found ${allConfigs.length} service configurations to inspect.`)

    for (const doc of allConfigs) {
        inspected++
        let changed = false

        // 1. Migrate pricingModel to pricingModelName/Type/Unit
        if (doc.pricingModel && !doc.pricingModelName) {
            console.log(`Migrating pricing for: ${doc.service} (${doc.category})`)
            doc.pricingModelName = doc.pricingModel
            
            const name = doc.pricingModelName.toLowerCase().replace('m²', 'm2')
            
            if (name.includes('per') || name.includes('m2') || name.includes('hour') || name.includes('day') || name.includes('meter') || name.includes('room')) {
                doc.pricingModelType = 'Price per unit'
                if (name.includes('m2')) doc.pricingModelUnit = 'm2'
                else if (name.includes('hour')) doc.pricingModelUnit = 'hour'
                else if (name.includes('day')) doc.pricingModelUnit = 'day'
                else if (name.includes('meter')) doc.pricingModelUnit = 'meter'
                else if (name.includes('room')) doc.pricingModelUnit = 'room'
                else doc.pricingModelUnit = 'unit'
            } else {
                doc.pricingModelType = 'Fixed price'
                doc.pricingModelUnit = undefined
            }
            
            // Delete legacy field if possible (though Mongoose might re-add it if not in schema, 
            // but we are using any[] and doc.save() which follows schema)
            doc.set('pricingModel', undefined, { strict: false })
            changed = true
        } else if (!doc.pricingModelName) {
            // Default if nothing exists
            doc.pricingModelName = 'Total price'
            doc.pricingModelType = 'Fixed price'
            changed = true
        }

        // 2. Migrate country to activeCountries
        if (doc.country && (!doc.activeCountries || doc.activeCountries.length === 0)) {
            doc.activeCountries = [doc.country]
            doc.set('country', undefined, { strict: false })
            changed = true
        } else if (!doc.activeCountries || doc.activeCountries.length === 0) {
            doc.activeCountries = ['BE']
            changed = true
        }

        // 3. Ensure isActive defaults to true
        if (typeof doc.isActive !== 'boolean') {
            doc.isActive = true
            changed = true
        }

        // 4. Initialize arrays
        if (!doc.projectTypes) {
            doc.projectTypes = []
            changed = true
        }
        if (!doc.professionalInputFields) {
            doc.professionalInputFields = []
            changed = true
        }
        if (!doc.requiredCertifications) {
            doc.requiredCertifications = []
            changed = true
        }

        if (changed) {
            await doc.save()
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
