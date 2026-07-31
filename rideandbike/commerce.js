(function(){
  "use strict";
  if(window.RideCommerceBooted)return;
  window.RideCommerceBooted=true;
  const catalog=window.RIDE_CATALOG||[];
  const CART_KEY="ride_cart_v1", METHOD_KEY="ride_delivery_v1";
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const money=n=>new Intl.NumberFormat("he-IL",{style:"currency",currency:"ILS",maximumFractionDigits:0}).format(n||0);
  const product=id=>catalog.find(p=>p.id===id);
  let cart=[];
  try{cart=JSON.parse(localStorage.getItem(CART_KEY)||"[]").filter(x=>product(x.id)&&x.qty>0)}catch(_){cart=[]}
  let method=localStorage.getItem(METHOD_KEY)||"pickup";
  const save=()=>localStorage.setItem(CART_KEY,JSON.stringify(cart));
  const subtotal=()=>cart.reduce((sum,line)=>sum+(product(line.id)?.price||0)*line.qty,0);
  const shipping=()=>method==="delivery"&&subtotal()<2500?149:0;
  const count=()=>cart.reduce((sum,line)=>sum+line.qty,0);

    // One cart mark for the whole store; index.html inlines the same geometry.
  /* One place decides what the badge says and whether it is even there.
     An empty cart showing a "0" is noise; the badge scales away instead. */
  function syncCartBadge(total){
    $$(".cart-count").forEach(el=>{ el.textContent = total > 99 ? "99+" : String(total); });
    $$("[data-cart-trigger]").forEach(el=>{
      el.dataset.empty = total === 0 ? "true" : "false";
      el.setAttribute("aria-label", total === 0
        ? "סל הקניות ריק"
        : `סל הקניות, ${total} פריטים`);
    });
  }
  function cartIcon(){return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.9 3.9h1.02a1.62 1.62 0 0 1 1.58 1.27l.31 1.44"/><path d="M6.12 7.55h13.2a1.25 1.25 0 0 1 1.22 1.55l-1.1 4.45a2.3 2.3 0 0 1-2.23 1.75H9.72a2.3 2.3 0 0 1-2.24-1.79L6.12 7.55Z"/><circle cx="10.15" cy="19.25" r="1.42" fill="currentColor" stroke="none"/><circle cx="16.9" cy="19.25" r="1.42" fill="currentColor" stroke="none"/></svg>`}
  function ensureTriggers(){
    if(!$("[data-cart-trigger]")){
      const nav=$(".nav-inner");
      if(nav){const button=document.createElement("button");button.type="button";button.className="cart-trigger";button.dataset.cartTrigger="";button.innerHTML=`${cartIcon()}<span class="cart-label">הסל שלי</span><span class="cart-count">0</span>`;nav.insertBefore(button,$(".mobile-nav",nav));}
    }
  }
  function ensureDrawer(){
    if($("#cartDrawer"))return;
    document.body.insertAdjacentHTML("beforeend",`<div class="commerce-backdrop" id="cartBackdrop"></div><aside class="cart-drawer" id="cartDrawer" aria-hidden="true" aria-labelledby="cartTitle"><div class="cart-head"><h2 id="cartTitle">הסל שלכם</h2><button class="cart-close" type="button" data-cart-close aria-label="סגירת הסל">×</button></div><div class="cart-body" id="cartBody"></div><div class="delivery-choice"><h3>איך תרצו לקבל?</h3><div class="delivery-options"><label class="delivery-option"><input type="radio" name="cart-delivery" value="pickup"><span><strong>איסוף עצמי</strong><small>מרכז ראשון לציון · ללא עלות</small></span></label><label class="delivery-option"><input type="radio" name="cart-delivery" value="delivery"><span><strong>משלוח עד הבית</strong><small>חינם מעל ${money(2500)}</small></span></label></div></div><div class="cart-foot"><div class="cart-total"><span>סה״כ</span><strong id="cartTotal"></strong></div><p class="cart-shipping-note" id="cartShipping"></p><a class="checkout-link" id="checkoutLink" href="checkout.html">מעבר לפרטים ולתשלום</a></div></aside><div class="cart-toast" id="cartToast" role="status" aria-live="polite"></div>`);
    $$('[name="cart-delivery"]').forEach(r=>{r.checked=r.value===method;r.addEventListener("change",()=>{method=r.value;localStorage.setItem(METHOD_KEY,method);render()})});
  }
  function toast(text){const el=$("#cartToast");if(!el)return;el.textContent=text;el.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove("show"),2200)}
  function render(){
    syncCartBadge(count());
    const body=$("#cartBody");if(!body)return;
    body.innerHTML=cart.length?cart.map(line=>{const p=product(line.id);return `<div class="cart-line"><img src="${p.image}" alt=""><div><h3>${p.name}</h3><p>${money(p.price*line.qty)}</p><div class="qty-control"><button type="button" data-cart-qty="${p.id}" data-delta="1" aria-label="הוספת יחידה">+</button><span>${line.qty}</span><button type="button" data-cart-qty="${p.id}" data-delta="-1" aria-label="הפחתת יחידה">−</button></div></div><button class="cart-remove" type="button" data-cart-remove="${p.id}">הסרה</button></div>`}).join(""):`<div class="cart-empty"><strong>הסל עדיין ריק</strong><p>בחרו כלי מהדגמים המומלצים או מהקטלוג.</p></div>`;
    $("#cartTotal").textContent=money(subtotal()+shipping());
    $("#cartShipping").textContent=method==="pickup"?"איסוף עצמי ללא עלות":shipping()?`כולל משלוח ${money(shipping())}`:"משלוח חינם להזמנה זו";
    $("#checkoutLink").setAttribute("aria-disabled",String(!cart.length));
  }
  function openCart(){ensureDrawer();render();$("#cartDrawer").classList.add("open");$("#cartBackdrop").classList.add("open");$("#cartDrawer").setAttribute("aria-hidden","false");document.body.style.overflow="hidden";$(".cart-close").focus()}
  function closeCart(){if(!$("#cartDrawer"))return;$("#cartDrawer").classList.remove("open");$("#cartBackdrop").classList.remove("open");$("#cartDrawer").setAttribute("aria-hidden","true");document.body.style.overflow=""}
  function add(id){const p=product(id);if(!p||!p.price||p.stock===false)return;const line=cart.find(x=>x.id===id);if(line)line.qty+=1;else cart.push({id,qty:1});save();render();toast(`${p.name} נוסף לסל`)}
  function change(id,delta){const line=cart.find(x=>x.id===id);if(!line)return;line.qty+=delta;if(line.qty<=0)cart=cart.filter(x=>x.id!==id);save();render()}
  function initCheckout(){
    const root=$("#checkoutRoot");if(!root)return;
    if(!cart.length){root.innerHTML=`<div class="checkout-card checkout-confirmation show"><div class="check">🛒</div><h2>הסל ריק</h2><p>הוסיפו כלי מהקטלוג ואז חזרו לכאן.</p><a href="index.html#shop">חזרה לחנות</a></div>`;return}
    const refreshCheckout=()=>{
      $("#checkoutSummaryLines").innerHTML=cart.map(line=>{const p=product(line.id);return `<div class="checkout-summary-line"><span>${p.name} × ${line.qty}</span><strong>${money(p.price*line.qty)}</strong></div>`}).join("")+`<div class="checkout-summary-line"><span>${method==="pickup"?"איסוף עצמי":"משלוח"}</span><strong>${shipping()?money(shipping()):"ללא עלות"}</strong></div>`;
      $("#checkoutTotal").textContent=money(subtotal()+shipping());
      const address=$("#addressFields"),needsAddress=method==="delivery";
      address.hidden=!needsAddress;$$('#street,#city',address).forEach(input=>input.required=needsAddress);const floor=$('#floor',address);if(floor)floor.required=false;
      $$('[name="checkout-delivery"]').forEach(r=>r.checked=r.value===method);
      const payAtPickup=$('[name="payment"][value="pickup"]');if(payAtPickup){payAtPickup.disabled=needsAddress;if(needsAddress&&payAtPickup.checked)$('[name="payment"][value="secure"]').checked=true;}
    };
    $$('[name="checkout-delivery"]').forEach(r=>r.addEventListener("change",()=>{method=r.value;localStorage.setItem(METHOD_KEY,method);refreshCheckout()}));
    refreshCheckout();
    $("#checkoutForm").addEventListener("submit",e=>{e.preventDefault();if(!e.currentTarget.reportValidity())return;const order=`RB-${Date.now().toString().slice(-6)}`;cart=[];save();syncCartBadge(0);$("#checkoutFormWrap").hidden=true;$("#checkoutConfirmation").classList.add("show");$("#orderNumber").textContent=order;window.scrollTo({top:0,behavior:"smooth"})},{once:true});
  }
  ensureTriggers();ensureDrawer();render();initCheckout();
  document.addEventListener("click",e=>{const addBtn=e.target.closest("[data-add-cart]");if(addBtn){add(addBtn.dataset.addCart);return}if(e.target.closest("[data-cart-trigger]")){openCart();return}if(e.target.closest("[data-cart-close]")||e.target.id==="cartBackdrop"){closeCart();return}const qty=e.target.closest("[data-cart-qty]");if(qty){change(qty.dataset.cartQty,Number(qty.dataset.delta));return}const remove=e.target.closest("[data-cart-remove]");if(remove){cart=cart.filter(x=>x.id!==remove.dataset.cartRemove);save();render()}});
  document.addEventListener("keydown",e=>{if(e.key==="Escape")closeCart()});
  window.RideCommerce={add,openCart,cart:()=>cart.slice()};
})();
