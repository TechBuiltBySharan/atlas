import {
  type AtlasStore,
  type Workspace,
  createId,
} from "@atlas/core";
import type {
  RazorpayInvoice,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayPaymentLink,
  RazorpayPlan,
  RazorpayRefund,
  RazorpaySettlement,
  RazorpaySubscription,
  RazorpaySubscriptionStatus,
  RazorpaySubscriptionWebhookEvent,
} from "./types.js";

function epoch(ws: Workspace, store: AtlasStore): number {
  return Math.floor(store.now(ws) / 1000);
}

export class RazorpayService {
  constructor(private store: AtlasStore) {}

  createOrder(
    ws: Workspace,
    input: {
      amount: number;
      currency?: string;
      receipt?: string;
      notes?: Record<string, string>;
    },
  ): RazorpayOrder {
    const id = createId("order", this.store.nextCounter(ws, "rzp_order"));
    const order: RazorpayOrder = {
      id,
      entity: "order",
      amount: input.amount,
      amount_paid: 0,
      amount_due: input.amount,
      currency: input.currency ?? "INR",
      receipt: input.receipt ?? null,
      status: "created",
      attempts: 0,
      notes: input.notes ?? {},
      created_at: epoch(ws, this.store),
    };
    this.store.setEntity(ws, "razorpay", "order", id, order);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: "order.created",
      entityKind: "order",
      entityId: id,
      data: { amount: order.amount },
    });
    return order;
  }

  getOrder(ws: Workspace, id: string): RazorpayOrder | undefined {
    return this.store.getEntity(ws, "razorpay", "order", id);
  }

  createPaymentLink(
    ws: Workspace,
    input: {
      amount: number;
      currency?: string;
      description?: string;
      customer?: Record<string, string>;
      notes?: Record<string, string>;
    },
  ): RazorpayPaymentLink {
    const n = this.store.nextCounter(ws, "rzp_plink");
    const id = `plink_${n.toString(36).padStart(10, "0")}`;
    const now = epoch(ws, this.store);
    const link: RazorpayPaymentLink = {
      id,
      entity: "payment_link",
      amount: input.amount,
      currency: input.currency ?? "INR",
      accept_partial: false,
      status: "created",
      description: input.description ?? null,
      customer: input.customer ?? {},
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: input.notes ?? {},
      short_url: `https://rzp.io/atlas/${id}`,
      created_at: now,
      updated_at: now,
    };
    this.store.setEntity(ws, "razorpay", "payment_link", id, link);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: "payment_link.created",
      entityKind: "payment_link",
      entityId: id,
    });
    return link;
  }

  getPaymentLink(ws: Workspace, id: string): RazorpayPaymentLink | undefined {
    return this.store.getEntity(ws, "razorpay", "payment_link", id);
  }

  listPayments(ws: Workspace, paymentLinkId?: string): RazorpayPayment[] {
    const all = this.store.listEntities<RazorpayPayment>(ws, "razorpay", "payment");
    if (!paymentLinkId) return all;
    return all.filter((p) => p.notes?.payment_link_id === paymentLinkId);
  }

  /**
   * Attempt a payment against an order or payment link.
   * Honors fail_next failure rules.
   */
  attemptPayment(
    ws: Workspace,
    input: {
      amount: number;
      currency?: string;
      order_id?: string;
      payment_link_id?: string;
      method?: string;
      email?: string;
      contact?: string;
      notes?: Record<string, string>;
      capture?: boolean;
    },
  ): RazorpayPayment {
    const fail = this.store.consumeFailureRule(ws, "razorpay.payment.fail_next");
    const id = createId("pay", this.store.nextCounter(ws, "rzp_payment"));
    const notes = {
      ...(input.notes ?? {}),
      ...(input.payment_link_id ? { payment_link_id: input.payment_link_id } : {}),
    };

    if (input.order_id) {
      const order = this.getOrder(ws, input.order_id);
      if (!order) throw Object.assign(new Error("Order not found"), { status: 400 });
      order.attempts += 1;
      order.status = "attempted";
      this.store.setEntity(ws, "razorpay", "order", order.id, order);
    }

    if (fail) {
      const payment: RazorpayPayment = {
        id,
        entity: "payment",
        amount: input.amount,
        currency: input.currency ?? "INR",
        status: "failed",
        order_id: input.order_id ?? null,
        invoice_id: null,
        subscription_id: null,
        international: false,
        method: input.method ?? "card",
        amount_refunded: 0,
        refund_status: null,
        captured: false,
        description: null,
        email: input.email ?? null,
        contact: input.contact ?? null,
        notes,
        error_code: "BAD_REQUEST_ERROR",
        error_description: fail.reason ?? "Payment failed by Atlas failure rule",
        created_at: epoch(ws, this.store),
      };
      this.store.setEntity(ws, "razorpay", "payment", id, payment);
      this.store.appendEvent(ws, {
        provider: "razorpay",
        type: "payment.failed",
        entityKind: "payment",
        entityId: id,
      });
      this.emitPaymentWebhook(ws, "payment.failed", payment);
      return payment;
    }

    const shouldCapture = input.capture !== false;
    const payment: RazorpayPayment = {
      id,
      entity: "payment",
      amount: input.amount,
      currency: input.currency ?? "INR",
      status: shouldCapture ? "captured" : "authorized",
      order_id: input.order_id ?? null,
      invoice_id: null,
      subscription_id: null,
      international: false,
      method: input.method ?? "card",
      amount_refunded: 0,
      refund_status: null,
      captured: shouldCapture,
      description: null,
      email: input.email ?? null,
      contact: input.contact ?? null,
      notes,
      error_code: null,
      error_description: null,
      created_at: epoch(ws, this.store),
    };
    this.store.setEntity(ws, "razorpay", "payment", id, payment);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: shouldCapture ? "payment.captured" : "payment.authorized",
      entityKind: "payment",
      entityId: id,
    });

    if (!shouldCapture) {
      this.emitPaymentWebhook(ws, "payment.authorized", payment);
      return payment;
    }

    this.finalizeCapture(ws, payment, input.payment_link_id);
    return payment;
  }

  capturePayment(ws: Workspace, paymentId: string, amount?: number): RazorpayPayment {
    const payment = this.store.getEntity<RazorpayPayment>(ws, "razorpay", "payment", paymentId);
    if (!payment) throw Object.assign(new Error("Payment not found"), { status: 400 });
    if (payment.status === "captured") return payment;
    if (payment.status === "failed" || payment.status === "refunded") {
      throw Object.assign(new Error(`Cannot capture payment in status ${payment.status}`), {
        status: 400,
      });
    }
    if (amount !== undefined && amount !== payment.amount) {
      throw Object.assign(new Error("Capture amount mismatch"), { status: 400 });
    }
    payment.status = "captured";
    payment.captured = true;
    this.store.setEntity(ws, "razorpay", "payment", payment.id, payment);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: "payment.captured",
      entityKind: "payment",
      entityId: payment.id,
    });
    this.finalizeCapture(ws, payment, payment.notes.payment_link_id);
    return payment;
  }

  private finalizeCapture(
    ws: Workspace,
    payment: RazorpayPayment,
    paymentLinkId?: string,
  ): void {
    this.emitPaymentWebhook(ws, "payment.captured", payment);

    if (payment.order_id) {
      const order = this.getOrder(ws, payment.order_id);
      if (order) {
        order.status = "paid";
        order.amount_paid = payment.amount;
        order.amount_due = Math.max(0, order.amount - payment.amount);
        this.store.setEntity(ws, "razorpay", "order", order.id, order);
        this.store.appendEvent(ws, {
          provider: "razorpay",
          type: "order.paid",
          entityKind: "order",
          entityId: order.id,
        });
        this.store.scheduleWebhook(ws, "razorpay", "order.paid", {
          entity: "event",
          account_id: "acc_atlas",
          event: "order.paid",
          contains: ["payment", "order"],
          payload: {
            payment: { entity: payment },
            order: { entity: order },
          },
          created_at: epoch(ws, this.store),
        });
      }
    }

    const linkId = paymentLinkId ?? payment.notes.payment_link_id;
    if (linkId) {
      const link = this.getPaymentLink(ws, linkId);
      if (link) {
        link.status = "paid";
        link.updated_at = epoch(ws, this.store);
        this.store.setEntity(ws, "razorpay", "payment_link", link.id, link);
        this.store.scheduleWebhook(ws, "razorpay", "payment_link.paid", {
          entity: "event",
          account_id: "acc_atlas",
          event: "payment_link.paid",
          contains: ["payment", "payment_link"],
          payload: {
            payment: { entity: payment },
            payment_link: { entity: link },
          },
          created_at: epoch(ws, this.store),
        });
      }
    }
  }

  private emitPaymentWebhook(ws: Workspace, event: string, payment: RazorpayPayment): void {
    this.store.scheduleWebhook(ws, "razorpay", event, {
      entity: "event",
      account_id: "acc_atlas",
      event,
      contains: ["payment"],
      payload: { payment: { entity: payment } },
      created_at: epoch(ws, this.store),
    });
  }

  refundPayment(
    ws: Workspace,
    paymentId: string,
    input?: { amount?: number; notes?: Record<string, string>; receipt?: string },
  ): RazorpayRefund {
    const payment = this.store.getEntity<RazorpayPayment>(ws, "razorpay", "payment", paymentId);
    if (!payment) throw Object.assign(new Error("Payment not found"), { status: 400 });
    if (payment.status !== "captured" && payment.status !== "refunded") {
      throw Object.assign(new Error("Payment is not captured"), { status: 400 });
    }
    const amount = input?.amount ?? payment.amount - payment.amount_refunded;
    if (amount <= 0 || amount > payment.amount - payment.amount_refunded) {
      throw Object.assign(new Error("Invalid refund amount"), { status: 400 });
    }

    const id = createId("rfnd", this.store.nextCounter(ws, "rzp_refund"));
    const refund: RazorpayRefund = {
      id,
      entity: "refund",
      amount,
      currency: payment.currency,
      payment_id: payment.id,
      notes: input?.notes ?? {},
      receipt: input?.receipt ?? null,
      status: "processed",
      created_at: epoch(ws, this.store),
    };
    payment.amount_refunded += amount;
    payment.refund_status = payment.amount_refunded >= payment.amount ? "full" : "partial";
    if (payment.amount_refunded >= payment.amount) payment.status = "refunded";
    this.store.setEntity(ws, "razorpay", "payment", payment.id, payment);
    this.store.setEntity(ws, "razorpay", "refund", id, refund);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: "refund.processed",
      entityKind: "refund",
      entityId: id,
    });
    this.store.scheduleWebhook(ws, "razorpay", "refund.processed", {
      entity: "event",
      account_id: "acc_atlas",
      event: "refund.processed",
      contains: ["refund", "payment"],
      payload: {
        refund: { entity: refund },
        payment: { entity: payment },
      },
      created_at: epoch(ws, this.store),
    });
    return refund;
  }

  getPayment(ws: Workspace, id: string): RazorpayPayment | undefined {
    return this.store.getEntity(ws, "razorpay", "payment", id);
  }

  listRefunds(ws: Workspace, paymentId: string): RazorpayRefund[] {
    return this.store
      .listEntities<RazorpayRefund>(ws, "razorpay", "refund")
      .filter((r) => r.payment_id === paymentId);
  }

  payPaymentLink(ws: Workspace, paymentLinkId: string): RazorpayPayment {
    const link = this.getPaymentLink(ws, paymentLinkId);
    if (!link) throw Object.assign(new Error("Payment link not found"), { status: 400 });
    if (link.status === "paid") {
      const existing = this.listPayments(ws, paymentLinkId).find((p) => p.status === "captured");
      if (existing) return existing;
    }
    return this.attemptPayment(ws, {
      amount: link.amount,
      currency: link.currency,
      payment_link_id: link.id,
      notes: link.notes,
      capture: true,
    });
  }

  createPlan(
    ws: Workspace,
    input: {
      period: string;
      interval: number;
      item: { name: string; amount?: number; unit_amount?: number; currency?: string; description?: string };
      notes?: Record<string, string>;
    },
  ): RazorpayPlan {
    const amount = input.item.amount ?? input.item.unit_amount ?? 0;
    const id = createId("plan", this.store.nextCounter(ws, "rzp_plan"));
    const plan: RazorpayPlan = {
      id,
      entity: "plan",
      interval: input.interval,
      period: input.period,
      item: {
        id: createId("item", this.store.nextCounter(ws, "rzp_item")),
        name: input.item.name,
        amount,
        unit_amount: amount,
        currency: input.item.currency ?? "INR",
        description: input.item.description ?? input.item.name,
      },
      notes: input.notes ?? {},
      created_at: epoch(ws, this.store),
    };
    this.store.setEntity(ws, "razorpay", "plan", id, plan);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: "plan.created",
      entityKind: "plan",
      entityId: id,
    });
    return plan;
  }

  getPlan(ws: Workspace, id: string): RazorpayPlan | undefined {
    return this.store.getEntity(ws, "razorpay", "plan", id);
  }

  createSubscription(
    ws: Workspace,
    input: {
      plan_id: string;
      total_count: number;
      quantity?: number;
      notes?: Record<string, string>;
      customer_notify?: number;
    },
  ): RazorpaySubscription {
    const plan = this.getPlan(ws, input.plan_id);
    if (!plan) throw Object.assign(new Error("Plan not found"), { status: 400 });
    const n = this.store.nextCounter(ws, "rzp_sub");
    const id = `sub_${n.toString(36).padStart(10, "0")}`;
    const now = epoch(ws, this.store);
    const sub: RazorpaySubscription = {
      id,
      entity: "subscription",
      plan_id: plan.id,
      status: "created",
      current_start: null,
      current_end: null,
      ended_at: null,
      quantity: input.quantity ?? 1,
      total_count: input.total_count,
      paid_count: 0,
      charge_at: now,
      short_url: `https://rzp.io/atlas/sub/${id}`,
      notes: input.notes ?? {},
      created_at: now,
    };
    this.store.setEntity(ws, "razorpay", "subscription", id, sub);
    // Atlas-internal only — not a Razorpay provider webhook
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: "subscription.created",
      entityKind: "subscription",
      entityId: id,
    });
    // Auto-authenticate + activate (mandate success) for sim convenience
    this.setSubscriptionStatus(ws, id, "authenticated");
    this.setSubscriptionStatus(ws, id, "active");
    return this.getSubscription(ws, id)!;
  }

  getSubscription(ws: Workspace, id: string): RazorpaySubscription | undefined {
    return this.store.getEntity(ws, "razorpay", "subscription", id);
  }

  private emitSubscriptionWebhook(
    ws: Workspace,
    event: RazorpaySubscriptionWebhookEvent,
    sub: RazorpaySubscription,
    extra?: { payment?: RazorpayPayment },
  ): void {
    const now = epoch(ws, this.store);
    this.store.appendEvent(ws, {
      provider: "razorpay",
      type: event,
      entityKind: "subscription",
      entityId: sub.id,
    });
    const contains = ["subscription"];
    const payload: Record<string, unknown> = {
      subscription: { entity: sub },
    };
    if (extra?.payment) {
      contains.push("payment");
      payload.payment = { entity: extra.payment };
    }
    this.store.scheduleWebhook(ws, "razorpay", event, {
      entity: "event",
      account_id: "acc_atlas",
      event,
      contains,
      payload,
      created_at: now,
    });
  }

  private webhookEventForStatus(
    next: RazorpaySubscriptionStatus,
    prev: RazorpaySubscriptionStatus,
  ): RazorpaySubscriptionWebhookEvent | null {
    if (next === "created") return null; // internal only
    if (next === "authenticated") return "subscription.authenticated";
    if (next === "active") {
      return prev === "paused" ? "subscription.resumed" : "subscription.activated";
    }
    if (next === "pending") return "subscription.pending";
    if (next === "halted") return "subscription.halted";
    if (next === "paused") return "subscription.paused";
    if (next === "cancelled") return "subscription.cancelled";
    if (next === "completed") return "subscription.completed";
    return null;
  }

  setSubscriptionStatus(
    ws: Workspace,
    subscriptionId: string,
    status: RazorpaySubscriptionStatus,
  ): RazorpaySubscription {
    const sub = this.getSubscription(ws, subscriptionId);
    if (!sub) throw Object.assign(new Error("Subscription not found"), { status: 400 });
    const prev = sub.status;
    const now = epoch(ws, this.store);
    sub.status = status;
    if (status === "active" || status === "authenticated" || status === "paused") {
      if (status !== "paused") {
        sub.current_start = now;
        sub.current_end = now + 30 * 24 * 60 * 60;
      }
      sub.ended_at = null;
    }
    if (status === "cancelled" || status === "completed" || status === "halted") {
      sub.ended_at = now;
    }
    this.store.setEntity(ws, "razorpay", "subscription", sub.id, sub);
    const event = this.webhookEventForStatus(status, prev);
    if (event) this.emitSubscriptionWebhook(ws, event, sub);
    else if (status === "created") {
      this.store.appendEvent(ws, {
        provider: "razorpay",
        type: "subscription.created",
        entityKind: "subscription",
        entityId: sub.id,
      });
    }
    return sub;
  }

  pauseSubscription(ws: Workspace, subscriptionId: string): RazorpaySubscription {
    const sub = this.getSubscription(ws, subscriptionId);
    if (!sub) throw Object.assign(new Error("Subscription not found"), { status: 400 });
    if (sub.status !== "active" && sub.status !== "authenticated") {
      throw Object.assign(new Error(`Cannot pause subscription in status ${sub.status}`), {
        status: 400,
      });
    }
    return this.setSubscriptionStatus(ws, subscriptionId, "paused");
  }

  resumeSubscription(ws: Workspace, subscriptionId: string): RazorpaySubscription {
    const sub = this.getSubscription(ws, subscriptionId);
    if (!sub) throw Object.assign(new Error("Subscription not found"), { status: 400 });
    if (sub.status !== "paused") {
      throw Object.assign(new Error(`Cannot resume subscription in status ${sub.status}`), {
        status: 400,
      });
    }
    return this.setSubscriptionStatus(ws, subscriptionId, "active");
  }

  updateSubscription(
    ws: Workspace,
    subscriptionId: string,
    patch: { quantity?: number; notes?: Record<string, string>; total_count?: number },
  ): RazorpaySubscription {
    const sub = this.getSubscription(ws, subscriptionId);
    if (!sub) throw Object.assign(new Error("Subscription not found"), { status: 400 });
    if (patch.quantity !== undefined) sub.quantity = patch.quantity;
    if (patch.total_count !== undefined) sub.total_count = patch.total_count;
    if (patch.notes !== undefined) sub.notes = { ...sub.notes, ...patch.notes };
    this.store.setEntity(ws, "razorpay", "subscription", sub.id, sub);
    this.emitSubscriptionWebhook(ws, "subscription.updated", sub);
    return sub;
  }

  chargeSubscription(ws: Workspace, subscriptionId: string): {
    subscription: RazorpaySubscription;
    payment: RazorpayPayment;
    invoice: RazorpayInvoice;
  } {
    const sub = this.getSubscription(ws, subscriptionId);
    if (!sub) throw Object.assign(new Error("Subscription not found"), { status: 400 });
    const plan = this.getPlan(ws, sub.plan_id);
    if (!plan) throw Object.assign(new Error("Plan not found"), { status: 400 });

    if (sub.status === "paused") {
      throw Object.assign(new Error("Cannot charge a paused subscription"), { status: 400 });
    }
    if (sub.status === "cancelled" || sub.status === "completed" || sub.status === "halted") {
      throw Object.assign(new Error(`Cannot charge subscription in status ${sub.status}`), {
        status: 400,
      });
    }

    if (sub.status === "pending") {
      this.setSubscriptionStatus(ws, sub.id, "halted");
      throw Object.assign(new Error("Subscription halted after failed charge"), { status: 400 });
    }

    const fail = this.store.consumeFailureRule(ws, "razorpay.payment.fail_next");
    if (fail) {
      this.setSubscriptionStatus(ws, sub.id, "pending");
      throw Object.assign(new Error(fail.reason ?? "Subscription charge failed"), { status: 400 });
    }

    const paymentId = createId("pay", this.store.nextCounter(ws, "rzp_payment"));
    const invoiceId = createId("inv", this.store.nextCounter(ws, "rzp_invoice"));
    const now = epoch(ws, this.store);
    const payment: RazorpayPayment = {
      id: paymentId,
      entity: "payment",
      amount: plan.item.amount,
      currency: plan.item.currency,
      status: "captured",
      order_id: null,
      invoice_id: invoiceId,
      subscription_id: sub.id,
      international: false,
      method: "upi",
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      description: `Subscription charge ${sub.id}`,
      email: null,
      contact: null,
      notes: { ...sub.notes },
      error_code: null,
      error_description: null,
      created_at: now,
    };
    const invoice: RazorpayInvoice = {
      id: invoiceId,
      entity: "invoice",
      payment_id: paymentId,
      subscription_id: sub.id,
      amount: plan.item.amount,
      currency: plan.item.currency,
      status: "paid",
      short_url: `https://rzp.io/atlas/inv/${invoiceId}`,
      created_at: now,
    };
    sub.paid_count += 1;
    sub.status = "active";
    sub.current_start = now;
    sub.current_end = now + 30 * 24 * 60 * 60;
    this.store.setEntity(ws, "razorpay", "payment", paymentId, payment);
    this.store.setEntity(ws, "razorpay", "invoice", invoiceId, invoice);
    this.store.setEntity(ws, "razorpay", "subscription", sub.id, sub);
    this.emitSubscriptionWebhook(ws, "subscription.charged", sub, { payment });

    if (sub.paid_count >= sub.total_count) {
      this.setSubscriptionStatus(ws, sub.id, "completed");
    }

    return { subscription: this.getSubscription(ws, sub.id)!, payment, invoice };
  }

  cancelSubscription(
    ws: Workspace,
    subscriptionId: string,
    cancelAtCycleEnd = true,
  ): RazorpaySubscription {
    const sub = this.getSubscription(ws, subscriptionId);
    if (!sub) throw Object.assign(new Error("Subscription not found"), { status: 400 });
    void cancelAtCycleEnd;
    return this.setSubscriptionStatus(ws, subscriptionId, "cancelled");
  }

  getInvoice(ws: Workspace, id: string): RazorpayInvoice | undefined {
    return this.store.getEntity(ws, "razorpay", "invoice", id);
  }

  ensureInvoiceForPayment(ws: Workspace, payment: RazorpayPayment): RazorpayInvoice {
    if (payment.invoice_id) {
      const existing = this.getInvoice(ws, payment.invoice_id);
      if (existing) return existing;
    }
    const invoiceId = createId("inv", this.store.nextCounter(ws, "rzp_invoice"));
    const invoice: RazorpayInvoice = {
      id: invoiceId,
      entity: "invoice",
      payment_id: payment.id,
      subscription_id: payment.subscription_id,
      amount: payment.amount,
      currency: payment.currency,
      status: "paid",
      short_url: `https://rzp.io/atlas/inv/${invoiceId}`,
      created_at: epoch(ws, this.store),
    };
    payment.invoice_id = invoiceId;
    this.store.setEntity(ws, "razorpay", "payment", payment.id, payment);
    this.store.setEntity(ws, "razorpay", "invoice", invoiceId, invoice);
    return invoice;
  }

  listSettlements(ws: Workspace): RazorpaySettlement[] {
    let items = this.store.listEntities<RazorpaySettlement>(ws, "razorpay", "settlement");
    if (items.length === 0) {
      const now = epoch(ws, this.store);
      const seeded: RazorpaySettlement = {
        id: createId("setl", this.store.nextCounter(ws, "rzp_setl")),
        entity: "settlement",
        amount: 100000,
        status: "processed",
        fees: 2000,
        tax: 360,
        utr: `ATLASUTR${now}`,
        created_at: now,
      };
      this.store.setEntity(ws, "razorpay", "settlement", seeded.id, seeded);
      items = [seeded];
    }
    return items;
  }

  settlementsRecon(ws: Workspace): {
    entity: string;
    count: number;
    items: Array<{
      entity_id: string;
      type: string;
      debit: number;
      credit: number;
      amount: number;
      settled: boolean;
    }>;
  } {
    const payments = this.store
      .listEntities<RazorpayPayment>(ws, "razorpay", "payment")
      .filter((p) => p.status === "captured");
    const items = payments.map((p) => ({
      entity_id: p.id,
      type: "payment",
      debit: 0,
      credit: p.amount,
      amount: p.amount,
      settled: true,
    }));
    return { entity: "collection", count: items.length, items };
  }
}
