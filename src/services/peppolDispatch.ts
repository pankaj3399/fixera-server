import PlatformSettings from "../models/platformSettings";
import { normalizeVatCountry } from "../utils/vatManagement";

export type PeppolDispatchStatus = "skipped" | "queued" | "sent" | "failed";

export type PeppolDispatchResult = {
  status: PeppolDispatchStatus;
  provider?: string;
  reference?: string;
  reason?: string;
  dispatchedAt?: Date;
  response?: unknown;
};

const isBelgianB2BBooking = (booking: any): boolean => {
  const customer = booking.customer || {};
  if (customer.customerType !== "business") return false;
  const country = normalizeVatCountry(
    customer.companyAddress?.country || customer.location?.country || booking.vatDecision?.country
  );
  return country === "BE";
};

export async function maybeDispatchPeppolInvoice(params: {
  booking: any;
  invoiceNumber: string;
  ublXml: string;
  invoiceUblUrl: string;
}): Promise<PeppolDispatchResult> {
  if (!isBelgianB2BBooking(params.booking)) {
    return { status: "skipped", reason: "Peppol dispatch is limited to Belgian B2B customers" };
  }

  const settings = await PlatformSettings.getCurrentConfig();
  const eInvoicing = settings.eInvoicing || {};

  if (!eInvoicing.peppolEnabled) {
    return { status: "skipped", reason: "Peppol e-invoicing is disabled in platform settings" };
  }

  const provider = eInvoicing.provider || "manual";
  const dispatchedAt = new Date();
  const reference = `peppol-${params.invoiceNumber}-${dispatchedAt.getTime()}`;

  if (provider === "manual") {
    return {
      status: "queued",
      provider,
      reference,
      reason: "UBL artifact stored; manual Peppol dispatch required",
      dispatchedAt,
    };
  }

  const endpoint =
    provider === "billit"
      ? process.env.BILLIT_PEPPOL_ENDPOINT || process.env.BILLIT_API_URL
      : process.env.ODOO_PEPPOL_ENDPOINT || process.env.ODOO_API_URL;
  const apiKey =
    provider === "billit"
      ? process.env.BILLIT_API_KEY
      : process.env.ODOO_API_KEY;

  if (!endpoint || !apiKey) {
    return {
      status: "failed",
      provider,
      reference,
      reason: `${provider} Peppol endpoint/API key is not configured`,
      dispatchedAt,
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        invoiceNumber: params.invoiceNumber,
        peppolParticipantId: eInvoicing.peppolParticipantId,
        supplierParticipantId: eInvoicing.peppolParticipantId,
        customerVatNumber: params.booking.customer?.vatNumber,
        customerName: params.booking.customer?.businessName || params.booking.customer?.name,
        ublXml: params.ublXml,
        ublUrl: params.invoiceUblUrl,
      }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      return {
        status: "failed",
        provider,
        reference,
        reason: `${provider} Peppol dispatch failed with HTTP ${response.status}`,
        dispatchedAt,
        response: parsed,
      };
    }

    const providerReference =
      typeof parsed === "object" && parsed !== null
        ? (parsed as any).id || (parsed as any).reference || (parsed as any).uuid
        : undefined;

    return {
      status: "sent",
      provider,
      reference: providerReference ? String(providerReference) : reference,
      dispatchedAt,
      response: parsed,
    };
  } catch (error: any) {
    return {
      status: "failed",
      provider,
      reference,
      reason: error?.message || `${provider} Peppol dispatch failed`,
      dispatchedAt,
    };
  }
}
