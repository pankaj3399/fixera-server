import { Request, Response } from 'express';
import { loadMarketingServiceOptions } from '../../utils/marketing/serviceCatalog';

export const listMarketingServiceOptions = async (req: Request, res: Response) => {
  try {
    const countries = typeof req.query.countries === 'string'
      ? req.query.countries.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
      : [];
    const services = await loadMarketingServiceOptions(countries);
    return res.json({
      success: true,
      data: { services },
    });
  } catch (error) {
    console.error('listMarketingServiceOptions:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load marketing service options' });
  }
};
