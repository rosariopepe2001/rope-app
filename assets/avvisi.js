/* Promemoria degli appuntamenti, sul telefono del cliente.

   Due avvisi per ogni appuntamento in arrivo: 2 ore e mezza prima e
   1 ora prima. Sono notifiche locali: le programma il telefono stesso,
   quindi arrivano anche senza rete e non costano niente.

   Ogni volta che l'app si apre ricontrolliamo le prenotazioni vere e
   riprogrammiamo tutto da capo: così, se il centro annulla o sposta un
   appuntamento, i promemoria si aggiornano da soli. */
window.ROPE_AVVISI = (function(){

  const PRIMA = [
    {minuti: 150, testo: "Fra due ore e mezza"},
    {minuti: 60,  testo: "Fra un'ora"}
  ];

  function modulo(){
    const cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.LocalNotifications) || null;
  }

  /* Fuori dall'app (nel browser) non esistono: non è un errore, si tace. */
  const disponibili = () => !!modulo();

  /* Un numero stabile ricavato dall'identificativo della prenotazione:
     serve al telefono per riconoscere e sostituire i propri avvisi. */
  function numeroDa(testo){
    let n = 0;
    const s = String(testo || "");
    for(let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 100000;
    return n;
  }

  /* chiedi=true solo dove il cliente capisce perché glielo stiamo chiedendo
     (dopo aver prenotato). All'avvio dell'app non si chiede niente. */
  async function permessoConcesso(chiedi){
    const m = modulo();
    if(!m) return false;
    try{
      let stato = await m.checkPermissions();
      if(chiedi && (stato.display === 'prompt' || stato.display === 'prompt-with-rationale'))
        stato = await m.requestPermissions();
      return stato.display === 'granted';
    }catch(e){ return false; }
  }

  function quandoAvvisare(prenotazione, minutiPrima){
    if(!prenotazione.data_app || !prenotazione.ora) return null;
    const [h, mi] = String(prenotazione.ora).split(':').map(Number);
    const q = new Date(prenotazione.data_app + 'T00:00:00');
    q.setHours(h || 0, mi || 0, 0, 0);
    q.setMinutes(q.getMinutes() - minutiPrima);
    return q > new Date() ? q : null;      // già passato: niente avviso
  }

  /* Cancella i vecchi promemoria e riprogramma quelli che servono. */
  async function programma(prenotazioni, chiedi){
    const m = modulo();
    if(!m) return {programmati: 0, motivo: 'non siamo dentro l\'app'};
    if(!(await permessoConcesso(chiedi))) return {programmati: 0, motivo: 'permesso negato'};

    try{
      const inCorso = await m.getPending();
      if(inCorso && inCorso.notifications && inCorso.notifications.length)
        await m.cancel({notifications: inCorso.notifications.map(n => ({id: n.id}))});
    }catch(e){ /* se non riusciamo a cancellare, riprogrammiamo comunque */ }

    const daFare = [];
    (prenotazioni || []).forEach(p => {
      if(p.stato === 'annullata') return;
      const base = numeroDa(p.id);
      PRIMA.forEach((avviso, i) => {
        const quando = quandoAvvisare(p, avviso.minuti);
        if(!quando) return;
        daFare.push({
          id: base * 10 + i,
          title: 'ROPE Car Detailing',
          body: avviso.testo + ' hai l\'appuntamento: '
                + (p.servizio || 'servizio') + ' alle ' + p.ora + '.',
          schedule: {at: quando, allowWhileIdle: true},
          smallIcon: 'ic_stat_icon_config_sample'
        });
      });
    });

    if(daFare.length) await m.schedule({notifications: daFare});
    return {programmati: daFare.length};
  }

  /* Si prende da sola l'elenco aggiornato e riprogramma. */
  async function aggiorna(chiedi){
    if(!modulo()) return {programmati: 0, motivo: 'non siamo dentro l\'app'};
    const acc = window.ROPE_ACCOUNT;
    if(!acc || !acc.dentro()) return {programmati: 0, motivo: 'nessun account'};
    try{
      const oggi = new Date().toISOString().slice(0, 10);
      const r = await acc.conAccount(
        '/rest/v1/prenotazioni?select=id,servizio,data_app,ora,stato'
        + '&data_app=gte.' + oggi + '&order=data_app.asc&limit=50');
      if(!r.ok) return {programmati: 0, motivo: 'risposta ' + r.status};
      return await programma(await r.json(), chiedi);
    }catch(e){
      return {programmati: 0, motivo: e.message};
    }
  }

  return {disponibili, permessoConcesso, programma, aggiorna};
})();
