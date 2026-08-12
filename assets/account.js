/* Account dei clienti ROPE.

   Registrazione, accesso e sessione. Qui dentro non c'è nessuna chiave
   riservata: solo quella pubblica. A proteggere i dati sono la password
   del cliente e le regole scritte in supabase/account-clienti.sql, che
   fanno vedere a ognuno soltanto le proprie prenotazioni. */
window.ROPE_ACCOUNT = (function(){
  const C    = window.ROPE_CONFIG || {};
  const BASE = String(C.URL || "").replace(/\/$/, "");
  const PUB  = C.CHIAVE_PUBBLICA || "";
  const MEMORIA = "rope-cliente";

  let sessione = null;
  try { sessione = JSON.parse(localStorage.getItem(MEMORIA) || "null"); } catch(e){}

  function ricorda(s){
    if(!s){ sessione = null; localStorage.removeItem(MEMORIA); return; }
    const u = s.user || {};
    const m = u.user_metadata || {};
    sessione = {
      access_token:  s.access_token,
      refresh_token: s.refresh_token,
      id:            u.id       || (sessione && sessione.id)       || "",
      email:         u.email    || (sessione && sessione.email)    || "",
      nome:          m.nome     || (sessione && sessione.nome)     || "",
      telefono:      m.telefono || (sessione && sessione.telefono) || "",
      scade:         Date.now() + ((s.expires_in || 3600) * 1000)
    };
    localStorage.setItem(MEMORIA, JSON.stringify(sessione));
  }

  function messaggioChiaro(o, stato){
    const m = String(o.error_description || o.msg || o.message || "");
    if(/already registered|already been registered/i.test(m))
      return "C'è già un account con questa email. Prova ad entrare.";
    if(/invalid login|invalid credentials/i.test(m))
      return "Email o password non corretti.";
    if(/password should be at least/i.test(m))
      return "La password deve avere almeno 6 caratteri.";
    if(/signups not allowed|signup is disabled/i.test(m))
      return "Le registrazioni sono chiuse. Avvisa il centro.";
    if(/email.*invalid|unable to validate email/i.test(m))
      return "Questa email non sembra scritta bene.";
    if(/rate limit|too many/i.test(m))
      return "Troppi tentativi. Aspetta qualche minuto e riprova.";
    return m || ("Qualcosa non ha funzionato (" + stato + ").");
  }

  async function chiama(percorso, corpo, opzioni){
    const r = await fetch(BASE + percorso, {
      method: "POST",
      headers: Object.assign({"apikey": PUB, "Content-Type": "application/json"},
                             (opzioni && opzioni.headers) || {}),
      body: JSON.stringify(corpo)
    });
    const o = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(messaggioChiaro(o, r.status));
    return o;
  }

  /* ---------- registrazione e accesso ---------- */

  async function registra(email, password, nome, telefono){
    if(!BASE || !PUB) throw new Error("Collegamento non configurato.");
    nome = String(nome || "").trim();
    telefono = String(telefono || "").trim();
    if(nome.length < 2) throw new Error("Scrivi il tuo nome.");
    if(telefono.replace(/[^0-9]/g, "").length < 8)
      throw new Error("Scrivi un numero di telefono valido.");

    const o = await chiama("/auth/v1/signup", {
      email: String(email || "").trim(),
      password: String(password || ""),
      data: {nome: nome, telefono: telefono}
    });

    // se il progetto chiede la conferma via email, qui non arriva la sessione
    if(!o.access_token){
      const e = new Error("Ti abbiamo mandato un'email per confermare l'indirizzo. "
                          + "Aprila, poi torna qui ed entra.");
      e.motivo = "conferma";
      throw e;
    }
    ricorda(o);
    return sessione;
  }

  async function entra(email, password){
    if(!BASE || !PUB) throw new Error("Collegamento non configurato.");
    const o = await chiama("/auth/v1/token?grant_type=password", {
      email: String(email || "").trim(), password: String(password || "")
    });
    ricorda(o);
    return sessione;
  }

  /* ---------- Accedi con Apple ----------
     Dentro l'app usiamo la finestra di sistema (Face ID): Apple ci
     restituisce un gettone firmato che passiamo a Supabase. Non serve
     nessuna chiave segreta, basta che l'identificativo dell'app sia
     autorizzato nel pannello di Supabase.

     Il "nonce" è un numero usa e getta: lo mandiamo ad Apple cifrato e
     a Supabase in chiaro, così nessuno può riusare un vecchio gettone. */
  function moduloApple(){
    const cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.SignInWithApple) || null;
  }

  const appleDisponibile = () => !!moduloApple();

  function nonceCasuale(){
    const b = new Uint8Array(32);
    (window.crypto || {}).getRandomValues(b);
    return [...b].map(x => ('0' + x.toString(16)).slice(-2)).join('');
  }

  async function inSha256(testo){
    const dati = new TextEncoder().encode(testo);
    const somma = await crypto.subtle.digest('SHA-256', dati);
    return [...new Uint8Array(somma)].map(x => ('0' + x.toString(16)).slice(-2)).join('');
  }

  async function conApple(){
    const m = moduloApple();
    if(!m) throw new Error("L'accesso con Apple funziona solo dentro l'app.");

    const grezzo = nonceCasuale();
    let esito;
    try{
      esito = await m.authorize({
        clientId: 'com.rosariopepe.rope',
        scopes: 'name email',
        nonce: await inSha256(grezzo)
      });
    }catch(e){
      const annullato = /cancel|1001/i.test(String(e && (e.message || e.code)));
      throw new Error(annullato ? "Accesso annullato." : "Apple non ha risposto. Riprova.");
    }

    const gettone = esito && esito.response && esito.response.identityToken;
    if(!gettone) throw new Error("Apple non ha restituito l'accesso. Riprova.");

    const o = await chiama('/auth/v1/token?grant_type=id_token', {
      provider: 'apple', id_token: gettone, nonce: grezzo
    });
    ricorda(o);

    /* Apple manda nome e cognome solo la primissima volta: se ce li dà,
       li salviamo subito, altrimenti li chiederemo al primo appuntamento. */
    const r = esito.response || {};
    const nome = [r.givenName, r.familyName].filter(Boolean).join(' ').trim();
    if(nome && !sessione.nome){
      try{ await aggiornaDati(nome, sessione.telefono || ''); }catch(e){}
    }
    return sessione;
  }

  function esci(){
    const t = sessione && sessione.access_token;
    ricorda(null);
    /* chi entra dopo su questo telefono non deve trovarsi le auto e la
       prenotazione a metà di chi c'era prima */
    ["rope-selezione", "rope-conferma", "rope-auto"].forEach(k => localStorage.removeItem(k));
    if(t) fetch(BASE + "/auth/v1/logout", {
      method: "POST", headers: {"apikey": PUB, "Authorization": "Bearer " + t}
    }).catch(() => {});
  }

  async function passwordDimenticata(email){
    await chiama("/auth/v1/recover", {email: String(email || "").trim()});
    return true;
  }

  /* ---------- sessione ---------- */

  async function token(){
    if(!sessione) return null;
    if(sessione.scade - Date.now() > 60000) return sessione.access_token;
    try{
      const o = await chiama("/auth/v1/token?grant_type=refresh_token",
                             {refresh_token: sessione.refresh_token});
      ricorda(o);
      return sessione.access_token;
    }catch(e){
      ricorda(null);
      return null;
    }
  }

  const dentro  = () => !!sessione;
  const chiSono = () => sessione ? {id: sessione.id, email: sessione.email,
                                    nome: sessione.nome, telefono: sessione.telefono} : null;

  /* Chiamata a Supabase come cliente collegato. */
  async function conAccount(percorso, opzioni){
    const t = await token();
    if(!t){ const e = new Error("Sessione scaduta"); e.motivo = "scaduta"; throw e; }
    const o = Object.assign({}, opzioni);
    o.headers = Object.assign({"apikey": PUB, "Authorization": "Bearer " + t,
                               "Content-Type": "application/json"}, o.headers || {});
    const r = await fetch(BASE + percorso, o);
    if(r.status === 401){ ricorda(null); const e = new Error("Sessione scaduta"); e.motivo = "scaduta"; throw e; }
    return r;
  }

  /* ---------- dati dell'account ---------- */

  async function aggiornaDati(nome, telefono){
    const r = await conAccount("/auth/v1/user", {
      method: "PUT",
      body: JSON.stringify({data: {nome: String(nome||"").trim(),
                                   telefono: String(telefono||"").trim()}})
    });
    const o = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(messaggioChiaro(o, r.status));
    const m = o.user_metadata || {};
    sessione.nome = m.nome || sessione.nome;
    sessione.telefono = m.telefono || sessione.telefono;
    localStorage.setItem(MEMORIA, JSON.stringify(sessione));
    return chiSono();
  }

  /* Apple pretende che chi può registrarsi possa anche cancellarsi,
     dall'app, senza dover scrivere a nessuno. */
  async function eliminaAccount(){
    const r = await conAccount("/rest/v1/rpc/elimina_mio_account", {method: "POST", body: "{}"});
    if(!r.ok){
      const o = await r.json().catch(() => ({}));
      throw new Error(messaggioChiaro(o, r.status));
    }
    ricorda(null);
    // via anche quello che resta su questo telefono
    ["rope-selezione", "rope-storico", "rope-taglia", "rope-auto", "rope-conferma"]
      .forEach(k => localStorage.removeItem(k));
    return true;
  }

  /* Manda alla schermata di accesso chi non ha ancora un account.
     Da chiamare in cima a ogni schermata che richiede l'accesso. */
  function serveAccesso(){
    if(dentro()) return true;
    const dove = location.pathname.split("/").pop() || "01-home.html";
    location.replace("10-accesso.html?torna=" + encodeURIComponent(dove));
    return false;
  }

  return {registra, entra, esci, passwordDimenticata, token, dentro, chiSono,
          conAccount, aggiornaDati, eliminaAccount, serveAccesso,
          appleDisponibile, conApple};
})();
