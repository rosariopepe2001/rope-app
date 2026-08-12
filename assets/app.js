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

  /* Appena la prenotazione è partita, la selezione va svuotata: servizio,
     extra, data, ora e auto non devono ritrovarsi selezionati alla
     prenotazione dopo, nemmeno chiudendo e riaprendo l'app.
     Quello che serve alla schermata "confermata" lo mettiamo da parte qui. */
  const MEMORIA_CONFERMA = 'rope-conferma';

  function chiudiPrenotazione(s){
    try{ localStorage.setItem(MEMORIA_CONFERMA, JSON.stringify(s || {})); }catch(e){}
    azzera();
  }
  function ultimaConfermata(){
    try{ return JSON.parse(localStorage.getItem(MEMORIA_CONFERMA)) || {}; }
    catch(e){ return {}; }
  }

  /* ---- invio della prenotazione a Supabase ----
     Se le chiavi non sono compilate, non fa niente e non blocca l'app:
     la prenotazione resta comunque nello storico locale. */
  function collegato(){
    const c = window.ROPE_CONFIG || {};
    return !!(c.URL && c.CHIAVE_PUBBLICA);
  }

  /* Fra quando il cliente sceglie l'ora e quando conferma passano minuti:
     nel frattempo un altro cliente, o il pannello di gestione, può aver
     preso lo stesso posto. Ultimo controllo prima di scrivere. */
  async function ancoraLibero(s){
    if(!s.dataISO || !s.ora) return true;
    if(!s.livelloId && !soloExtra(s)) return true;
    const data = new Date(s.dataISO + 'T00:00:00');
    const quanti = giorniDellaSelezione(s);
    if(quanti > 1) return giorniLiberi(data, quanti);
    const slot = await slotLiberi(data, durataDellaSelezione(s, data));
    const trovato = slot.find(x => x.ora === s.ora);
    return !!(trovato && trovato.libero);
  }

  async function inviaPrenotazione(s){
    if(!collegato()) return {inviata:false, motivo:'non collegato'};

    if(!(await ancoraLibero(s))){
      const e = new Error("Quell'orario è appena stato preso. Scegline un altro, ci vuole un attimo.");
      e.motivo = 'occupato';
      throw e;
    }

    const c = window.ROPE_CONFIG;
    const t = s.pacchettoId ? trovaLivello(s.pacchettoId, s.livelloId) : null;
    const riga = {
      codice: s.codice || null,
      cliente_nome: (s.cliente||{}).nome || null,
      cliente_tel:  (s.cliente||{}).telefono || null,
      pacchetto: t ? t.pacchetto.nome : (soloExtra(s) ? 'Servizi extra' : null),
      pacchetto_id: s.pacchettoId || null,
      servizio: nomeDellaSelezione(s) || null,
      livello_id: s.livelloId || null,
      taglia: s.taglia || null,
      extra: (s.extra||[]).map(e => {
        const x = trovaExtra(e.pacchettoId || s.pacchettoId, e.id);
        return {id:e.id, nome: x ? x.nome : e.id};
      }),
      totale: totale(s).testo,
      data_app: s.dataISO || null,
      ora: s.ora || null,
      durata_minuti: durataDellaSelezione(s,
                       s.dataISO ? new Date(s.dataISO + 'T00:00:00') : new Date()),
      giorni: giorniDellaSelezione(s),
      auto: s.auto || {},
      note: s.note || null,
      pagamento: s.pagamento || null
    };
    /* La prenotazione la scrive il cliente collegato, con il suo accesso:
       così resta legata a lui e solo lui (e il titolare) può rivederla. */
    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro()){
      const e = new Error('Serve entrare nel tuo account per prenotare.');
      e.motivo = 'accesso';
      throw e;
    }
    const io = acc.chiSono();
    riga.utente = io.id;
    riga.cliente_nome = riga.cliente_nome || io.nome || null;
    riga.cliente_tel  = riga.cliente_tel  || io.telefono || null;

    const r = await acc.conAccount('/rest/v1/prenotazioni', {
      method:'POST',
      headers:{'Prefer':'return=representation'},
      body: JSON.stringify(riga)
    });
    if(!r.ok){
      let dettaglio = '';
      try{ dettaglio = (await r.json()).message || ''; }catch(e){}
      throw new Error(dettaglio || ('invio non riuscito (' + r.status + ')'));
    }
    const salvate = await r.json().catch(() => []);
    return {inviata:true, prenotazione: salvate[0] || null};
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

  /* Richiama la funzione quando l'app torna in primo piano.
     Serve perché lo stato lo cambia il centro dal pannello: senza questo,
     il cliente resta a leggere "in attesa" finché non riavvia l'app. */
  function alRitorno(azione){
    let ultimo = 0;
    const scatta = () => {
      if(document.visibilityState !== 'visible') return;
      const ora = Date.now();
      if(ora - ultimo < 1500) return;      // focus e visibilitychange arrivano insieme
      ultimo = ora;
      azione();
    };
    document.addEventListener('visibilitychange', scatta);
    window.addEventListener('focus', scatta);
  }

  /* Tiene la schermata allineata al database MENTRE il cliente la guarda.
     Senza questo, se il centro conferma o annulla un lavoro mentre lui è
     fermo sulla pagina, deve cambiare schermata per accorgersene.
     Ricontrolla ogni tot secondi, ma solo con l'app in primo piano: a
     schermo spento non consuma né batteria né dati. */
  function tieniAggiornato(azione, ogniMs){
    const passo = ogniMs || 12000;
    let timer = null, inCorso = false;

    async function scatta(){
      if(inCorso || document.visibilityState !== 'visible') return;
      inCorso = true;
      try{ await azione(); }catch(e){ /* un giro andato male non ferma i prossimi */ }
      finally{ inCorso = false; }
    }
    function avvia(){ if(!timer) timer = setInterval(scatta, passo); }
    function ferma(){ if(timer){ clearInterval(timer); timer = null; } }

    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') avvia(); else ferma();
    });
    alRitorno(scatta);
    avvia();
    return {scatta, ferma};
  }

  /* Il prossimo appuntamento vero, letto dal database: esclude quelli
     annullati e quelli già completati. */
  async function prossimoAppuntamento(){
    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro()) return null;
    try{
      const oggi = dataISO(new Date());
      const r = await acc.conAccount(
        '/rest/v1/prenotazioni?select=*&data_app=gte.' + oggi +
        '&stato=in.(nuova,confermata)&order=data_app.asc,ora.asc&limit=1');
      if(!r.ok) return null;
      const righe = await r.json();
      return righe[0] || null;
    }catch(e){ return null; }
  }

  /* ---- prenotazione dei soli extra ----
     Il cliente può volere solo la lucidatura fari, senza pacchetto.
     In quel caso non c'è un livello: il lavoro è la somma degli extra. */
  function soloExtra(sel){
    const s = sel || selezione();
    return !s.livelloId && (s.extra || []).length > 0;
  }

  /* Tutti gli extra del listino, senza doppioni di nome fra i pacchetti. */
  function extraDelListino(){
    const visti = new Map();
    (dati.pacchetti || []).filter(p => p.attivo !== false).forEach(p => {
      (p.extra || []).filter(x => x.attivo !== false).forEach(x => {
        const chiave = String(x.nome || x.id).toLowerCase().trim();
        if(!visti.has(chiave)) visti.set(chiave, {extra: x, pacchetto: p});
      });
    });
    return [...visti.values()];
  }

  const DURATA_EXTRA = 30;   // minuti, se non è indicata sulla voce

  /* Alcuni lavori — una lucidatura, per esempio — non hanno una durata
     prevedibile: dipende da com'è messa la vernice, e si capisce solo
     vedendo l'auto. Per questi il cliente sceglie il GIORNO IN CUI PORTA
     L'AUTO, non un orario, e il centro dice dopo quanti giorni servono.
     Nel frattempo la giornata di consegna resta occupata per intero. */
  function daValutare(s){
    const t = (s && s.pacchettoId) ? trovaLivello(s.pacchettoId, s.livelloId) : null;
    return !!(t && t.livello.durataDaValutare);
  }

  function durataDellaSelezione(s, data){
    if(daValutare(s)) return minutiLavorabili(data || new Date());
    if(soloExtra(s)){
      const minuti = (s.extra || []).reduce((somma, e) => {
        const x = trovaExtra(e.pacchettoId || s.pacchettoId, e.id);
        return somma + ((x && x.durataMinuti) || DURATA_EXTRA);
      }, 0);
      return Math.max(minuti, DURATA_EXTRA);
    }
    return durataPerGiorno(s.pacchettoId, s.livelloId, data || new Date());
  }

  function giorniDellaSelezione(s){
    return soloExtra(s) ? 1 : giorniDi(s.pacchettoId, s.livelloId);
  }

  /* Come si chiama il lavoro, per il riepilogo e per il pannello. */
  function nomeDellaSelezione(s){
    if(soloExtra(s)){
      const nomi = (s.extra || []).map(e => {
        const x = trovaExtra(e.pacchettoId || s.pacchettoId, e.id);
        return x ? x.nome : e.id;
      });
      return nomi.join(' + ');
    }
    const t = trovaLivello(s.pacchettoId, s.livelloId);
    return t ? (t.livello.titolo || t.livello.nome) : '';
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
  /* ---- le auto del cliente ----
     Stanno nel suo account (tabella auto_cliente su Supabase): così le
     ritrova su qualsiasi telefono e non deve riscriverle a ogni
     prenotazione. Una copia resta anche su questo telefono, per averle
     subito all'apertura e senza rete.

     Se la tabella non è ancora stata creata su Supabase, non si rompe
     niente: restano quelle sul telefono, più quelle ricavate dalle
     prenotazioni già fatte. */
  const MEMORIA_AUTO = 'rope-auto';

  /* Due auto sono la stessa se hanno la stessa targa; senza targa,
     se hanno marca e modello uguali. */
  function chiaveAuto(a){
    a = a || {};
    const t = String(a.targa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if(t) return t;
    return (String(a.marca || '') + ' ' + String(a.modello || ''))
             .toUpperCase().replace(/\s+/g, ' ').trim();
  }

  function autoValida(a){ return !!chiaveAuto(a); }

  function autoDelTelefono(){
    try{ return JSON.parse(localStorage.getItem(MEMORIA_AUTO)) || []; }
    catch(e){ return []; }
  }
  function scriviAutoDelTelefono(elenco){
    try{ localStorage.setItem(MEMORIA_AUTO, JSON.stringify(elenco.slice(0, 20))); }
    catch(e){ /* memoria piena: pazienza */ }
  }

  function ripulisciAuto(a){
    a = a || {};
    return {
      marca:   String(a.marca   || '').trim(),
      modello: String(a.modello || '').trim(),
      targa:   String(a.targa   || '').trim().toUpperCase(),
      colore:  String(a.colore  || '').trim(),
      taglia:  a.taglia || null
    };
  }

  /* Quelle salvate nell'account. null = non è riuscito a leggerle
     (tabella non creata, oppure niente rete): non vuol dire "nessuna auto". */
  async function autoDellAccount(){
    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro()) return null;
    try{
      const r = await acc.conAccount(
        '/rest/v1/auto_cliente?select=*&order=usata_il.desc.nullslast&limit=20');
      if(!r.ok) return null;
      return await r.json();
    }catch(e){ return null; }
  }

  /* Quelle già usate in una prenotazione: recupero, se la tabella manca. */
  async function autoDallePrenotazioni(){
    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro()) return [];
    try{
      const r = await acc.conAccount(
        '/rest/v1/prenotazioni?select=auto,taglia,data_app&order=data_app.desc&limit=60');
      if(!r.ok) return [];
      return (await r.json())
        .map(v => Object.assign(ripulisciAuto(v.auto), {taglia: v.taglia || null}))
        .filter(autoValida);
    }catch(e){ return []; }
  }

  /* L'elenco completo, senza doppioni, la più usata di recente per prima. */
  async function mieAuto(){
    const daAccount = await autoDellAccount();
    const elenco = daAccount === null
      ? [...autoDelTelefono(), ...(await autoDallePrenotazioni())]
      : [...daAccount, ...autoDelTelefono()];

    const viste = new Map();
    elenco.forEach(a => {
      const k = chiaveAuto(a);
      if(!k) return;
      const gia = viste.get(k);
      if(!gia) viste.set(k, a);
      // se una versione ha l'id di Supabase, quella comanda: si può cancellare
      else if(!gia.id && a.id) viste.set(k, Object.assign({}, gia, a));
    });
    const tutte = [...viste.values()];
    if(daAccount === null) scriviAutoDelTelefono(tutte);
    return tutte;
  }

  /* Salva (o aggiorna) un'auto. Non blocca mai chi sta prenotando:
     se Supabase non risponde, resta almeno su questo telefono. */
  async function salvaAuto(auto){
    const a = ripulisciAuto(auto);
    if(!autoValida(a)) return false;

    const resto = autoDelTelefono().filter(x => chiaveAuto(x) !== chiaveAuto(a));
    scriviAutoDelTelefono([a, ...resto]);

    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro()) return false;
    const io = acc.chiSono() || {};
    try{
      const r = await acc.conAccount('/rest/v1/auto_cliente?on_conflict=utente,chiave', {
        method: 'POST',
        headers: {'Prefer': 'resolution=merge-duplicates,return=representation'},
        body: JSON.stringify(Object.assign({
          utente: io.id, chiave: chiaveAuto(a), usata_il: new Date().toISOString()
        }, a))
      });
      return r.ok;
    }catch(e){ return false; }
  }

  async function eliminaAuto(auto){
    const a = auto || {};
    const resto = autoDelTelefono().filter(x => chiaveAuto(x) !== chiaveAuto(a));
    scriviAutoDelTelefono(resto);

    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro() || !a.id) return false;
    try{
      const r = await acc.conAccount(
        '/rest/v1/auto_cliente?id=eq.' + encodeURIComponent(a.id), {method: 'DELETE'});
      return r.ok;
    }catch(e){ return false; }
  }

  const nomeAuto = a => [(a||{}).marca, (a||{}).modello].filter(Boolean).join(' ').trim();

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
          aggiorna, azzera, chiudiPrenotazione, ultimaConfermata, trovaLivello, trovaExtra, prezzoDi, testoPrezzo, euro,
          totale, disegnaChipsTaglia, testoSpiegaTaglia,
          storico, aggiungiAStorico, collegato, inviaPrenotazione, ancoraLibero,
          mieAuto, salvaAuto, eliminaAuto, chiaveAuto, autoValida, nomeAuto,
          giornoChiuso, slotLiberi, giorniLiberi, durataDi, giorniDi, dataISO,
          durataPerGiorno, minutiLavorabili, soloExtra, extraDelListino,
          alRitorno, tieniAggiornato, prossimoAppuntamento, daValutare,
          durataDellaSelezione, giorniDellaSelezione, nomeDellaSelezione,
          get dati(){ return dati; }};
})();
