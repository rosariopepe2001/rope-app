/* Collegamento del pannello di gestione a Supabase.

   Il pannello continua a chiamare /api/... come faceva col Mac:
   questo file intercetta quelle chiamate e le gira a Supabase,
   così lo stesso pannello funziona sia sul Mac sia online.

   Qui dentro non c'è nessuna chiave riservata: c'è solo la chiave
   pubblica. Quello che protegge i dati è la password (accesso) più
   le regole scritte in supabase/pannello.sql. */
window.ROPE_ACCESSO = (function(){
  const C    = window.ROPE_CONFIG || {};
  const BASE = String(C.URL || "").replace(/\/$/, "");
  const PUB  = C.CHIAVE_PUBBLICA || "";
  const LOCALE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const MEMORIA = "rope-accesso";
  let sessione = null;
  try { sessione = JSON.parse(localStorage.getItem(MEMORIA) || "null"); } catch(e){}

  const fetchVero = window.fetch.bind(window);

  function ricorda(s){
    sessione = s ? {
      access_token:  s.access_token,
      refresh_token: s.refresh_token,
      email:         (s.user && s.user.email) || (sessione && sessione.email) || "",
      scade:         Date.now() + ((s.expires_in || 3600) * 1000)
    } : null;
    if(sessione) localStorage.setItem(MEMORIA, JSON.stringify(sessione));
    else localStorage.removeItem(MEMORIA);
  }

  async function chiediToken(corpo, tipo){
    const r = await fetchVero(BASE + "/auth/v1/token?grant_type=" + tipo, {
      method: "POST",
      headers: {"apikey": PUB, "Content-Type": "application/json"},
      body: JSON.stringify(corpo)
    });
    const o = await r.json().catch(() => ({}));
    if(!r.ok){
      const m = o.error_description || o.msg || o.message || "";
      if(r.status === 400 || r.status === 401)
        throw new Error(/invalid/i.test(m) ? "Email o password non corretti." : (m || "Accesso rifiutato."));
      throw new Error(m || ("Supabase ha risposto " + r.status));
    }
    ricorda(o);
    return o;
  }

  async function entra(email, password){
    if(!BASE || !PUB) throw new Error("Supabase non è collegato: manca assets/config.js");
    await chiediToken({email: String(email||"").trim(), password: String(password||"")}, "password");
    return sessione.email;
  }

  function esci(){
    const t = sessione && sessione.access_token;
    ricorda(null);
    if(t) fetchVero(BASE + "/auth/v1/logout", {
      method: "POST",
      headers: {"apikey": PUB, "Authorization": "Bearer " + t}
    }).catch(() => {});
  }

  /* Token valido, rinnovato da solo poco prima che scada. */
  async function token(){
    if(!sessione) return null;
    if(sessione.scade - Date.now() > 60000) return sessione.access_token;
    try{
      await chiediToken({refresh_token: sessione.refresh_token}, "refresh_token");
      return sessione.access_token;
    }catch(e){
      ricorda(null);
      return null;
    }
  }

  const dentro = () => !!sessione;
  const chiSono = () => sessione ? sessione.email : "";

  /* ---------- risposte in formato /api/... ---------- */
  function risposta(oggetto, stato){
    return new Response(JSON.stringify(oggetto), {
      status: stato || 200,
      headers: {"Content-Type": "application/json; charset=utf-8"}
    });
  }

  function scaduta(){
    ricorda(null);
    document.dispatchEvent(new CustomEvent("rope-sessione-scaduta"));
    return risposta({errore: "Sessione scaduta: rientra con la password."}, 401);
  }

  async function rest(percorso, opzioni){
    const t = await token();
    if(!t) return null;                       // sessione persa
    const o = Object.assign({}, opzioni);
    o.headers = Object.assign({
      "apikey": PUB,
      "Authorization": "Bearer " + t,
      "Content-Type": "application/json"
    }, o.headers || {});
    return fetchVero(BASE + percorso, o);
  }

  async function leggiErrore(r){
    const o = await r.json().catch(() => ({}));
    return o.message || o.msg || o.error || ("Supabase ha risposto " + r.status);
  }

  const AZIONI = {
    async datiGET(){
      const r = await rest("/rest/v1/impostazioni?id=eq.1&select=dati");
      if(!r) return scaduta();
      if(r.status === 401) return scaduta();
      if(!r.ok) return risposta({errore: await leggiErrore(r)}, 502);
      const righe = await r.json();
      return risposta(righe.length ? righe[0].dati : {});
    },

    async datiPOST(corpo){
      const r = await rest("/rest/v1/impostazioni", {
        method: "POST",
        headers: {"Prefer": "resolution=merge-duplicates"},
        body: JSON.stringify({id: 1, dati: corpo, aggiornato_il: new Date().toISOString()})
      });
      if(!r) return scaduta();
      if(r.status === 401) return scaduta();
      if(!r.ok) return risposta({errore: await leggiErrore(r)}, 502);
      return risposta({ok: true});
    },

    async prenotazioniGET(){
      if(!BASE || !PUB) return risposta({collegato: false, prenotazioni: []});
      const r = await rest("/rest/v1/prenotazioni?select=*&order=data_app.asc,ora.asc&limit=200");
      if(!r) return scaduta();
      if(r.status === 401) return scaduta();
      if(!r.ok) return risposta({errore: await leggiErrore(r)}, 502);
      return risposta({collegato: true, prenotazioni: await r.json()});
    },

    async prenotazioniPATCH(corpo){
      const id = corpo && corpo.id, stato = corpo && corpo.stato;
      if(!id || !stato) return risposta({errore: "Serve id e uno stato valido"}, 400);
      const r = await rest("/rest/v1/prenotazioni?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: {"Prefer": "return=representation"},
        body: JSON.stringify({stato: stato})
      });
      if(!r) return scaduta();
      if(r.status === 401) return scaduta();
      if(!r.ok) return risposta({errore: await leggiErrore(r)}, 502);
      return risposta({ok: true, prenotazione: await r.json()});
    },

    async prenotazioniDELETE(corpo){
      const id = corpo && corpo.id;
      if(!id) return risposta({errore: "Serve l'id della prenotazione"}, 400);
      const r = await rest("/rest/v1/prenotazioni?id=eq." + encodeURIComponent(id), {method: "DELETE"});
      if(!r) return scaduta();
      if(r.status === 401) return scaduta();
      if(!r.ok) return risposta({errore: await leggiErrore(r)}, 502);
      return risposta({ok: true});
    },

    /* Le foto vanno nel magazzino di Supabase, così si vedono
       dall'app anche se il Mac è spento. */
    async fotoPOST(corpo){
      const grezzo = String((corpo && corpo.dati) || "");
      const virgola = grezzo.indexOf(",");
      if(virgola < 0) return risposta({errore: "Foto non leggibile"}, 400);
      const tipo = (grezzo.slice(0, virgola).match(/data:([^;]+)/) || [,"image/jpeg"])[1];
      const binario = atob(grezzo.slice(virgola + 1));
      const byte = new Uint8Array(binario.length);
      for(let i = 0; i < binario.length; i++) byte[i] = binario.charCodeAt(i);

      const pulito = String((corpo && corpo.nome) || "foto.jpg")
        .split(/[\\/]/).pop()
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(-60) || "foto.jpg";
      const nome = Date.now() + "-" + pulito;

      const t = await token();
      if(!t) return scaduta();
      const r = await fetchVero(BASE + "/storage/v1/object/foto/" + encodeURIComponent(nome), {
        method: "POST",
        headers: {"apikey": PUB, "Authorization": "Bearer " + t,
                  "Content-Type": tipo, "x-upsert": "true"},
        body: byte
      });
      if(r.status === 401) return scaduta();
      if(!r.ok) return risposta({errore: await leggiErrore(r)}, 502);
      return risposta({ok: true,
        percorso: BASE + "/storage/v1/object/public/foto/" + encodeURIComponent(nome)});
    }
  };

  const SOLO_MAC = {
    "/api/pubblica":    "Il sito si pubblica dal Mac, con avvia-pannello.command.",
    "/api/telegram":    "Gli avvisi Telegram si configurano dal Mac, con avvia-pannello.command.",
    "/api/collegamento":"Il collegamento a Supabase si cambia dal Mac, con avvia-pannello.command."
  };

  /* ---------- intercetta le chiamate /api/... ---------- */
  window.fetch = async function(risorsa, opzioni){
    const url = typeof risorsa === "string" ? risorsa
              : (risorsa && risorsa.url) || "";
    if(!url.startsWith("/api/")) return fetchVero(risorsa, opzioni);

    const metodo = ((opzioni && opzioni.method) || "GET").toUpperCase();
    let corpo = null;
    if(opzioni && opzioni.body){
      try{ corpo = JSON.parse(opzioni.body); }catch(e){ corpo = null; }
    }

    // queste restano al server sul Mac: online non servono
    for(const inizio in SOLO_MAC){
      if(url.startsWith(inizio)){
        if(LOCALE) return fetchVero(risorsa, opzioni);
        return risposta({errore: SOLO_MAC[inizio]}, 400);
      }
    }

    try{
      if(url.startsWith("/api/dati"))
        return metodo === "POST" ? AZIONI.datiPOST(corpo) : AZIONI.datiGET();

      if(url.startsWith("/api/prenotazioni")){
        if(metodo === "PATCH")  return AZIONI.prenotazioniPATCH(corpo);
        if(metodo === "DELETE") return AZIONI.prenotazioniDELETE(corpo);
        return AZIONI.prenotazioniGET();
      }

      if(url.startsWith("/api/foto")) return AZIONI.fotoPOST(corpo);

      return risposta({errore: "Indirizzo sconosciuto"}, 404);
    }catch(e){
      return risposta({errore: e.message || "Errore di collegamento"}, 502);
    }
  };

  return {entra, esci, token, dentro, chiSono, locale: LOCALE};
})();
