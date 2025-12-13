import mongoose from 'mongoose';
import connectDB from '../config/db';
import Project from '../models/project';
import User from '../models/user';

interface SampleProjectInput {
  title: string;
  description: string;
  category: string;
  service: string;
  areaOfWork?: string;
  timeMode: 'days' | 'hours';
  priceModel: string;
  distance: {
    address: string;
    useCompanyAddress: boolean;
    maxKmRange: number;
    noBorders: boolean;
    borderLevel: 'none' | 'country' | 'province';
    coordinates: {
      latitude: number;
      longitude: number;
    };
  };
  preparationDuration?: {
    value: number;
    unit: 'hours' | 'days';
  };
  executionDuration?: {
    value: number;
    unit: 'hours' | 'days';
  };
  bufferDuration?: {
    value: number;
    unit: 'hours' | 'days';
  };
  subprojects: any[];
  keywords: string[];
  services: Array<{ category: string; service: string; areaOfWork?: string }>;
}

const sampleProjects: SampleProjectInput[] = [
  {
    title: 'Urban Loft Renovation – Brussels',
    description:
      'Full loft renovation focused on insulation upgrades, energy-efficient windows, and bespoke carpentry. Includes project management and post-delivery inspection.',
    category: 'Renovation',
    service: 'Loft renovation',
    areaOfWork: 'Interior',
    timeMode: 'days',
    priceModel: 'sqm',
    distance: {
      address: 'Rue Antoine Dansaert 202, 1000 Brussels, Belgium',
      useCompanyAddress: false,
      maxKmRange: 40,
      noBorders: false,
      borderLevel: 'province',
      coordinates: {
        latitude: 50.85045,
        longitude: 4.34878,
      },
    },
    preparationDuration: {
      value: 3,
      unit: 'days',
    },
    executionDuration: {
      value: 10,
      unit: 'days',
    },
    bufferDuration: {
      value: 2,
      unit: 'days',
    },
    subprojects: [
      {
        name: 'Premium Loft Package',
        description:
          'Structural assessment, insulation upgrade, new flooring, and premium finishes across living areas.',
        projectType: ['Residential'],
        pricing: {
          type: 'fixed',
          amount: 7500,
        },
        included: [
          { name: 'Site inspection', isCustom: false },
          { name: 'Material sourcing', isCustom: false },
          { name: 'Quality assurance visit', isCustom: false },
          { name: 'Cleanup after works', isCustom: false },
        ],
        materialsIncluded: true,
        materials: [
          { name: 'Insulation panels', quantity: '80', unit: 'sqm' },
          { name: 'Premium laminate', quantity: '70', unit: 'sqm' },
        ],
        deliveryPreparation: 2,
        deliveryPreparationUnit: 'days',
        executionDuration: {
          value: 8,
          unit: 'days',
        },
        buffer: {
          value: 1,
          unit: 'days',
        },
        warrantyPeriod: {
          value: 2,
          unit: 'years',
        },
        includedItems: [],
      },
    ],
    keywords: ['loft', 'renovation', 'brussels'],
    services: [
      {
        category: 'Renovation',
        service: 'Loft renovation',
        areaOfWork: 'Interior',
      },
    ],
  },
  {
    title: 'Express Kitchen Refresh – Antwerp',
    description:
      'Two-day kitchen refresh focusing on cabinetry painting, backsplash replacement, and appliance alignment. Ideal for rapid improvements with minimal downtime.',
    category: 'Interior',
    service: 'Kitchen upgrade',
    areaOfWork: 'Kitchen',
    timeMode: 'hours',
    priceModel: 'hours',
    distance: {
      address: 'Meir 78, 2000 Antwerp, Belgium',
      useCompanyAddress: false,
      maxKmRange: 35,
      noBorders: false,
      borderLevel: 'province',
      coordinates: {
        latitude: 51.21989,
        longitude: 4.40346,
      },
    },
    preparationDuration: {
      value: 12,
      unit: 'hours',
    },
    executionDuration: {
      value: 16,
      unit: 'hours',
    },
    bufferDuration: {
      value: 4,
      unit: 'hours',
    },
    subprojects: [
      {
        name: 'Kitchen Refresh (Day Pack)',
        description: 'Cabinet prep + paint, backsplash replacement, and finishing.',
        projectType: ['Residential'],
        pricing: {
          type: 'unit',
          amount: 85,
        },
        included: [
          { name: 'Surface preparation', isCustom: false },
          { name: 'Primer & paint', isCustom: false },
          { name: 'Cleanup & disposal', isCustom: false },
        ],
        materialsIncluded: false,
        deliveryPreparation: 4,
        deliveryPreparationUnit: 'hours',
        executionDuration: {
          value: 8,
          unit: 'hours',
        },
        buffer: {
          value: 2,
          unit: 'hours',
        },
        warrantyPeriod: {
          value: 10,
          unit: 'months',
        },
      },
    ],
    keywords: ['kitchen', 'refresh', 'antwerp'],
    services: [
      {
        category: 'Interior',
        service: 'Kitchen upgrade',
        areaOfWork: 'Kitchen',
      },
    ],
  },
  {
    title: 'Garden Deck & Pergola Build – Ghent',
    description:
      'Custom wooden deck with pergola, lighting preparation, and weather-proofing. Includes 3D visualization before kickoff.',
    category: 'Exterior',
    service: 'Deck building',
    areaOfWork: 'Garden',
    timeMode: 'days',
    priceModel: 'sqm total',
    distance: {
      address: 'Korenmarkt 3, 9000 Ghent, Belgium',
      useCompanyAddress: false,
      maxKmRange: 55,
      noBorders: false,
      borderLevel: 'country',
      coordinates: {
        latitude: 51.05434,
        longitude: 3.71742,
      },
    },
    preparationDuration: {
      value: 4,
      unit: 'days',
    },
    executionDuration: {
      value: 14,
      unit: 'days',
    },
    bufferDuration: {
      value: 3,
      unit: 'days',
    },
    subprojects: [
      {
        name: 'Deck & Pergola Combo',
        description: 'Complete deck construction with cedar pergola and sealing.',
        projectType: ['Outdoor'],
        pricing: {
          type: 'fixed',
          amount: 9800,
        },
        included: [
          { name: '3D visualization', isCustom: false },
          { name: 'Material delivery', isCustom: false },
          { name: 'Post-project inspection', isCustom: false },
        ],
        materialsIncluded: true,
        materials: [
          { name: 'Thermowood boards', quantity: '50', unit: 'sqm' },
          { name: 'Pergola posts', quantity: '6', unit: 'pcs' },
        ],
        deliveryPreparation: 3,
        deliveryPreparationUnit: 'days',
        executionDuration: {
          value: 12,
          unit: 'days',
        },
        buffer: {
          value: 2,
          unit: 'days',
        },
        warrantyPeriod: {
          value: 3,
          unit: 'years',
        },
      },
    ],
    keywords: ['deck', 'pergola', 'garden'],
    services: [
      {
        category: 'Exterior',
        service: 'Deck building',
        areaOfWork: 'Garden',
      },
    ],
  },
];

const seedProjects = async () => {
  try {
    console.log('🌱 Starting sample project seed...');
    await connectDB();

    const professional = await User.findOne({
      role: 'professional',
      professionalStatus: 'approved',
    });

    if (!professional) {
      throw new Error('No approved professionals found. Seed professionals first.');
    }

    for (const projectDef of sampleProjects) {
      const existing = await Project.findOne({
        title: projectDef.title,
        professionalId: professional._id,
      });

      if (existing) {
        console.log(`↷ Project "${projectDef.title}" already exists. Skipping.`);
        continue;
      }

      await Project.create({
        professionalId: professional._id,
        resources: [professional._id],
        status: 'published',
        bookingStatus: 'rfq',
        description: projectDef.description,
        title: projectDef.title,
        category: projectDef.category,
        service: projectDef.service,
        areaOfWork: projectDef.areaOfWork,
        services: projectDef.services,
        priceModel: projectDef.priceModel,
        timeMode: projectDef.timeMode,
        distance: projectDef.distance,
        preparationDuration: projectDef.preparationDuration,
        executionDuration: projectDef.executionDuration,
        bufferDuration: projectDef.bufferDuration,
        subprojects: projectDef.subprojects,
        extraOptions: [
          {
            name: 'Priority scheduling',
            description: 'Move to the next available slot with weekend support.',
            price: 350,
            isCustom: false,
          },
          {
            name: 'Extended warranty',
            description: 'Add 12 months of extended warranty coverage.',
            price: 420,
            isCustom: false,
          },
        ],
        termsConditions: [],
        faq: [],
        rfqQuestions: [
          {
            question: 'Describe the current condition of the area.',
            type: 'text',
            isRequired: true,
          },
          {
            question: 'Do you need us to source materials?',
            type: 'multiple_choice',
            options: ['Yes', 'No, I have them ready'],
            isRequired: true,
          },
        ],
        postBookingQuestions: [],
        media: {
          images: [
            'https://images.unsplash.com/photo-1595526114035-0d45ed0c1210',
            'https://images.unsplash.com/photo-1505691938895-1758d7feb511',
          ],
        },
        keywords: projectDef.keywords,
      });

      console.log(`✅ Created project "${projectDef.title}"`);
    }

    console.log('🎉 Sample projects seeded successfully.');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to seed projects:', error);
    process.exit(1);
  }
};

seedProjects();

export default seedProjects;
