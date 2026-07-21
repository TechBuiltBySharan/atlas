/**
 * Minimal Razorpay checkout.js stand-in for local/Playwright.
 * Usage (consumer):
 *   <script src="http://127.0.0.1:4400/razorpay/checkout.js"></script>
 *   const rzp = new Razorpay({ key, order_id, amount, ... handler });
 *   rzp.open();
 */
export function checkoutJsSource(atlasOrigin: string): string {
  return `/* Atlas fake checkout.js — NOT Razorpay */
(function (global) {
  function Razorpay(options) {
    this.options = options || {};
  }
  Razorpay.prototype.open = function () {
    var opts = this.options;
    var key = opts.key;
    var orderId = opts.order_id;
    var amount = opts.amount;
    var handler = opts.handler || function () {};
    var modal = document.createElement('div');
    modal.setAttribute('data-atlas-checkout', '1');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,32,26,.55);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:system-ui,sans-serif';
    modal.innerHTML = '<div style="background:#eaf2eb;padding:28px 32px;border-radius:8px;max-width:360px;width:90%;box-shadow:0 20px 50px rgba(0,0,0,.25)">' +
      '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;margin-bottom:8px">Atlas Checkout</div>' +
      '<div style="font-size:22px;font-weight:700;color:#14201a;margin-bottom:6px">Pay ₹' + ((Number(amount)||0)/100).toFixed(2) + '</div>' +
      '<div style="font-size:13px;color:#2a3d33;margin-bottom:18px;word-break:break-all">Order ' + (orderId||'') + '</div>' +
      '<button id="atlas-pay" style="width:100%;padding:12px;background:#14201a;color:#eaf2eb;border:0;border-radius:4px;font-weight:600;cursor:pointer">Pay now</button>' +
      '<button id="atlas-cancel" style="width:100%;margin-top:8px;padding:10px;background:transparent;border:1px solid #2a3d33;border-radius:4px;cursor:pointer">Cancel</button>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('#atlas-cancel').onclick = function () {
      document.body.removeChild(modal);
      if (opts.modal && opts.modal.ondismiss) opts.modal.ondismiss();
    };
    modal.querySelector('#atlas-pay').onclick = async function () {
      var btn = modal.querySelector('#atlas-pay');
      btn.disabled = true;
      btn.textContent = 'Processing…';
      try {
        var res = await fetch(${JSON.stringify(atlasOrigin)} + '/razorpay/v1/checkout/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: key, order_id: orderId, amount: amount })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error && data.error.description || 'Payment failed');
        document.body.removeChild(modal);
        handler({
          razorpay_payment_id: data.razorpay_payment_id,
          razorpay_order_id: data.razorpay_order_id,
          razorpay_signature: data.razorpay_signature
        });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Pay now';
        alert(err.message || String(err));
      }
    };
  };
  global.Razorpay = Razorpay;
})(typeof window !== 'undefined' ? window : globalThis);
`;
}
