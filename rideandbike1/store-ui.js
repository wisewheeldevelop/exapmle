(function(){
  "use strict";
  const catalog=window.RIDE_CATALOG||[];
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const esc=value=>String(value??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const rangeText=p=>p.range?`עד ${p.range} ק״מ*`:"לפי תנאי הרכיבה";
  const batteryText=p=>`${p.batteryV}V / ${p.batteryAh}Ah`;
  const money=n=>new Intl.NumberFormat("he-IL",{style:"currency",currency:"ILS",maximumFractionDigits:0}).format(n||0);

  function common(){
    $$('[data-year]').forEach(el=>el.textContent=new Date().getFullYear());
    $$('.mobile-nav nav a').forEach(link=>link.addEventListener('click',()=>{const d=link.closest('details');if(d)d.open=false;}));
    if(!$('link[href="commerce.css"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='commerce.css';document.head.appendChild(link)}
    if(!$('script[src="commerce.js"]')){const script=document.createElement('script');script.src='commerce.js';document.body.appendChild(script)}
  }

  function card(p){
    return `<article class="product-card" data-id="${esc(p.id)}">
      <div class="card-visual"><span class="card-badge">${esc(p.badge)}</span><img src="${esc(p.image)}" alt="המחשת ${p.type==='bike'?'אופניים חשמליים':'קורקינט חשמלי'} בסטודיו RIDE AND BIKE" loading="lazy"><span class="card-art-note">המחשת קטגוריה</span></div>
      <div class="card-body"><span class="card-brand">${esc(p.brand)}</span><h2 class="card-title">${esc(p.name)}</h2><p class="card-subtitle">${esc(p.subtitle)}</p>
      <div class="spec-row"><div class="mini-spec"><strong>${esc(p.batteryV)}V</strong><span>מתח</span></div><div class="mini-spec"><strong>${p.range?esc(p.range)+' ק״מ':'משתנה'}</strong><span>טווח יצרן</span></div><div class="mini-spec"><strong>${esc(p.wheel)}</strong><span>גלגל</span></div></div>
      ${p.price?`<div class="product-price"><strong>${money(p.price)}</strong>${p.oldPrice?`<del>${money(p.oldPrice)}</del>`:""}</div>`:`<div class="product-price"><strong style="font-size:18px">מחיר ומלאי באישור</strong></div>`}
      <div class="card-actions"><a class="card-link" href="product.html?id=${encodeURIComponent(p.id)}">לפרטים</a>${p.price&&p.stock!==false?`<button class="add-cart-btn" type="button" data-add-cart="${esc(p.id)}">הוספה לסל</button>`:`<button class="add-cart-btn" type="button" disabled>${p.stock===false?"בדיקת מלאי":"בירור מחיר"}</button>`}<button class="compare-btn" type="button" data-compare="${esc(p.id)}" aria-label="הוספת ${esc(p.name)} להשוואה" aria-pressed="false">＋</button></div></div>
    </article>`;
  }

  function initCatalog(){
    const type=document.body.dataset.catalog;
    if(!type) return;
    const products=catalog.filter(p=>p.type===type), grid=$('#productGrid'), form=$('#catalogFilters'), count=$('#resultCount');
    const selected=new Set();
    const brand=$('#brandFilter');
    [...new Set(products.map(p=>p.brand))].sort().forEach(name=>brand.insertAdjacentHTML('beforeend',`<option value="${esc(name)}">${esc(name)}</option>`));

    function values(){return {q:$('#searchFilter').value.trim().toLowerCase(),brand:brand.value,voltage:$('#voltageFilter').value,use:$('#useFilter').value,suspension:$('#suspensionFilter').value,folding:$('#foldingFilter').checked,sort:$('#sortFilter').value};}
    function filtered(){
      const f=values(); let list=products.filter(p=>(!f.q||[p.name,p.brand,p.subtitle,...p.use].join(' ').toLowerCase().includes(f.q))&&(!f.brand||p.brand===f.brand)&&(!f.voltage||String(p.batteryV)===f.voltage)&&(!f.use||p.use.includes(f.use))&&(!f.suspension||p.suspension===f.suspension)&&(!f.folding||p.folding));
      if(f.sort==='range')list.sort((a,b)=>(b.range||0)-(a.range||0));
      if(f.sort==='battery')list.sort((a,b)=>(b.batteryV*b.batteryAh)-(a.batteryV*a.batteryAh));
      if(f.sort==='light')list.sort((a,b)=>(parseFloat(a.weight)||999)-(parseFloat(b.weight)||999));
      return list;
    }
    function render(){
      const list=filtered();count.textContent=`${list.length} מתוך ${products.length} דגמים`;
      grid.innerHTML=list.length?list.map(card).join(''):`<div class="no-results"><strong>לא מצאנו התאמה מדויקת</strong><p>נסו לנקות פילטר אחד או להגיע להתאמה אישית בחנות.</p></div>`;
      $$('[data-compare]',grid).forEach(btn=>{const id=btn.dataset.compare;btn.classList.toggle('active',selected.has(id));btn.setAttribute('aria-pressed',String(selected.has(id)));btn.textContent=selected.has(id)?'✓':'＋';btn.addEventListener('click',()=>toggleCompare(id));});
    }
    function toggleCompare(id){
      if(selected.has(id))selected.delete(id);else if(selected.size<3)selected.add(id);else{const first=selected.values().next().value;selected.delete(first);selected.add(id)}
      updateCompare();render();
    }
    function updateCompare(){
      const bar=$('#compareBar');bar.classList.toggle('show',selected.size>0);$('#compareCount').textContent=selected.size;
    }
    function compareTable(){
      const items=[...selected].map(id=>catalog.find(p=>p.id===id)).filter(Boolean);
      const rows=[['מותג',p=>p.brand],['סוללה',batteryText],['טווח מוצהר',rangeText],['גלגל',p=>p.wheel],['שיכוך',p=>p.suspension],['בלמים',p=>p.brakes],['משקל',p=>p.weight],['קיפול',p=>p.folding?'כן':'לא']];
      $('#compareContent').innerHTML=`<table class="compare-table"><thead><tr><th>מאפיין</th>${items.map(p=>`<td>${esc(p.name)}</td>`).join('')}</tr></thead><tbody>${rows.map(([label,get])=>`<tr><th>${label}</th>${items.map(p=>`<td>${esc(get(p))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    form.addEventListener('input',render);form.addEventListener('change',render);
    $('#resetFilters').addEventListener('click',()=>{form.reset();render();});
    $('#openFilters').addEventListener('click',()=>document.body.classList.add('filters-open'));
    $('#closeFilters').addEventListener('click',()=>document.body.classList.remove('filters-open'));
    $('#filterBackdrop').addEventListener('click',()=>document.body.classList.remove('filters-open'));
    $('#openCompare').addEventListener('click',()=>{compareTable();$('#compareDialog').showModal();});
    $('#closeCompare').addEventListener('click',()=>$('#compareDialog').close());
    document.addEventListener('keydown',e=>{if(e.key==='Escape')document.body.classList.remove('filters-open');});
    render();
  }

  function initProduct(){
    if(!document.body.classList.contains('product-page-body'))return;
    const id=new URLSearchParams(location.search).get('id');const p=catalog.find(x=>x.id===id)||catalog[0];
    if(!p)return;
    document.title=`${p.name} · RIDE AND BIKE`;
    $('#detailBack').href=p.type==='bike'?'electric-bikes.html':'electric-scooters.html';$('#detailBack').textContent=p.type==='bike'?'אופניים חשמליים':'קורקינטים חשמליים';
    $('#detailImage').src=p.image;$('#detailImage').alt=`המחשת ${p.name}`;$('#detailBrand').textContent=p.brand;$('#detailName').textContent=p.name;$('#detailLead').textContent=p.subtitle;
    $('#detailBadges').innerHTML=[p.badge,...p.use].map(x=>`<span>${esc(x)}</span>`).join('');
    const specs=[['סוללה',batteryText(p)],['טווח מוצהר',rangeText(p)],['גלגל',p.wheel],['שיכוך',p.suspension],['בלמים',p.brakes],['משקל',p.weight],['קיפול',p.folding?'כן':'לא'],['אופי שימוש',p.use.join(' · ')]];
    $('#detailSpecs').innerHTML=specs.map(([a,b])=>`<div class="detail-spec"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join('');
    $('#detailFit').textContent=p.fit;$('#detailHighlights').innerHTML=p.highlights.map(x=>`<li>${esc(x)}</li>`).join('');
    $('#detailSource').href=p.source;
    const price=$('#detailPrice'),old=$('#detailOldPrice'),buy=$('#detailAddCart');
    if(price)price.textContent=p.price?money(p.price):"מחיר באישור";
    if(old){old.textContent=p.oldPrice?money(p.oldPrice):"";old.hidden=!p.oldPrice;}
    if(buy){buy.dataset.addCart=p.id;buy.disabled=!p.price||p.stock===false;buy.textContent=p.stock===false?"בדיקת מלאי":"הוספה לסל";}
  }
  common();initCatalog();initProduct();
})();
