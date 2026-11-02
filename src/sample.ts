export const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Price simulator</title>
<style>
body{font-family:system-ui,sans-serif;background:#f5f7fb;color:#162338;margin:0;padding:40px}
main{max-width:680px;margin:auto;background:white;border-radius:20px;padding:36px;border:1px solid #e1e7ee}
h1{font-size:28px;letter-spacing:-1px}p,label{color:#64748b}input{width:100%;accent-color:#147d73;margin:24px 0}
.row{display:flex;justify-content:space-between;gap:24px}.card{background:#edf7f4;padding:24px;border-radius:12px;flex:1}
strong{display:block;color:#12695f;font-size:30px;margin-top:8px}small{display:block;margin-top:28px;color:#64748b}
</style></head>
<body><main>
<p>SCENARIO PLANNING / DEMO</p><h1>Find your pricing sweet spot.</h1>
<p>Explore how price could affect monthly revenue.</p>
<label for="price">Monthly price: <b id="priceLabel">$50</b></label>
<input id="price" type="range" min="10" max="150" value="50">
<div class="row"><div class="card">Estimated customers<strong id="customers"></strong></div>
<div class="card">Monthly revenue<strong id="revenue"></strong></div></div>
<small>Synthetic example only. Assumption: customers = max(100, 2000 - 10 x price).
This is not a validated demand forecast.</small>
</main><script>
const price = document.getElementById("price");
function update() {
  const value = Number(price.value);
  const customers = Math.max(100, 2000 - 10 * value);
  document.getElementById("priceLabel").textContent = "$" + value;
  document.getElementById("customers").textContent = customers.toLocaleString();
  document.getElementById("revenue").textContent = "$" + (value * customers).toLocaleString();
}
price.addEventListener("input", update);
update();
</script></body></html>
`;
