import { describe, expect, it, vi, beforeEach } from "vitest";

const { findOneMock } = vi.hoisted(() => ({ findOneMock: vi.fn() }));
vi.mock("../../models/serviceConfiguration", () => ({
  default: { findOne: findOneMock },
}));

import {
  describeCustomerVatDetermination,
  getQuotationTierRateOptionsFromConfig,
  vatRateRejectionMessage,
} from "../../utils/vatManagement";
import { buildQuoteCustomerTotals } from "../../utils/bookingDetails/quoteTotals";
import { commissionedPricingLines } from "../../utils/customerPricing";

const mockConfig = (config: unknown) => {
  findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(config) });
};

const cleaningImmovable = {
  category: "Cleaning",
  vatManagement: { enabled: false, article47Classification: "immovable" },
};

describe("18a — quotation VAT follows the determination diagram", () => {
  beforeEach(() => findOneMock.mockReset());

  it("returns only the reverse-charge option for BE immovable verified B2B", async () => {
    mockConfig(cleaningImmovable);
    const options = await getQuotationTierRateOptionsFromConfig({
      country: "BE",
      bookingCountry: "BE",
      customerType: "business",
      vatNumber: "BE0123456789",
      isVatVerified: true,
      propertyNature: "immovable",
    });
    expect(options).toEqual([
      { rate: 0, country: "BE", label: "Reverse Charge", reverseCharge: true, source: "b2b_exempt" },
    ]);
  });

  it("still offers standard/reduced choice when the determination is the service configuration", async () => {
    mockConfig({
      category: "Cleaning",
      service: "Home cleaning",
      vatManagement: {
        enabled: true,
        article47Classification: "movable",
        logicRules: [{ country: "BE", standardRate: 21, reducedRate: 6, action: "reduced_rate", priority: 0 }],
      },
    });
    const options = await getQuotationTierRateOptionsFromConfig({
      category: "Cleaning",
      service: "Home cleaning",
      country: "BE",
      bookingCountry: "BE",
      customerType: "individual",
      propertyNature: "movable",
    });
    expect(options.map((option) => option.rate).sort((a, b) => a - b)).toEqual([6, 21]);
    expect(options.every((option) => !option.reverseCharge)).toBe(true);
  });

  it("does not grant reverse charge without a verified VAT number", async () => {
    mockConfig(cleaningImmovable);
    const options = await getQuotationTierRateOptionsFromConfig({
      country: "BE",
      bookingCountry: "BE",
      customerType: "business",
      vatNumber: "BE0123456789",
      isVatVerified: false,
      propertyNature: "immovable",
    });
    expect(options.some((option) => option.reverseCharge)).toBe(false);
    expect(options.map((option) => option.rate)).toContain(21);
  });
});

describe("18a — reverse-charge rejection message", () => {
  it("tells the professional every line must use 0% instead of Standard/Reduced", () => {
    const message = vatRateRejectionMessage(
      [{ rate: 0, country: "BE", label: "Reverse Charge", reverseCharge: true, source: "b2b_exempt" }],
      21,
    );
    expect(message).toContain("Reverse charge applies");
    expect(message).toContain("0%");
    expect(message).not.toContain("Standard or Reduced");
  });

  it("keeps the Standard/Reduced message in service-configuration mode", () => {
    const message = vatRateRejectionMessage(
      [
        { rate: 6, country: "BE", label: "6% reduced VAT", reverseCharge: false, source: "reduced" },
        { rate: 21, country: "BE", label: "21% standard VAT", reverseCharge: false, source: "standard" },
      ],
      12,
    );
    expect(message).toContain("Select Standard or Reduced only");
    expect(message).not.toContain("Reverse charge");
  });
});

describe("18b — VAT determination parameters for the professional", () => {
  it("B2C hides the Article 47 class and uses the booking address", () => {
    expect(
      describeCustomerVatDetermination({
        customerType: "individual",
        propertyNature: "movable",
        bookingCountry: "BE",
        vatCountry: "BE",
        reverseCharge: false,
      }),
    ).toEqual({
      customerType: "B2C",
      article47Class: null,
      vatAddressType: "Booking address",
      vatCountry: "BE",
      reverseCharge: false,
    });
  });

  it("B2B movable uses the customer business address when it supplied the VAT country", () => {
    expect(
      describeCustomerVatDetermination({
        customerType: "business",
        propertyNature: "movable",
        bookingCountry: "BE",
        customerBusinessCountry: "NL",
        hasCompanyAddress: true,
        vatCountry: "NL",
        reverseCharge: true,
      }),
    ).toEqual({
      customerType: "B2B",
      article47Class: "Movable",
      vatAddressType: "Customer business address",
      vatCountry: "NL",
      reverseCharge: true,
    });
  });

  it("B2B movable without a company address uses the booking address", () => {
    expect(
      describeCustomerVatDetermination({
        customerType: "business",
        propertyNature: "movable",
        bookingCountry: "BE",
        // Country only from the generic location fallback, no company address.
        customerBusinessCountry: "BE",
        hasCompanyAddress: false,
        vatCountry: "BE",
        reverseCharge: false,
      }).vatAddressType,
    ).toBe("Booking address");
  });

  it("B2B immovable uses the booking address", () => {
    expect(
      describeCustomerVatDetermination({
        customerType: "business",
        propertyNature: "immovable",
        bookingCountry: "BE",
        customerBusinessCountry: "NL",
        vatCountry: "BE",
        reverseCharge: true,
      }).vatAddressType,
    ).toBe("Booking address");
  });

  it("B2B immovable exempt from Belgian reverse charge gets its own class", () => {
    expect(
      describeCustomerVatDetermination({
        customerType: "business",
        propertyNature: "immovable",
        exemptFromBelgianReverseCharge: true,
        bookingCountry: "BE",
        vatCountry: "BE",
        reverseCharge: false,
      }).article47Class,
    ).toBe("Immovable but exempt from Belgian reverse charge");
  });
});

describe("18c — quotation VAT is calculated after commission", () => {
  it("charges VAT on the commission-inclusive amount", () => {
    const totals = buildQuoteCustomerTotals({
      booking: {},
      totalAmount: 100,
      pricingLines: [{ description: "Service", price: 100, vatRate: 21 }],
      commissionPercent: 10,
      currency: "EUR",
    });
    // Customer net 110.00, VAT 21% of 110.00 = 23.10, total 133.10.
    expect(totals?.customerNetAmount).toBe(110);
    expect(totals?.vatAmount).toBe(23.1);
    expect(totals?.totalWithVat).toBe(133.1);
  });

  it("keeps the commissioned line sum exactly equal to the customer net", () => {
    const lines = commissionedPricingLines(
      [
        { description: "A", price: 100, vatRate: 21 },
        { description: "B", price: 33.33, vatRate: 6 },
      ],
      146.66,
      10,
    );
    const sum = Math.round(lines.reduce((total, line) => total + line.price, 0) * 100) / 100;
    expect(sum).toBe(146.66);
  });
});
