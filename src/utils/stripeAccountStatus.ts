export type StripeAccountStatus = 'active' | 'pending' | 'restricted';

export const mapStripeAccountStatus = (
  chargesEnabled?: boolean,
  detailsSubmitted?: boolean
): StripeAccountStatus => {
  if (chargesEnabled) {
    return 'active';
  }

  if (detailsSubmitted) {
    return 'pending';
  }

  return 'restricted';
};

