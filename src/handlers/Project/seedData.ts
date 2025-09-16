import ServiceCategory from '../../models/serviceCategory';

export const seedServiceCategories = async () => {
  try {
    // Check if data already exists
    const existingCount = await ServiceCategory.countDocuments();
    if (existingCount > 0) {
      console.log('Service categories already exist, skipping seed');
      return;
    }

    const categories = [
      {
        name: 'Exterior',
        slug: 'exterior',
        description: 'Exterior work and structural services',
        icon: 'building',
        isActive: true,
        countries: ['BE', 'NL'],
        services: [
          {
            name: 'Architect',
            slug: 'architect',
            description: 'Architectural design and planning services',
            pricingModels: ['fixed'],
            areasOfWork: ['Residential Design', 'Commercial Design', 'Renovation Planning'],
            projectTypes: ['New Build', 'Renovation', 'Extension', 'Consultation'],
            requiredCertifications: ['Architecture License'],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Demolition',
            slug: 'demolition',
            description: 'Demolition and removal services',
            pricingModels: ['fixed', 'm2'],
            areasOfWork: ['Interior Demolition', 'Exterior Demolition', 'Partial Demolition'],
            projectTypes: ['Full Demolition', 'Partial Demolition', 'Interior Strip-out'],
            requiredCertifications: ['Demolition License'],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Roofing',
            slug: 'roofing',
            description: 'Roof installation, repair and maintenance',
            pricingModels: ['fixed', 'm2'],
            areasOfWork: ['Tile Roofing', 'Metal Roofing', 'Flat Roofing', 'Roof Repair'],
            projectTypes: ['New Installation', 'Repair', 'Maintenance', 'Replacement'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          }
        ]
      },
      {
        name: 'Interior',
        slug: 'interior',
        description: 'Interior work and installations',
        icon: 'home',
        isActive: true,
        countries: ['BE', 'NL'],
        services: [
          {
            name: 'Plumber',
            slug: 'plumber',
            description: 'Plumbing installation and repair services',
            pricingModels: ['fixed', 'hour'],
            areasOfWork: ['Kitchen Plumbing', 'Bathroom Plumbing', 'Heating Systems', 'Pipe Repair'],
            projectTypes: ['Installation', 'Repair', 'Maintenance', 'Emergency Service'],
            requiredCertifications: ['Plumbing Certificate'],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Electrician',
            slug: 'electrician',
            description: 'Electrical installation and repair services',
            pricingModels: ['fixed', 'hour'],
            areasOfWork: ['Wiring', 'Lighting', 'Power Outlets', 'Safety Systems'],
            projectTypes: ['Installation', 'Repair', 'Upgrade', 'Safety Inspection'],
            requiredCertifications: ['Electrical License'],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Painter',
            slug: 'painter',
            description: 'Interior and exterior painting services',
            pricingModels: ['fixed', 'm2', 'hour'],
            areasOfWork: ['Interior Painting', 'Exterior Painting', 'Wallpaper', 'Decorative Finishes'],
            projectTypes: ['New Paint', 'Refresh', 'Color Change', 'Repair & Paint'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          }
        ]
      },
      {
        name: 'Outdoor work',
        slug: 'outdoor',
        description: 'Garden, landscaping and outdoor projects',
        icon: 'tree',
        isActive: true,
        countries: ['BE', 'NL'],
        services: [
          {
            name: 'Garden & Terrace',
            slug: 'garden',
            description: 'Garden design and landscaping services',
            pricingModels: ['fixed', 'm2'],
            areasOfWork: ['Garden Design', 'Landscaping', 'Terrace Installation', 'Plant Installation'],
            projectTypes: ['New Garden', 'Garden Renovation', 'Maintenance', 'Seasonal Work'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Driveways',
            slug: 'driveways',
            description: 'Driveway installation and repair',
            pricingModels: ['fixed', 'm2'],
            areasOfWork: ['Concrete Driveways', 'Asphalt Driveways', 'Paver Driveways', 'Gravel Driveways'],
            projectTypes: ['New Installation', 'Repair', 'Resurfacing', 'Sealing'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Fences',
            slug: 'fences',
            description: 'Fence installation and repair services',
            pricingModels: ['fixed', 'meter'],
            areasOfWork: ['Wood Fencing', 'Metal Fencing', 'Vinyl Fencing', 'Gate Installation'],
            projectTypes: ['New Installation', 'Repair', 'Replacement', 'Gate Addition'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          }
        ]
      },
      {
        name: 'Moving & small tasks',
        slug: 'maintenance',
        description: 'Small maintenance and moving services',
        icon: 'wrench',
        isActive: true,
        countries: ['BE', 'NL'],
        services: [
          {
            name: 'House Cleaning',
            slug: 'cleaning',
            description: 'Professional house cleaning services',
            pricingModels: ['fixed', 'hour', 'm2'],
            areasOfWork: ['Regular Cleaning', 'Deep Cleaning', 'Move-in/out Cleaning', 'Post-Construction Cleaning'],
            projectTypes: ['One-time', 'Weekly', 'Bi-weekly', 'Monthly'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Handyman',
            slug: 'handyman',
            description: 'General handyman and repair services',
            pricingModels: ['fixed', 'hour'],
            areasOfWork: ['General Repairs', 'Assembly', 'Installation', 'Maintenance'],
            projectTypes: ['Repair', 'Installation', 'Maintenance', 'Assembly'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Moving Service',
            slug: 'moving',
            description: 'Moving and transportation services',
            pricingModels: ['fixed', 'hour'],
            areasOfWork: ['Local Moving', 'Long Distance', 'Packing', 'Storage'],
            projectTypes: ['Residential Move', 'Office Move', 'Packing Only', 'Loading/Unloading'],
            requiredCertifications: [],
            isActive: true,
            countries: ['BE', 'NL']
          }
        ]
      },
      {
        name: 'Inspections',
        slug: 'inspections',
        description: 'Property inspections and certifications',
        icon: 'search',
        isActive: true,
        countries: ['BE', 'NL'],
        services: [
          {
            name: 'Boiler Maintenance',
            slug: 'boiler',
            description: 'Boiler inspection and maintenance services',
            pricingModels: ['fixed'],
            areasOfWork: ['Annual Inspection', 'Repair Service', 'Installation', 'Emergency Service'],
            projectTypes: ['Annual Inspection', 'Repair', 'Installation', 'Emergency'],
            requiredCertifications: ['Gas Safety Certificate'],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Electrical Inspection',
            slug: 'electrical-inspection',
            description: 'Electrical safety inspections',
            pricingModels: ['fixed'],
            areasOfWork: ['Safety Inspection', 'Code Compliance', 'Installation Testing'],
            projectTypes: ['Safety Inspection', 'Code Compliance', 'Pre-sale Inspection'],
            requiredCertifications: ['Electrical Inspector License'],
            isActive: true,
            countries: ['BE', 'NL']
          },
          {
            name: 'Energy Performance Certificate',
            slug: 'energy-certificate',
            description: 'Energy performance certification',
            pricingModels: ['fixed'],
            areasOfWork: ['Residential EPC', 'Commercial EPC', 'Renovation Assessment'],
            projectTypes: ['New Certificate', 'Renewal', 'Consultation'],
            requiredCertifications: ['Energy Assessor Certificate'],
            isActive: true,
            countries: ['BE', 'NL']
          }
        ]
      },
      {
        name: 'Large-scale renovation',
        slug: 'renovations',
        description: 'Complete renovation and construction projects',
        icon: 'hammer',
        isActive: true,
        countries: ['BE', 'NL'],
        services: [
          {
            name: 'Full Renovation',
            slug: 'full-renovation',
            description: 'Complete home renovation projects',
            pricingModels: ['fixed'],
            areasOfWork: ['Kitchen Renovation', 'Bathroom Renovation', 'Whole House', 'Commercial Renovation'],
            projectTypes: ['Complete Renovation', 'Partial Renovation', 'Restoration', 'Modernization'],
            requiredCertifications: ['General Contractor License'],
            isActive: true,
            countries: ['BE', 'NL']
          }
        ]
      }
    ];

    await ServiceCategory.insertMany(categories);
    console.log('✅ Service categories seeded successfully');
  } catch (error) {
    console.error('❌ Error seeding service categories:', error);
  }
};