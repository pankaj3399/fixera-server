import { beforeAll, describe, expect, it, vi } from "vitest";

// Opt in only: ODOO_PEPPOL_DEMO_COMPANY_ID=3 node --env-file=.env
// node_modules/vitest/vitest.mjs run src/tests/integration/peppolOdooDemo.test.ts
// Creates four synthetic documents in a preconfigured Odoo demo company.
// Only application settings are fixtures; all Odoo calls and XML generation are real.
vi.mock("../../models/platformSettings", () => ({
  default: { getCurrentConfig: async () => ({ eInvoicing: { peppolEnabled: true, provider: "odoo" } }) },
}));
vi.mock("../../models/serviceConfiguration", () => ({
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
import { discoverOdooAccountingConfig, odooJson2Call, type OdooAccountingConfig } from "../../services/odooAccounting";
import { maybeDispatchPeppolInvoice, readOdooEdiDeliveryState } from "../../services/peppolDispatch";

const demoCompanyId = Number(process.env.ODOO_PEPPOL_DEMO_COMPANY_ID);

describe.skipIf(!demoCompanyId)("live Odoo Peppol demo", () => {
  let config: OdooAccountingConfig;
  const call = <T>(model: string, method: string, body: Record<string, unknown>) =>
    odooJson2Call<T>(config, model, method, body, config.companyId);

  beforeAll(async () => {
    process.env.ODOO_COMPANY_ID = String(demoCompanyId);
    config = await discoverOdooAccountingConfig();
    expect(config.companyId).toBe(demoCompanyId);
    const companies = await call<any[]>("res.company", "read", {
      ids: [demoCompanyId], fields: ["name", "peppol_eas", "account_peppol_proxy_state"],
    });
    expect(companies[0].name).toContain("TEST ONLY");
    expect(companies[0].peppol_eas).toBe("odemo");
    expect(companies[0].account_peppol_proxy_state).toBe("receiver");
    const users = await call<any[]>("account_edi_proxy_client.user", "search_read", {
      domain: [["company_id", "=", demoCompanyId], ["proxy_type", "=", "peppol"]], fields: ["edi_mode"],
    });
    expect(users).toHaveLength(1);
    expect(users[0].edi_mode).toBe("demo");
  }, 60_000);

  it("delivers customer invoices, self-bills, and both credit notes, then refreshes without duplicates", async () => {
    const booking = {
      bookingNumber: "PEPPOL-DEMO-TEST-ONLY", payment: { currency: "EUR" },
      customer: { customerType: "business", name: "Peppol Demo Customer - TEST ONLY", vatNumber: "BE0123456749", companyAddress: { country: "BE" } },
      professional: { name: "Peppol Demo Supplier - TEST ONLY", businessInfo: { vatNumber: "BE0123456848", country: "BE" } },
    };
    const run = Date.now();
    const documents = [];
    for (const side of ["customer", "supplier"] as const) {
      for (const documentType of ["invoice", "credit_note"] as const) {
        const params = {
          booking, side, documentType, invoiceNumber: `DEMO-${run}-${side}-${documentType}`,
          ublXml: '<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><!-- Demo fixture; Odoo generates the outbound XML. --></Invoice>',
          invoiceUblUrl: "", reverseCharge: false,
          lineItems: [{ description: "Peppol demo service - no real transaction", price: 1, vatRate: 21 }],
        };
        const result = await maybeDispatchPeppolInvoice(params);
        expect(result.status, result.reason).toMatch(/^(queued|sent)$/);
        const moveId = Number(result.reference?.replace("odoo-account.move-", ""));
        const [move] = await call<any[]>("account.move", "read", {
          ids: [moveId], fields: ["name", "journal_id", "company_id", "ubl_cii_xml_id", "peppol_message_uuid", "invoice_line_ids"],
        });
        expect(move.company_id[0]).toBe(demoCompanyId);
        expect(move.journal_id[0]).toBe(side === "supplier" ? config.selfBillingJournalId : config.salesJournalId);
        expect(move.peppol_message_uuid).toMatch(/^demo_/);
        expect(move.ubl_cii_xml_id[0]).toBeGreaterThan(0);
        const [attachment] = await call<any[]>("ir.attachment", "read", { ids: [move.ubl_cii_xml_id[0]], fields: ["datas"] });
        const xml = Buffer.from(attachment.datas, "base64").toString("utf8");
        const typeCode = side === "supplier" ? (documentType === "invoice" ? "389" : "261") : (documentType === "invoice" ? "380" : "381");
        expect(xml).toContain(`>${typeCode}</cbc:${documentType === "invoice" ? "Invoice" : "CreditNote"}TypeCode>`);
        const lines = await call<any[]>("account.move.line", "read", { ids: move.invoice_line_ids, fields: ["tax_ids"] });
        const taxes = await call<any[]>("account.tax", "read", { ids: lines.flatMap((line) => line.tax_ids), fields: ["type_tax_use"] });
        expect(taxes.every((tax) => tax.type_tax_use === (side === "supplier" ? "purchase" : "sale"))).toBe(true);
        documents.push({ params, moveId, reference: result.reference, name: move.name });
      }
    }
    const crons = await call<any[]>("ir.cron", "search_read", {
      domain: [["code", "ilike", "_cron_peppol_get_message_status"]], fields: ["id"],
    });
    expect(crons).toHaveLength(1);
    // Odoo's demo proxy returns one document per status request.
    for (let attempt = 0; attempt < documents.length + 2; attempt++) {
      const states = await call<any[]>("account.move", "read", { ids: documents.map((d) => d.moveId), fields: ["peppol_move_state"] });
      if (states.every((move) => move.peppol_move_state === "done")) break;
      await call("ir.cron", "method_direct_trigger", { ids: [crons[0].id] });
    }
    for (const document of documents) {
      expect(await readOdooEdiDeliveryState(config, document.moveId)).toEqual([{ state: "sent" }]);
      expect(await maybeDispatchPeppolInvoice(document.params)).toMatchObject({ status: "sent", reference: document.reference });
      const count = await call<number>("account.move", "search_count", {
        domain: [["company_id", "=", demoCompanyId], ["ref", "=", document.params.invoiceNumber]],
      });
      expect(count).toBe(1);
      console.log(`DEMO VERIFIED ${document.params.side} ${document.params.documentType}: ${document.name} (move ${document.moveId})`);
    }
  }, 180_000);
});
