import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), discover: vi.fn(), settings: vi.fn() }));
vi.mock("../../services/odooAccounting", () => ({
  odooJson2Call: mocks.call,
  discoverOdooAccountingConfig: mocks.discover,
}));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: mocks.settings } }));
vi.mock("../../models/serviceConfiguration", () => ({
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
import { maybeDispatchPeppolInvoice } from "../../services/peppolDispatch";

const config = {
  companyId: 1, incomeAccountId: 10, expenseAccountId: 20,
  salesJournalId: 30, selfBillingJournalId: 40,
  taxIdsByRate: { "21": 51, "6": 52 }, reverseChargeTaxId: 53,
  purchaseTaxIdsByRate: { "21": 61, "6": 62 }, purchaseReverseChargeTaxId: 63,
};
const booking = {
  customer: { customerType: "business", vatNumber: "BE1002103337", companyAddress: { country: "BE" } },
  professional: { businessInfo: { vatNumber: "BE1002103337", country: "BE" } },
};
const dispatch = (side: "supplier" | "customer", documentType: "invoice" | "credit_note" = "invoice") =>
  maybeDispatchPeppolInvoice({
    booking, side, documentType, invoiceNumber: "TEST-1", ublXml: "<Invoice/>", invoiceUblUrl: "",
    lineItems: [{ description: "Service", price: 100, vatRate: 21 }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.discover.mockResolvedValue({ ...config });
  mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo" } });
  mocks.call.mockImplementation(async (_config, model, method) => {
    switch (`${model}.${method}`) {
      case "account.move.search_read": return [];
      case "res.partner.search_read": return [{ id: 60 }];
      case "account.move.create": return 70;
      case "ir.attachment.search_read": return [{ id: 80 }];
      case "account.move.action_post": return true;
      case "account.move.button_process_edi_web_services": return true;
      case "account.edi.document.search_read": return [{ state: "sent" }];
      default: throw new Error(`Unexpected call ${model}.${method}`);
    }
  });
});

describe("Peppol Odoo dispatch", () => {
  it.each(["invoice", "credit_note"] as const)("creates supplier %s in the self-billing purchase journal", async (documentType) => {
    const result = await dispatch("supplier", documentType);
    expect(result.status).toBe("sent");
    const create = mocks.call.mock.calls.find((call) => call[1] === "account.move" && call[2] === "create");
    expect(create?.[3].vals_list).toMatchObject({
      move_type: documentType === "invoice" ? "in_invoice" : "in_refund", journal_id: 40,
      invoice_line_ids: [[0, 0, expect.objectContaining({ account_id: 20, tax_ids: [[6, 0, [61]]] })]],
    });
  });
  it("keeps customer invoices in the sales journal", async () => {
    expect((await dispatch("customer")).status).toBe("sent");
    const create = mocks.call.mock.calls.find((call) => call[1] === "account.move" && call[2] === "create");
    expect(create?.[3].vals_list).toMatchObject({ move_type: "out_invoice", journal_id: 30 });
  });
  it("fails before creating records when the self-billing journal is missing", async () => {
    mocks.discover.mockResolvedValue({ ...config, selfBillingJournalId: undefined });
    const result = await dispatch("supplier");
    expect(result).toMatchObject({ status: "failed", attempts: 0 });
    expect(result.reason).toMatch(/self.billing.*journal/i);
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("reports send rejection as failed with the actual Odoo error", async () => {
    const normal = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args) => {
      if (args[2] === "button_process_edi_web_services") throw new Error("Recipient is not registered on Peppol");
      return normal(...args);
    });
    expect(await dispatch("supplier")).toMatchObject({ status: "failed", reason: "Recipient is not registered on Peppol" });
  });

  it.each([["sent", "sent"], ["processing", "queued"]])("refreshes an existing %s move without sending it again", async (state, status) => {
    const normal = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args) => {
      if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 70, state: "posted" }];
      if (args[1] === "account.edi.document") return [{ state }];
      return normal(...args);
    });
    expect(await dispatch("supplier")).toMatchObject({ status });
    expect(mocks.call.mock.calls.some((call) => call[2] === "button_process_edi_web_services")).toBe(false);
    expect(mocks.call.mock.calls.some((call) => call[2] === "create")).toBe(false);
  });
});
