import { beforeEach, describe, expect, it, vi } from "vitest";

const { odooJson2CallMock } = vi.hoisted(() => ({ odooJson2CallMock: vi.fn() }));

vi.mock("../../services/odooAccounting", () => ({
  odooJson2Call: odooJson2CallMock,
  discoverOdooAccountingConfig: vi.fn(),
}));

import { triggerOdooEdiSend, readOdooEdiDeliveryState } from "../../services/peppolDispatch";
import type { OdooAccountingConfig } from "../../services/odooAccounting";

const config = {
  baseUrl: "https://odoo.example",
  apiKey: "key",
  companyId: 1,
  incomeAccountId: 1,
  expenseAccountId: 2,
  defaultTaxId: 3,
  reverseChargeTaxId: 11,
  autoPost: false,
  taxIdsByRate: { "21": 3 },
} as OdooAccountingConfig;

const dispatchMock = (handlers: Record<string, (body: any) => unknown>) =>
  odooJson2CallMock.mockImplementation((...rawArgs: any[]) => {
    // Vitest may probe the mock with no args; only real Odoo calls matter.
    if (rawArgs.length < 4) return Promise.resolve(undefined);
    const [, model, method, body] = rawArgs;
    const key = `${model}.${method}`;
    const handler = handlers[key];
    if (!handler) return Promise.reject(new Error(`Unexpected Odoo call ${key}`));
    try {
      return Promise.resolve(handler(body));
    } catch (error) {
      return Promise.reject(error);
    }
  });

describe("triggerOdooEdiSend", () => {
  beforeEach(() => odooJson2CallMock.mockReset());

  it("uses the legacy button_process_edi_web_services when it exists", async () => {
    dispatchMock({ "account.move.button_process_edi_web_services": () => true });
    const mode = await triggerOdooEdiSend(config, 100);
    expect(mode).toBe("legacy");
    expect(odooJson2CallMock).toHaveBeenCalledTimes(1);
    expect(odooJson2CallMock.mock.calls[0][1]).toBe("account.move");
    expect(odooJson2CallMock.mock.calls[0][2]).toBe("button_process_edi_web_services");
  });

  it("falls back to the Odoo 17+ send wizard when the legacy method is missing", async () => {
    const createBodies: any[] = [];
    dispatchMock({
      "account.move.button_process_edi_web_services": () => {
        throw new Error("The method 'account.move.button_process_edi_web_services' does not exist");
      },
      "account.move.send.wizard.create": (body) => {
        createBodies.push(body);
        return 505;
      },
      "account.move.send.wizard.action_send_and_print": () => true,
      "account.move.send.wizard.unlink": () => true,
    });

    const mode = await triggerOdooEdiSend(config, 100);
    expect(mode).toBe("peppol-wizard");
    const calls = odooJson2CallMock.mock.calls.map((c) => `${c[1]}.${c[2]}`);
    expect(calls).toContain("account.move.send.wizard.create");
    expect(calls).toContain("account.move.send.wizard.action_send_and_print");
    expect(createBodies[0]).toEqual({
      vals_list: [{ move_id: 100, sending_methods: ["peppol"], extra_edis: ["peppol"] }],
    });
  });

  it("does not swallow unrelated legacy errors", async () => {
    dispatchMock({
      "account.move.button_process_edi_web_services": () => {
        throw new Error("Authentication failed");
      },
    });
    await expect(triggerOdooEdiSend(config, 100)).rejects.toThrow(/Authentication failed/);
  });
});

describe("readOdooEdiDeliveryState", () => {
  beforeEach(() => odooJson2CallMock.mockReset());

  it("keeps processing queued even when Odoo marks the move peppol_is_sent", async () => {
    dispatchMock({
      "account.edi.document.search_read": () => { throw new Error("model does not exist"); },
      "account.move.read": () => [{ peppol_is_sent: true, peppol_move_state: "processing" }],
    });
    expect(await readOdooEdiDeliveryState(config, 100)).toEqual([{ state: "processing" }]);
  });

  it("reads the modern move-level Peppol state when account.edi.document is gone", async () => {
    dispatchMock({
      "account.edi.document.search_read": () => {
        throw new Error("the model 'account.edi.document' does not exist");
      },
      "account.move.read": () => [{ peppol_is_sent: true, peppol_move_state: "done" }],
    });

    const state = await readOdooEdiDeliveryState(config, 100);
    expect(state).toEqual([{ state: "sent" }]);
    expect(odooJson2CallMock.mock.calls.some((c) => c[1] === "account.move" && c[2] === "read")).toBe(true);
  });

  it("surfaces a modern move-level error state", async () => {
    dispatchMock({
      "account.edi.document.search_read": () => {
        throw new Error("the model 'account.edi.document' does not exist");
      },
      "account.move.read": () => [{ peppol_is_sent: false, peppol_move_state: "error" }],
    });

    const state = await readOdooEdiDeliveryState(config, 100);
    expect(state).toEqual([{ state: "error" }]);
  });
});
