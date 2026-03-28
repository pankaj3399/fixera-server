import WarrantyClaim from "../models/warrantyClaim";
import {
  autoCloseResolvedWarrantyClaim,
  autoEscalateWarrantyClaim,
} from "../handlers/WarrantyClaim";

export const runWarrantyClaimChecks = async () => {
  const now = new Date();
  let escalated = 0;
  let closed = 0;
  const errors: string[] = [];

  console.log(`[Warranty Scheduler] ⏳ Running checks at ${now.toISOString()}`);

  const [staleOpenClaims, overdueResolvedClaims] = await Promise.all([
    WarrantyClaim.find({
      status: "open",
      "sla.professionalResponseDueAt": { $exists: true, $lte: now },
    }),
    WarrantyClaim.find({
      status: "resolved",
      "sla.customerConfirmationDueAt": { $exists: true, $lte: now },
    }),
  ]);

  console.log(`[Warranty Scheduler] Found ${staleOpenClaims.length} stale open claim(s) to escalate`);
  console.log(`[Warranty Scheduler] Found ${overdueResolvedClaims.length} overdue resolved claim(s) to auto-close`);

  for (const claim of staleOpenClaims) {
    try {
      console.log(`[Warranty Scheduler] Escalating claim ${(claim as any).claimNumber || claim._id} (professional response due: ${(claim as any).sla?.professionalResponseDueAt})`);
      await autoEscalateWarrantyClaim(claim);
      escalated++;
      console.log(`[Warranty Scheduler] ✅ Escalated claim ${(claim as any).claimNumber || claim._id}`);
    } catch (error) {
      const msg = `Failed to auto-escalate claim ${claim._id}`;
      console.error(`[Warranty Scheduler] ❌ ${msg}:`, error);
      errors.push(msg);
    }
  }

  for (const claim of overdueResolvedClaims) {
    try {
      console.log(`[Warranty Scheduler] Auto-closing claim ${(claim as any).claimNumber || claim._id} (customer confirmation due: ${(claim as any).sla?.customerConfirmationDueAt})`);
      await autoCloseResolvedWarrantyClaim(claim);
      closed++;
      console.log(`[Warranty Scheduler] ✅ Auto-closed claim ${(claim as any).claimNumber || claim._id}`);
    } catch (error) {
      const msg = `Failed to auto-close claim ${claim._id}`;
      console.error(`[Warranty Scheduler] ❌ ${msg}:`, error);
      errors.push(msg);
    }
  }

  console.log(`[Warranty Scheduler] ✅ Done — escalated: ${escalated}, closed: ${closed}, errors: ${errors.length}`);
  return { escalated, closed, errors };
};
