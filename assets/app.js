/* Motore comune delle schermate ROPE.
   Legge prezzi, orari e galleria da Supabase (li cambia il pannello di
   gestione) e tiene in memoria la taglia scelta e la prenotazione in corso. */
window.ROPE = (function(){
  let dati = null;

  const esc = t => String(t ?? "").replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* ---- da dove arrivano prezzi, orari e galleria ----
     1. da Supabase, sempre che ci sia rete: è la versione buona,
        quella che il pannello cambia in qualsiasi momento;
     2. altrimenti l'ultima scaricata davvero, tenuta sul telefono;
     3. e solo al primissimo avvio senza rete, la copia dentro l'app.

     Il punto 2 esiste perché la copia dentro l'app resta ferma al giorno
     in cui è stata pubblicata sull'App Store: senza memoria, un cliente
     offline dopo sei mesi vedrebbe i prezzi di sei mesi fa. */
  const MEMORIA_DATI = 'rope-dati';
  const ATTESA_MAX = 8000;      // ms: oltre, si usa quello che abbiamo già

  function sensati(d){
    return !!(d && Array.isArray(d.pacchetti) && Array.isArray(d.taglie) && d.taglie.length);
  }

  function daMemoria(){
    try{
      const g = JSON.parse(localStorage.getItem(MEMORIA_DATI) || 'null');
      if(g && sensati(g.dati)) return g.dati;
    }catch(e){}
    return null;
  }

  function inMemoria(d){
    try{
      localStorage.setItem(MEMORIA_DATI,
        JSON.stringify({salvatiIl: new Date().toISOString(), dati: d}));
    }catch(e){ /* memoria piena o negata: pazienza, non è un errore grave */ }
  }

  async function scarica(){
    const c = window.ROPE_CONFIG || {};
    if(c.URL && c.CHIAVE_PUBBLICA){
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), ATTESA_MAX);
      try{
        const r = await fetch(c.URL.replace(/\/$/,'') + '/rest/v1/impostazioni?id=eq.1&select=dati', {
          headers: {'apikey': c.CHIAVE_PUBBLICA, 'Authorization': 'Bearer ' + c.CHIAVE_PUBBLICA},
          cache: 'no-store', signal: stop.signal
        });
        if(r.ok){
          const righe = await r.json();
          if(righe.length && sensati(righe[0].dati)){
            inMemoria(righe[0].dati);
            return righe[0].dati;
          }
        }
      }catch(e){ /* rete assente o lenta: si continua qui sotto */ }
      finally{ clearTimeout(timer); }
    }

    const salvati = daMemoria();
    if(salvati) return salvati;

    const r = await fetch('dati/dati.json', {cache:'no-store'});
    if(!r.ok) throw new Error('dati non raggiungibili');
    return r.json();
  }

  /* Usa dati già pronti invece di riscaricarli. Serve al pannello di
     gestione: così prezzi e orari usati per una prenotazione manuale
     sono esattamente quelli che ha davanti agli occhi. */
  function usaDati(d){
    dati = d;
    dati.taglie = dati.taglie || [];
    dati.pacchetti = dati.pacchetti || [];
    dati.galleria = dati.galleria || [];
    return dati;
  }

  async function carica(){
    if(dati) return dati;
    dati = await scarica();
    dati.taglie = dati.taglie || [];
    dati.pacchetti = dati.pacchetti || [];
    dati.galleria = dati.galleria || [];

    // la taglia della prenotazione in corso comanda su quella memorizzata,
    // altrimenti prezzo ed etichetta potrebbero non corrispondere
    const s = selezione();
    if(s.taglia && dati.taglie.some(t => t.id === s.taglia))
      localStorage.setItem('rope-taglia', s.taglia);

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
      durata_minuti: durataPerGiorno(s.pacchettoId, s.livelloId,
                       s.dataISO ? new Date(s.dataISO + 'T00:00:00') : new Date()),
      giorni: giorniDi(s.pacchettoId, s.livelloId),
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

  /* ---- disponibilità ---- */
  const inMinuti = t => {
    const [h,m] = String(t||'0:0').split(':').map(Number);
    return (h||0)*60 + (m||0);
  };
  const inOra = m =>
    String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');

  function giornoConfig(data){
    const d = (dati.disponibilita || {}).giorni || {};
    const chiave = String(data.getDay() === 0 ? 7 : data.getDay());   // 1=lun … 7=dom
    return d[chiave] || null;
  }

  function dataISO(data){
    return data.getFullYear() + '-' +
           String(data.getMonth()+1).padStart(2,'0') + '-' +
           String(data.getDate()).padStart(2,'0');
  }

  function giornoChiuso(data){
    const disp = dati.disponibilita || {};
    if((disp.chiusure || []).includes(dataISO(data))) return true;
    const g = giornoConfig(data);
    return !g || !g.aperto;
  }

  /* Chiede al database quali orari sono già presi.
     La funzione lato server restituisce solo orari e durate: nessun dato del cliente. */
  async function orariOccupati(data){
    if(!collegato()) return [];
    const c = window.ROPE_CONFIG;
    try{
      const r = await fetch(c.URL.replace(/\/$/,'') + '/rest/v1/rpc/orari_occupati', {
        method:'POST',
        headers:{'Content-Type':'application/json',
                 'apikey': c.CHIAVE_PUBBLICA,
                 'Authorization':'Bearer ' + c.CHIAVE_PUBBLICA},
        body: JSON.stringify({giorno: dataISO(data)})
      });
      if(!r.ok) return [];
      return await r.json();
    }catch(e){ return []; }
  }

  /* Quanto tempo occupa davvero un lavoro che parte alle "inizio":
     se attraversa la pausa pranzo, si allunga della durata della pausa. */
  function fineReale(inizio, durata, pausa){
    let fine = inizio + durata;
    if(pausa && inizio < pausa.a && fine > pausa.da) fine += (pausa.a - pausa.da);
    return fine;
  }

  /* Costruisce gli orari proponibili per un giorno, tolti pausa,
     preavviso minimo e appuntamenti già presi. */
  /* opzioni.ignoraPreavviso: usato dal pannello di gestione, che deve poter
     prenotare un cliente anche per fra un'ora. */
  async function slotLiberi(data, durataMinuti, opzioni){
    const disp = dati.disponibilita || {};
    if(giornoChiuso(data)) return [];

    const g = giornoConfig(data);
    const passo = disp.passo || 30;
    const durata = durataMinuti || 120;
    const apre = inMinuti(g.da), chiude = inMinuti(g.a);

    const pausa = disp.pausa && disp.pausa.attiva
      ? {da: inMinuti(disp.pausa.da), a: inMinuti(disp.pausa.a)} : null;

    const righe = await orariOccupati(data);
    if(righe.some(o => o.giorno_pieno)) return [];   // giornata già impegnata tutta

    const occupati = righe.map(o => {
      const da = inMinuti(o.ora);
      return {da, a: fineReale(da, o.durata_minuti || 120, pausa)};
    });

    const adesso = new Date();
    const minimo = (opzioni && opzioni.ignoraPreavviso)
      ? new Date(0)
      : new Date(adesso.getTime() + (disp.preavvisoOre ?? 12) * 3600000);

    const slot = [];
    for(let m = apre; m <= chiude; m += passo){
      const fine = fineReale(m, durata, pausa);
      if(fine > chiude) break;                       // non si finirebbe in giornata

      const quando = new Date(data); quando.setHours(0, m, 0, 0);

      let libero = quando >= minimo;
      // non si può iniziare durante la pausa, ma la si può attraversare
      if(libero && pausa && m >= pausa.da && m < pausa.a) libero = false;
      if(libero) libero = !occupati.some(o => m < o.a && fine > o.da);

      slot.push({ora: inOra(m), libero});
    }
    return slot;
  }

  /* Giorni consecutivi liberi, per i lavori che durano più di una giornata. */
  async function giorniLiberi(data, quantiGiorni){
    for(let i = 0; i < quantiGiorni; i++){
      const g = new Date(data); g.setDate(g.getDate() + i);
      if(giornoChiuso(g)) return false;
      const righe = await orariOccupati(g);
      if(righe.length) return false;
    }
    const disp = dati.disponibilita || {};
    const minimo = new Date(Date.now() + (disp.preavvisoOre ?? 12) * 3600000);
    const inizio = new Date(data);
    inizio.setHours(...String(giornoConfig(data).da).split(':').map(Number), 0, 0);
    return inizio >= minimo;
  }

  function durataDi(pacchettoId, livelloId){
    const t = trovaLivello(pacchettoId, livelloId);
    return (t && t.livello.durataMinuti) || 120;
  }

  /* Quanto lavoro ci sta in una giornata, tolta la pausa.
     Si ricalcola da solo se cambi orari o pausa. */
  function minutiLavorabili(data){
    const g = giornoConfig(data);
    if(!g || !g.aperto) return 0;
    const disp = dati.disponibilita || {};
    const pausa = disp.pausa && disp.pausa.attiva
      ? inMinuti(disp.pausa.a) - inMinuti(disp.pausa.da) : 0;
    return (inMinuti(g.a) - inMinuti(g.da)) - pausa;
  }

  /* Durata effettiva per un certo giorno: i servizi segnati come
     "giornata intera" si adattano agli orari di quel giorno. */
  function durataPerGiorno(pacchettoId, livelloId, data){
    const t = trovaLivello(pacchettoId, livelloId);
    if(t && t.livello.giornataIntera) return minutiLavorabili(data);
    return durataDi(pacchettoId, livelloId);
  }

  /* Quante giornate intere occupa il servizio (1 = si prenota a orario). */
  function giorniDi(pacchettoId, livelloId){
    const t = trovaLivello(pacchettoId, livelloId);
    return (t && t.livello.durataGiorni) || 1;
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

  return {carica, usaDati, esc, taglia, impostaTaglia, tagliaOggetto, selezione, salvaSelezione,
          aggiorna, azzera, trovaLivello, trovaExtra, prezzoDi, testoPrezzo, euro,
          totale, disegnaChipsTaglia, testoSpiegaTaglia,
          storico, aggiungiAStorico, mieAuto, collegato, inviaPrenotazione,
          giornoChiuso, slotLiberi, giorniLiberi, durataDi, giorniDi, dataISO,
          durataPerGiorno, minutiLavorabili,
          get dati(){ return dati; }};
})();
