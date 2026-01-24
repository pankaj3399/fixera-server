import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import User from '../models/user';
import Project from '../models/project';
import connectDB from '../config/db';

/**
 * Seed script to replicate prod data for project 696916d61b9d0d72eeacac9e
 * This project has 2 resources: Marcus Janssen + Farouk1
 * Used to debug why February is blocked instead of the correct dates
 */
const seedTestProject = async () => {
  try {
    console.log('🌱 Starting test project seed...');
    await connectDB();
    console.log('✅ Connected to database');

    const hashedPassword = await bcrypt.hash('professional123', 12);

    // 1. Create/Update Marcus Janssen (professional)
    const marcusId = new mongoose.Types.ObjectId('68fdd9141c7a327bcebdf68a');

    const marcusData = {
      _id: marcusId,
      name: 'Marcus Janssen',
      email: 'marcus.janssen@fixera.test',
      phone: '+32471234501',
      password: hashedPassword,
      role: 'professional',
      professionalStatus: 'approved',
      isEmailVerified: true,
      isPhoneVerified: true,
      hourlyRate: 45,
      currency: 'EUR',
      serviceCategories: ['exterior', 'interior'],
      businessInfo: {
        companyName: 'Janssen Electrical & Plumbing',
        description: 'Expert electrical and plumbing services with over 15 years of experience.',
        city: 'Brussels',
        country: 'Belgium',
        postalCode: '1000',
        timezone: 'Europe/Brussels'
      },
      companyAvailability: {
        monday: { available: true, startTime: '09:00', endTime: '17:00' },
        tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
        wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
        thursday: { available: true, startTime: '09:00', endTime: '17:00' },
        friday: { available: true, startTime: '09:00', endTime: '17:00' },
        saturday: { available: false, startTime: '09:00', endTime: '17:00' },
        sunday: { available: false, startTime: '09:00', endTime: '17:00' }
      },
      blockedDates: [],
      blockedRanges: [
        {
          startDate: new Date('2026-01-05T00:00:00.000Z'),
          endDate: new Date('2026-01-13T00:00:00.000Z'),
          reason: 'project-booking:6941ac7d970b56220b9104b3'
        },
        {
          startDate: new Date('2026-01-19T00:00:00.000Z'),
          endDate: new Date('2026-01-23T00:00:00.000Z'),
          reason: 'project-booking:694438a6102aa429b466a74e'
        },
        {
          startDate: new Date('2026-02-02T09:00:00.000Z'),
          endDate: new Date('2026-02-02T12:00:00.000Z'),
          reason: 'project-booking:694971183083c6c75f70d6c8'
        },
        {
          startDate: new Date('2026-02-03T00:00:00.000Z'),
          endDate: new Date('2026-02-09T00:00:00.000Z'),
          reason: 'project-booking:69497290d420304d5867b53d'
        },
        {
          startDate: new Date('2026-02-09T00:00:00.000Z'),
          endDate: new Date('2026-02-17T00:00:00.000Z'),
          reason: 'project-booking:694afb92bdb714a43e11c79b'
        },
        {
          startDate: new Date('2026-01-14T10:00:00.000Z'),
          endDate: new Date('2026-01-14T11:00:00.000Z'),
          reason: 'test'
        },
        {
          startDate: new Date('2026-01-26T08:00:00.000Z'),
          endDate: new Date('2026-01-26T12:00:00.000Z')
        }
      ],
      companyBlockedDates: [],
      companyBlockedRanges: []
    };

    // Delete existing by ID or email, then recreate
    await User.deleteOne({ _id: marcusId });
    await User.deleteOne({ email: 'marcus.janssen@fixera.test' });
    await User.create(marcusData);
    console.log('✅ Created Marcus Janssen (professional)');

    // 2. Create Farouk1 (employee under Marcus)
    const faroukId = new mongoose.Types.ObjectId('6904d7b38701898bee9f4452');

    const faroukData = {
      _id: faroukId,
      name: 'Farouk1',
      email: 'no-email-1761925043003@company.local',
      phone: '+10000003003',
      password: hashedPassword,
      role: 'employee',
      isEmailVerified: true,
      isPhoneVerified: true,
      employee: {
        companyId: marcusId.toString(),
        invitedBy: marcusId.toString(),
        invitedAt: new Date('2025-10-31T15:37:23.221Z'),
        acceptedAt: new Date('2025-10-31T15:37:23.222Z'),
        isActive: true,
        hasEmail: false,
        availabilityPreference: 'personal',
        managedByCompany: true
      },
      blockedDates: [],
      blockedRanges: [
        {
          startDate: new Date('2025-12-23T13:00:00.000Z'),
          endDate: new Date('2025-12-23T16:00:00.000Z'),
          reason: 'project-booking:6941b37c4acea5726d76d51c'
        }
      ]
    };

    await User.deleteOne({ _id: faroukId });
    await User.deleteOne({ email: 'no-email-1761925043003@company.local' });
    await User.create(faroukData);
    console.log('✅ Created Farouk1 (employee)');

    // 3. Create Pankaj (employee under Marcus - the one with Invalid Date issue)
    const pankajId = new mongoose.Types.ObjectId('68fdd9863e7cb7cfbabbce27');

    const pankajData = {
      _id: pankajId,
      name: 'Pankaj',
      email: 'no-email-1761466758325@company.local',
      phone: '+10000008325',
      password: hashedPassword,
      role: 'employee',
      isEmailVerified: true,
      isPhoneVerified: true,
      employee: {
        companyId: marcusId.toString(),
        invitedBy: marcusId.toString(),
        invitedAt: new Date('2025-10-26T08:19:18.581Z'),
        acceptedAt: new Date('2025-10-26T08:19:18.581Z'),
        isActive: true,
        hasEmail: false,
        availabilityPreference: 'personal',
        managedByCompany: true
      },
      blockedDates: [],
      blockedRanges: [
        {
          startDate: new Date('2025-10-27T00:00:00.000Z'),
          endDate: new Date('2025-10-28T00:00:00.000Z')
        },
        {
          startDate: new Date('2025-12-29T00:00:00.000Z'),
          endDate: new Date('2025-12-31T00:00:00.000Z'),
          reason: 'project-booking:694a6f4db91b6c6301a8810f'
        },
        {
          startDate: new Date('2025-12-31T09:30:00.000Z'),
          endDate: new Date('2026-01-02T00:00:00.000Z'),
          reason: 'project-booking:694bce5899f9d2464a124539'
        }
      ]
    };

    await User.deleteOne({ _id: pankajId });
    await User.deleteOne({ email: 'no-email-1761466758325@company.local' });
    await User.create(pankajData);
    console.log('✅ Created Pankaj (employee)');

    // 5. Create the project
    const projectId = new mongoose.Types.ObjectId('696916d61b9d0d72eeacac9e');

    const projectData = {
      _id: projectId,
      professionalId: marcusId.toString(),
      category: 'Interior',
      service: 'Painter & Wallpaperer',
      areaOfWork: '',
      categories: ['Interior'],
      services: [
        {
          category: 'Interior',
          service: 'Painter & Wallpaperer',
          areaOfWork: ''
        }
      ],
      distance: {
        address: 'Meidoorn, 2640 Mortsel, België',
        useCompanyAddress: false,
        maxKmRange: 50,
        noBorders: false,
        location: {
          type: 'Point',
          coordinates: [4.4651598, 51.1785789]
        }
      },
      resources: [
        marcusId.toString(),
        faroukId.toString()
      ],
      minResources: 2,
      minOverlapPercentage: 75,
      description: 'Test project with 2 resources at 75% overlap',
      priceModel: 'm² of work surface',
      keywords: [],
      title: 'New 5/5/1 d - 2 resources 75% - 50km',
      media: { images: [] },
      subprojects: [
        {
          name: 'basic',
          description: 'Basic package',
          projectType: ['Internal'],
          professionalInputs: [],
          pricing: {
            type: 'unit',
            amount: 5,
            minOrderQuantity: 10
          },
          included: [
            { name: 'Surface Preparation', isCustom: false },
            { name: 'Filling Sanding', isCustom: false },
            { name: 'Premium Paint', isCustom: false }
          ],
          materialsIncluded: false,
          materials: [],
          preparationDuration: { value: 5, unit: 'days' },
          executionDuration: { value: 5, unit: 'days' },
          buffer: { value: 1, unit: 'days' },
          warrantyPeriod: { value: 0, unit: 'years' }
        }
      ],
      extraOptions: [],
      termsConditions: [],
      faq: [],
      rfqQuestions: [],
      postBookingQuestions: [],
      customConfirmationMessage: '',
      status: 'published',
      currentStep: 8,
      certifications: [],
      qualityChecks: []
    };

    await Project.deleteOne({ _id: projectId });
    await Project.create(projectData);
    console.log('✅ Created project 696916d61b9d0d72eeacac9e');

    // 6. Create customer with Mortsel location (within project's 50km range)
    const customerId = new mongoose.Types.ObjectId('692613b2b111748669243f16');

    const customerData = {
      _id: customerId,
      name: 'Farouk Customer',
      email: 'farouk_ela@hotmail.com',
      phone: '+32489859311',
      password: hashedPassword,
      role: 'customer',
      isEmailVerified: true,
      isPhoneVerified: true,
      customerType: 'individual',
      location: {
        type: 'Point',
        coordinates: [4.465177199999999, 51.1788372],
        address: 'Meidoorn 10, 2640 Mortsel, België',
        city: 'Mortsel',
        country: 'België',
        postalCode: '2640'
      },
      savedAddresses: [
        {
          label: 'Home',
          address: 'Meidoorn 10, 2640 Mortsel, België',
          city: 'Mortsel',
          country: 'België',
          postalCode: '2640',
          location: {
            type: 'Point',
            coordinates: [4.465177199999999, 51.1788372]
          },
          isDefault: true
        }
      ]
    };

    await User.deleteOne({ _id: customerId });
    await User.deleteOne({ email: 'farouk_ela@hotmail.com' });
    await User.create(customerData);
    console.log('✅ Created Farouk Customer (customer in Mortsel)');

    console.log('');
    console.log('🎉 Seed complete!');
    console.log('');
    console.log('📊 Summary:');
    console.log('   Professional: Marcus Janssen (68fdd9141c7a327bcebdf68a)');
    console.log('   Employees:');
    console.log('     - Farouk1 (6904d7b38701898bee9f4452)');
    console.log('     - Pankaj (68fdd9863e7cb7cfbabbce27)');
    console.log('   Project: 696916d61b9d0d72eeacac9e');
    console.log('');
    console.log('📅 Marcus blockedRanges:');
    console.log('   - Jan 5-13, 2026 (booking)');
    console.log('   - Jan 14, 2026 10:00-11:00 (test)');
    console.log('   - Jan 19-23, 2026 (booking)');
    console.log('   - Jan 26, 2026 08:00-12:00');
    console.log('   - Feb 2, 2026 09:00-12:00 (booking)');
    console.log('   - Feb 3-9, 2026 (booking)');
    console.log('   - Feb 9-17, 2026 (booking)');
    console.log('');
    console.log('📅 Farouk1 blockedRanges:');
    console.log('   - Dec 23, 2025 13:00-16:00 (booking)');
    console.log('');
    console.log('📅 Pankaj blockedRanges:');
    console.log('   - Oct 27-28, 2025');
    console.log('   - Dec 29-31, 2025 (booking)');
    console.log('   - Dec 31, 2025 - Jan 2, 2026 (booking)');
    console.log('');
    console.log('🔑 Professional login: marcus.janssen@fixera.test / professional123');
    console.log('🔑 Customer login: farouk_ela@hotmail.com / professional123');
    console.log('');
    console.log('📍 Customer location: Meidoorn 10, 2640 Mortsel, België (within 50km of project)');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  seedTestProject();
}

export default seedTestProject;
