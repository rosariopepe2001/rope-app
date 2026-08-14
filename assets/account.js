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

  /* ---- come sei entrato l'ultima volta ----
     Chi si registra con Google non ha una password: se poi prova a entrare
     scrivendo email e password, Supabase dice solo "credenziali non
     valide" e il cliente non capisce perché. Qui teniamo nota, su questo
     telefono, di come ha fatto l'accesso ogni email, così glielo possiamo
     dire con parole sue. Resta tutto sul telefono, non va da nessuna parte. */
  const MEMORIA_PROVIDER = "rope-provider";

  function elencoProvider(){
    try{ return JSON.parse(localStorage.getItem(MEMORIA_PROVIDER)) || {}; }
    catch(e){ return {}; }
  }
  function ricordaProvider(email, come){
    const e = String(email || "").trim().toLowerCase();
    if(!e) return;
    try{
      const tutti = elencoProvider();
      tutti[e] = come;
      localStorage.setItem(MEMORIA_PROVIDER, JSON.stringify(tutti));
    }catch(x){}
  }
  function providerDi(email){
    return elencoProvider()[String(email || "").trim().toLowerCase()] || "";
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
    ricordaProvider(sessione.email, "password");
    return sessione;
  }

  async function entra(email, password){
    if(!BASE || !PUB) throw new Error("Collegamento non configurato.");
    const o = await chiama("/auth/v1/token?grant_type=password", {
      email: String(email || "").trim(), password: String(password || "")
    });
    ricorda(o);
    ricordaProvider(sessione.email, "password");
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

  /* Legge il "numero usa e getta" scritto dentro il gettone di Google.

     Serve perché Supabase pretende che il numero che gli passiamo sia
     identico a quello che sta nel gettone: se ne manca uno dei due, o se
     sono diversi, rifiuta l'accesso ("Nonces mismatch", "Passed nonce and
     nonce in id_token should either both exist or not").
     Il gettone è un testo in tre pezzi separati da punti: quello di mezzo
     contiene i dati, scritti in base64. */
  function nonceDelGettone(gettone){
    try{
      let corpo = String(gettone).split(".")[1];
      if(!corpo) return "";
      corpo = corpo.replace(/-/g, "+").replace(/_/g, "/");
      while(corpo.length % 4) corpo += "=";
      const dati = JSON.parse(decodeURIComponent(
        atob(corpo).split("").map(c =>
          "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")));
      return dati.nonce || "";
    }catch(e){ return ""; }
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
    ricordaProvider(sessione.email, "Apple");

    /* Apple manda nome e cognome solo la primissima volta: se ce li dà,
       li salviamo subito, altrimenti li chiederemo al primo appuntamento. */
    const r = esito.response || {};
    const nome = [r.givenName, r.familyName].filter(Boolean).join(' ').trim();
    if(nome && !sessione.nome){
      try{ await aggiornaDati(nome, sessione.telefono || ''); }catch(e){}
    }
    return sessione;
  }

  /* ---------- Accedi con Google ----------
     Google non ha una finestra di sistema come Apple. Si apre la sua
     pagina nel browser sicuro del telefono; quando lui ha finito,
     Google torna a Supabase e Supabase riporta dentro l'app con un
     indirizzo che è solo nostro (com.rosariopepe.rope://accesso),
     portandosi dietro il gettone di accesso.

     Nel browser normale funziona uguale: si torna sulla stessa pagina.
     Niente chiavi segrete qui: il segreto di Google sta su Supabase. */
  const SCHEMA_APP = "com.rosariopepe.rope";
  const RITORNO_APP = SCHEMA_APP + "://accesso";

  function dentroApp(){
    const c = window.Capacitor;
    return !!(c && c.isNativePlatform && c.isNativePlatform());
  }
  const googleDisponibile = () => !!(BASE && PUB);

  function moduli(){
    const c = window.Capacitor;
    return (c && c.Plugins) || {};
  }

  function indirizzoDiRitorno(){
    return dentroApp() ? RITORNO_APP : (location.origin + location.pathname);
  }

  /* Aggiorna nome, email e identificativo leggendoli da Supabase.
     Con Google il nome arriva da lì, non lo scrive il cliente. */
  async function aggiornaDaServer(){
    try{
      const r = await conAccount("/auth/v1/user");
      if(!r.ok) return;
      const u = await r.json();
      const m = u.user_metadata || {};
      sessione.id       = u.id    || sessione.id;
      sessione.email    = u.email || sessione.email;
      sessione.nome     = m.nome || m.full_name || m.name || sessione.nome;
      sessione.telefono = m.telefono || sessione.telefono;
      localStorage.setItem(MEMORIA, JSON.stringify(sessione));
    }catch(e){ /* i dati si recuperano comunque alla prossima chiamata */ }
  }

  /* Legge il gettone dall'indirizzo di ritorno e apre la sessione. */
  async function daIndirizzoDiRitorno(indirizzo){
    let u;
    try{ u = new URL(indirizzo); }catch(e){ return null; }
    const pezzi = new URLSearchParams(String(u.hash || "").replace(/^#/, ""));
    const query = u.searchParams;

    const access  = pezzi.get("access_token");
    const refresh = pezzi.get("refresh_token");
    if(!access){
      const guaio = pezzi.get("error_description") || query.get("error_description")
                 || pezzi.get("error") || query.get("error");
      if(guaio) throw new Error(/denied|cancel/i.test(guaio)
        ? "Accesso annullato." : "Google non ci ha fatto entrare: " + guaio);
      return null;                       // non era un ritorno da Google
    }

    ricorda({access_token: access, refresh_token: refresh,
             expires_in: Number(pezzi.get("expires_in")) || 3600});
    await aggiornaDaServer();
    // se il gettone non vale niente, la sessione è già stata buttata via
    if(!sessione) throw new Error("Google non ci ha fatto entrare. Riprova.");
    ricordaProvider(sessione.email, "Google");
    return sessione;
  }

  /* Nel browser: se siamo appena tornati da Google, l'indirizzo porta
     il gettone dietro il cancelletto. Si prende e si pulisce la barra. */
  async function raccogliRitornoGoogle(){
    if(!/access_token=|error=/.test(location.hash || "")) return null;
    try{
      const s = await daIndirizzoDiRitorno(location.href);
      history.replaceState(null, "", location.pathname + location.search);
      return s;
    }catch(e){
      history.replaceState(null, "", location.pathname + location.search);
      throw e;
    }
  }

  /* ---- Google con la finestra di sistema (dentro l'app) ----
     È la strada buona sull'iPhone: si apre il riquadro di Google gestito
     da iOS, come per Apple. Il cliente vede il nome dell'app, non
     l'indirizzo di Supabase, e non passa da nessun browser.

     Torna null se non è configurato (manca GOOGLE_IOS in config.js):
     in quel caso si ripiega sul browser, che funziona comunque. */
  async function conGoogleNativo(){
    const p = moduli();
    const SL = p.SocialLogin;
    const idApp = (window.ROPE_CONFIG || {}).GOOGLE_IOS;
    if(!SL || !idApp) return null;

    try{
      await SL.initialize({google: {iOSClientId: idApp}});
    }catch(e){ return null; }

    /* Il numero usa e getta, esattamente come per Apple qui sopra:
       a Google si manda la sua impronta (SHA-256), a Supabase il numero
       in chiaro. Supabase rifà l'impronta e confronta.

       Mandando lo stesso numero a tutti e due — che era quello che
       facevo prima — Supabase risponde "Nonces mismatch": lui si aspetta
       di trovare nel gettone l'impronta, non il numero. */
    const nonceGrezzo = nonceCasuale();
    const nonceCifrato = await inSha256(nonceGrezzo);

    let esito;
    try{
      esito = await SL.login({provider: "google",
                              options: {scopes: ["email", "profile"], nonce: nonceCifrato}});
    }catch(e){
      const testo = String((e && (e.message || e.code)) || "");
      const annullato = /cancel|annull|closed|-5/i.test(testo);
      throw new Error(annullato ? "Accesso annullato." : "Google non ha risposto. Riprova.");
    }

    const gettone = esito && esito.result && esito.result.idToken;
    if(!gettone) throw new Error("Google non ha restituito l'accesso. Riprova.");

    /* A Supabase va il numero in chiaro: è lui a rifarne l'impronta e a
       confrontarla con quella scritta nel gettone.
       Se però Google avesse messo nel gettone qualcosa di diverso
       dall'impronta, si passa quello che c'è davvero: meglio entrare che
       restare fuori per un dettaglio. */
    const corpo = {provider: "google", id_token: gettone};
    const nelGettone = nonceDelGettone(gettone);
    if(!nelGettone)                      corpo.nonce = undefined;   // il gettone non ne ha
    else if(nelGettone === nonceCifrato) corpo.nonce = nonceGrezzo;  // il caso normale
    else                                 corpo.nonce = nelGettone;
    if(!corpo.nonce) delete corpo.nonce;

    const o = await chiama("/auth/v1/token?grant_type=id_token", corpo);
    ricorda(o);
    await aggiornaDaServer();
    if(!sessione) throw new Error("Google non ci ha fatto entrare. Riprova.");
    ricordaProvider(sessione.email, "Google");
    return sessione;
  }

  async function conGoogle(){
    if(!BASE || !PUB) throw new Error("Collegamento non configurato.");

    if(dentroApp()){
      const s = await conGoogleNativo();
      if(s) return s;              // se null: non configurato, si prova col browser
    }

    const indirizzo = BASE + "/auth/v1/authorize?provider=google&redirect_to="
                    + encodeURIComponent(indirizzoDiRitorno());

    if(!dentroApp()){
      location.href = indirizzo;
      return new Promise(() => {});      // la pagina se ne va: non torna niente
    }

    const p = moduli();
    if(!p.Browser || !p.App)
      throw new Error("L'accesso con Google non è disponibile in questa versione dell'app.");

    return new Promise(async (ok, ko) => {
      let chiuso = false;
      const ascolti = [];
      const smonta = () => ascolti.forEach(a => { try{ a.remove(); }catch(e){} });

      ascolti.push(await p.App.addListener("appUrlOpen", async ({url}) => {
        if(!url || url.indexOf(SCHEMA_APP + "://") !== 0) return;
        chiuso = true;
        smonta();
        try{ await p.Browser.close(); }catch(e){}
        try{
          const s = await daIndirizzoDiRitorno(url);
          if(s) ok(s);
          else ko(new Error("Google non ha restituito l'accesso. Riprova."));
        }catch(e){ ko(e); }
      }));

      // se chiude la finestra col dito, non deve restare tutto appeso
      ascolti.push(await p.Browser.addListener("browserFinished", () => {
        setTimeout(() => {
          if(chiuso) return;
          smonta();
          ko(new Error("Accesso annullato."));
        }, 400);
      }));

      try{
        await p.Browser.open({url: indirizzo, presentationStyle: "popover"});
      }catch(e){
        smonta();
        ko(new Error("Non riesco ad aprire Google. Riprova."));
      }
    });
  }

  function esci(){
    const t = sessione && sessione.access_token;
    ricorda(null);

    /* Anche Google deve dimenticare l'account, altrimenti al rientro
       riprende in automatico l'ultimo usato e non c'è modo di sceglierne
       un altro: la finestra non chiede più niente. */
    try{
      const SL = moduli().SocialLogin;
      if(SL && SL.logout) SL.logout({provider: "google"}).catch(() => {});
    }catch(e){}
    /* chi entra dopo su questo telefono non deve trovarsi le auto e la
       prenotazione a metà di chi c'era prima */
    ["rope-selezione", "rope-conferma", "rope-auto"].forEach(k => localStorage.removeItem(k));
    if(t) fetch(BASE + "/auth/v1/logout", {
      method: "POST", headers: {"apikey": PUB, "Authorization": "Bearer " + t}
    }).catch(() => {});
  }

  /* Il collegamento dell'email deve portare da qualche parte: senza dirlo,
     Supabase lo manda al suo indirizzo di ripiego e il cliente finisce su
     una pagina vuota. Lo mandiamo alla schermata della nuova password.

     Dentro l'app l'email si apre nel browser, non nell'app: quindi si usa
     sempre l'indirizzo del sito. */
  const SITO = "https://rosariopepe2001.github.io/rope-app/";

  function dovePerLaPassword(){
    if(dentroApp()) return SITO + "13-nuova-password.html";
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "13-nuova-password.html";
  }

  async function passwordDimenticata(email){
    await chiama("/auth/v1/recover?redirect_to=" + encodeURIComponent(dovePerLaPassword()),
                 {email: String(email || "").trim()});
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
          appleDisponibile, conApple,
          googleDisponibile, conGoogle, raccogliRitornoGoogle, providerDi};
})();
