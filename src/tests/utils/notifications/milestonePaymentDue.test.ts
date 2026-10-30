import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  getCurrentConfig: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../../../models/booking", () => ({ default: { findById: mocks.findById } }));
vi.mock("../../../models/platformSettings", () => ({ default: { getCurrentConfig: mocks.getCurrentConfig } }));
vi.mock("../../../utils/notifications/notify", () => ({ notify: mocks.notify }));

import { findPayableMilestone, notifyMilestonePaymentDue } from "../../../utils/notifications/milestonePaymentDue";

const bookingDoc = (overrides: any = {}) => ({
  _id: "booking-1",
  customer: "customer-1",
  professional: "pro-1",
  status: "booked",
  milestonePayments: [
    { title: "Deposit", amount: 100, order: 0, status: "paid", dueCondition: "on_start", workStatus: "completed" },
    { title: "Mid", amount: 200, order: 1, status: "pending", dueCondition: "on_milestone_completion", workStatus: "pending" },
  ],
  selectedExtraOptions: [],
  payment: { currency: "EUR" },
  ...overrides,
});

describe("findPayableMilestone", () => {
  it("returns null when nothing is payable yet", () => {
    expect(findPayableMilestone(bookingDoc())).toBeNull();
  });

  it("returns the milestone once its work is completed", () => {
    const booking = bookingDoc();
    booking.milestonePayments[1].workStatus = "completed";
    const payable = findPayableMilestone(booking);
    expect(payable?.title).toBe("Mid");
  });

  it("blocks later milestones while an earlier one is unpaid", () => {
    const booking = bookingDoc({
      milestonePayments: [
        { title: "First", amount: 100, order: 0, status: "pending", dueCondition: "on_start" },
        { title: "Second", amount: 200, order: 1, status: "pending", dueCondition: "on_milestone_completion", workStatus: "completed" },
      ],
    });
    expect(findPayableMilestone(booking)?.title).toBe("First");
  });

  it("honours custom due dates", () => {
    const booking = bookingDoc({
      milestonePayments: [
        { title: "Dated", amount: 100, order: 0, status: "pending", dueCondition: "custom_date", customDueDate: new Date("2026-10-29T00:00:00Z") },
      ],
    });
    expect(findPayableMilestone(booking, new Date("2026-10-28T00:00:00Z"))).toBeNull();
    expect(findPayableMilestone(booking, new Date("2026-10-30T00:00:00Z"))?.title).toBe("Dated");
  });
});

describe("notifyMilestonePaymentDue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentConfig.mockResolvedValue({ commissionPercent: 10 });
    mocks.notify.mockResolvedValue({ notificationId: "n1", emailSent: true, pushSent: false });
  });

  it("notifies the customer with a stable per-milestone dedupe key", async () => {
    const booking = bookingDoc();
    booking.milestonePayments[1].workStatus = "completed";
    mocks.findById.mockReturnValue({ select: vi.fn().mockResolvedValue(booking) });

    const result = await notifyMilestonePaymentDue("booking-1");
    expect(result).toMatchObject({ notified: true, order: 1 });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const args = mocks.notify.mock.calls[0][0];
    expect(args).toMatchObject({
      userId: "customer-1",
      eventKey: "customer.milestone_payment_due",
      idempotencyKey: "milestone-due:booking-1:1",
    });
    // Commission-inclusive charge: 200 * 1.1 = 220
    expect(args.context).toMatchObject({ milestoneTitle: "Mid", milestoneAmount: 220, currency: "EUR" });
  });

  it("also notifies the professional from the sweep, with its own dedupe key", async () => {
    const booking = bookingDoc();
    booking.milestonePayments[1].workStatus = "completed";
    mocks.findById.mockReturnValue({ select: vi.fn().mockResolvedValue(booking) });

    await notifyMilestonePaymentDue("booking-1", { notifyProfessional: true });
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    expect(mocks.notify.mock.calls[1][0]).toMatchObject({
      userId: "pro-1",
      eventKey: "professional.milestone_payment_due",
      idempotencyKey: "milestone-due-pro:booking-1:1",
    });
  });

  it("stays silent when no milestone is payable or the booking is not billable", async () => {
    mocks.findById.mockReturnValue({ select: vi.fn().mockResolvedValue(bookingDoc()) });
    expect(await notifyMilestonePaymentDue("booking-1")).toMatchObject({ notified: false });

    mocks.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue(bookingDoc({ status: "quoted" })),
    });
    expect(await notifyMilestonePaymentDue("booking-1")).toMatchObject({ notified: false });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
