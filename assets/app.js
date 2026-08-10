/* Motore comune delle schermate ROPE.
   Legge dati/dati.json (scritto dal pannello di gestione) e tiene in memoria
   la taglia scelta e la prenotazione in corso. */
window.ROPE = (function(){
  let dati = null;

  const esc = t => String(t ?? "").replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function carica(){
    if(dati) return dati;
    const r = await fetch('dati/dati.json', {cache:'no-store'});
    if(!r.ok) throw new Error('dati non raggiungibili');
    dati = await r.json();
    dati.taglie = dati.taglie || [];
    dati.pacchetti = dati.pacchetti || [];
    dati.galleria = dati.galleria || [];
    return dati;
  }

  /* ---- taglia scelta ---- */
  function taglia(){
    const t = localStorage.getItem('rope-taglia');
    if(dati && !dati.taglie.some(x => x.id === t)) return dati.taglie[0]?.id || 's';
    return t || 's';
  }
  function impostaTaglia(id){ localStorage.setItem('rope-taglia', id); }
  function tagliaOggetto(){ return dati.taglie.find(t => t.id === taglia()) || null; }

  /* ---- prenotazione in corso ---- */
  function selezione(){
    try{ return JSON.parse(localStorage.getItem('rope-selezione')) || {}; }
    catch(e){ return {}; }
  }
  function salvaSelezione(s){ localStorage.setItem('rope-selezione', JSON.stringify(s)); }
  function aggiorna(campi){ const s = Object.assign(selezione(), campi); salvaSelezione(s); return s; }
  function azzera(){ localStorage.removeItem('rope-selezione'); }

  /* ---- invio della prenotazione a Supabase ----
     Se le chiavi non sono compilate, non fa niente e non blocca l'app:
     la prenotazione resta comunque nello storico locale. */
  function collegato(){
    const c = window.ROPE_CONFIG || {};
    return !!(c.URL && c.CHIAVE_PUBBLICA);
  }

  async function inviaPrenotazione(s){
    if(!collegato()) return {inviata:false, motivo:'non collegato'};
    const c = window.ROPE_CONFIG;
    const t = s.pacchettoId ? trovaLivello(s.pacchettoId, s.livelloId) : null;
    const riga = {
      codice: s.codice || null,
      cliente_nome: (s.cliente||{}).nome || null,
      cliente_tel:  (s.cliente||{}).telefono || null,
      pacchetto: t ? t.pacchetto.nome : null,
      pacchetto_id: s.pacchettoId || null,
      servizio: t ? (t.livello.titolo || t.livello.nome) : null,
      livello_id: s.livelloId || null,
      taglia: s.taglia || null,
      extra: (s.extra||[]).map(e => {
        const x = trovaExtra(e.pacchettoId || s.pacchettoId, e.id);
        return {id:e.id, nome: x ? x.nome : e.id};
      }),
      totale: totale(s).testo,
      data_app: s.dataISO || null,
      ora: s.ora || null,
      auto: s.auto || {},
      note: s.note || null,
      pagamento: s.pagamento || null
    };
    const r = await fetch(c.URL.replace(/\/$/,'') + '/rest/v1/prenotazioni', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'apikey': c.CHIAVE_PUBBLICA,
        'Authorization': 'Bearer ' + c.CHIAVE_PUBBLICA,
        'Prefer':'return=minimal'
      },
      body: JSON.stringify(riga)
    });
    if(!r.ok) throw new Error('invio non riuscito (' + r.status + ')');
    return {inviata:true};
  }

  /* ---- storico prenotazioni (per ora solo su questo telefono) ---- */
  function storico(){
    try{ return JSON.parse(localStorage.getItem('rope-storico')) || []; }
    catch(e){ return []; }
  }
  function aggiungiAStorico(voce){
    const s = storico();
    s.unshift(Object.assign({salvataIl: new Date().toISOString()}, voce));
    localStorage.setItem('rope-storico', JSON.stringify(s.slice(0,50)));
  }
  /* Elenco delle auto usate, senza doppioni (più recente per prima). */
  function mieAuto(){
    const viste = new Map();
    storico().forEach(v => {
      const a = v.auto || {};
      const chiave = (a.targa || (a.marca||'') + (a.modello||'')).toUpperCase();
      if(chiave && !viste.has(chiave)) viste.set(chiave, {auto:a, ultimo:v});
    });
    return [...viste.values()];
  }

  /* ---- ricerche ---- */
  function trovaLivello(pacchettoId, livelloId){
    const p = dati.pacchetti.find(x => x.id === pacchettoId);
    if(!p) return null;
    const l = (p.livelli||[]).find(x => x.id === livelloId);
    return l ? {pacchetto:p, livello:l} : null;
  }
  function trovaExtra(pacchettoId, extraId){
    const p = dati.pacchetti.find(x => x.id === pacchettoId);
    return p ? (p.extra||[]).find(x => x.id === extraId) || null : null;
  }

  /* ---- prezzi ---- */
  function prezzoDi(voce, idTaglia){
    if(!voce) return null;
    if(voce.suRichiesta) return 'richiesta';
    const p = voce.prezzi ? voce.prezzi[idTaglia || taglia()] : null;
    return (p === null || p === undefined || p === "") ? null : p;
  }
  function testoPrezzo(voce, idTaglia){
    const p = prezzoDi(voce, idTaglia);
    if(p === 'richiesta') return 'Su richiesta';
    return p === null ? '—' : '€' + p;
  }
  function euro(n){ return '€' + n; }

  /* Totale della selezione: livello + extra scelti. */
  function totale(sel){
    const s = sel || selezione();
    const t = s.taglia || taglia();
    let somma = 0, suRichiesta = false;
    const trovato = s.pacchettoId && s.livelloId ? trovaLivello(s.pacchettoId, s.livelloId) : null;
    if(trovato){
      const p = prezzoDi(trovato.livello, t);
      if(p === 'richiesta' || p === null) suRichiesta = true; else somma += p;
    }
    (s.extra||[]).forEach(e => {
      const x = trovaExtra(e.pacchettoId || s.pacchettoId, e.id || e);
      const p = prezzoDi(x, t);
      if(p === 'richiesta' || p === null) suRichiesta = true; else somma += p;
    });
    return {somma, suRichiesta, testo: suRichiesta ? 'Su richiesta' : euro(somma)};
  }

  /* ---- pezzi di interfaccia riusabili ---- */
  function disegnaChipsTaglia(contenitore, alCambio){
    const c = typeof contenitore === 'string' ? document.querySelector(contenitore) : contenitore;
    function ridisegna(){
      c.innerHTML = "";
      dati.taglie.forEach(t => {
        const b = document.createElement('button');
        b.className = 'chip'; b.type = 'button';
        b.setAttribute('aria-pressed', t.id === taglia());
        b.innerHTML = `${esc(t.nome)}<small>${esc(t.etichetta||'')}</small>`;
        b.addEventListener('click', () => {
          impostaTaglia(t.id); aggiorna({taglia:t.id}); ridisegna();
          if(alCambio) alCambio(t.id);
        });
        c.appendChild(b);
      });
    }
    ridisegna();
    return ridisegna;
  }

  function testoSpiegaTaglia(){
    const t = tagliaOggetto();
    if(!t) return '';
    return `<b>${esc(t.etichetta || t.nome)}</b>${t.descrizione ? ' — ' + esc(t.descrizione) : ''}` +
           (t.esempi ? `<br>${esc(t.esempi)}` : '');
  }

  return {carica, esc, taglia, impostaTaglia, tagliaOggetto, selezione, salvaSelezione,
          aggiorna, azzera, trovaLivello, trovaExtra, prezzoDi, testoPrezzo, euro,
          totale, disegnaChipsTaglia, testoSpiegaTaglia,
          storico, aggiungiAStorico, mieAuto, collegato, inviaPrenotazione,
          get dati(){ return dati; }};
})();
