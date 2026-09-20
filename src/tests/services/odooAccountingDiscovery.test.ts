import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Odoo journal discovery", () => {
  it("discovers only an active self-billing purchase journal in the selected company", async () => {
    vi.resetModules();
    vi.stubEnv("ODOO_API_URL", "https://odoo.example");
    vi.stubEnv("ODOO_API_KEY", "test-key");
    vi.stubEnv("ODOO_COMPANY_ID", "1");
    const requests: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      let data: unknown;
      if (url.endsWith("account.account/search_read")) {
        data = body.domain[0][2] === "income" ? [{ id: 10, code: "700100" }] : [{ id: 20, name: "Subcontracting" }];
      } else if (url.endsWith("account.tax/search_read")) {
        data = body.domain[0][2] === "purchase"
          ? [
              { id: 60, name: "21% M", amount: 21, amount_type: "percent", price_include: false },
              { id: 61, name: "21% S", amount: 21, amount_type: "percent", price_include: false },
              { id: 62, name: "6% S", amount: 6, amount_type: "percent", price_include: false },
              { id: 63, name: "0% S.Cocont", amount: 0, amount_type: "percent", price_include: false },
            ]
          : [{ id: 51, name: "21%", amount: 21 }, { id: 52, name: "6%", amount: 6 }, { id: 53, name: "0% Cocont", amount: 0 }];
      } else if (url.endsWith("account.journal/fields_get")) {
        data = { is_self_billing: { type: "boolean" } };
      } else if (url.endsWith("account.journal/search_read")) {
        data = body.domain[0][2] === "sale" ? [{ id: 30 }] : [{ id: 40 }];
      } else throw new Error(`Unexpected ${url}`);
      return new Response(JSON.stringify(data), { status: 200 });
    }));
    const { discoverOdooAccountingConfig } = await import("../../services/odooAccounting");
    expect(await discoverOdooAccountingConfig()).toMatchObject({ salesJournalId: 30, selfBillingJournalId: 40, purchaseTaxIdsByRate: { "21": 61, "6": 62 }, purchaseReverseChargeTaxId: 63 });
    const purchase = requests.find(({ body }) => body.domain?.some((term: any) => term[0] === "is_self_billing"));
    expect(purchase?.body).toMatchObject({
      domain: [["type", "=", "purchase"], ["is_self_billing", "=", true], ["company_id", "=", 1], ["active", "=", true]],
      context: { allowed_company_ids: [1], force_company: 1 }, order: "id asc",
    });
    vi.stubEnv("ODOO_COMPANY_ID", "2");
    expect((await discoverOdooAccountingConfig()).companyId).toBe(2);
  });
});
