export type RazorpayOrder = {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid";
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
};

export type RazorpayPayment = {
  id: string;
  entity: "payment";
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "failed" | "refunded";
  order_id: string | null;
  invoice_id: string | null;
  subscription_id: string | null;
  international: boolean;
  method: string;
  amount_refunded: number;
  refund_status: string | null;
  captured: boolean;
  description: string | null;
  email: string | null;
  contact: string | null;
  notes: Record<string, string>;
  error_code: string | null;
  error_description: string | null;
  created_at: number;
};

export type RazorpayPlan = {
  id: string;
  entity: "plan";
  interval: number;
  period: string;
  item: {
    id: string;
    name: string;
    amount: number;
    unit_amount: number;
    currency: string;
    description: string;
  };
  notes: Record<string, string>;
  created_at: number;
};

export type RazorpaySubscriptionStatus =
  | "created"
  | "authenticated"
  | "active"
  | "pending"
  | "halted"
  | "paused"
  | "cancelled"
  | "completed";

/** Provider webhook event names Sociatribe (and Razorpay) listen for. */
export type RazorpaySubscriptionWebhookEvent =
  | "subscription.authenticated"
  | "subscription.activated"
  | "subscription.charged"
  | "subscription.pending"
  | "subscription.halted"
  | "subscription.paused"
  | "subscription.resumed"
  | "subscription.updated"
  | "subscription.completed"
  | "subscription.cancelled";

export type RazorpaySubscription = {
  id: string;
  entity: "subscription";
  plan_id: string;
  status: RazorpaySubscriptionStatus;
  current_start: number | null;
  current_end: number | null;
  ended_at: number | null;
  quantity: number;
  total_count: number;
  paid_count: number;
  charge_at: number | null;
  short_url: string;
  notes: Record<string, string>;
  created_at: number;
};

export type RazorpayInvoice = {
  id: string;
  entity: "invoice";
  payment_id: string;
  subscription_id: string | null;
  amount: number;
  currency: string;
  status: "paid";
  short_url: string;
  created_at: number;
};

export type RazorpaySettlement = {
  id: string;
  entity: "settlement";
  amount: number;
  status: "processed";
  fees: number;
  tax: number;
  utr: string;
  created_at: number;
};

export type RazorpayRefund = {
  id: string;
  entity: "refund";
  amount: number;
  currency: string;
  payment_id: string;
  notes: Record<string, string>;
  receipt: string | null;
  status: "processed" | "failed";
  created_at: number;
};

export type RazorpayPaymentLink = {
  id: string;
  entity: "payment_link";
  amount: number;
  currency: string;
  accept_partial: boolean;
  status: "created" | "paid" | "expired" | "cancelled";
  description: string | null;
  customer: Record<string, string>;
  notify: Record<string, boolean>;
  reminder_enable: boolean;
  notes: Record<string, string>;
  short_url: string;
  created_at: number;
  updated_at: number;
};
