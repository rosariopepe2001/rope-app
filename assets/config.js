/* Collegamento a Supabase — scritto dal pannello di gestione.
   Questa chiave e' pubblica: puo' solo inserire prenotazioni. */

window.ROPE_CONFIG = {
  URL: "https://pwewrieenkrujfehjcxs.supabase.co",
  CHIAVE_PUBBLICA: "sb_publishable_ZZPZK0RHgjtKmhgSVefabQ_bqnlz9xq",
  /* Identificativo dell'app su Google, per l'accesso con Google dentro
     l'iPhone: cosi' si apre la finestra di sistema e non il browser, e
     non compare piu' l'indirizzo di Supabase. Anche questo e' pubblico.
     Si crea su Google Cloud: Credenziali > ID client OAuth > iOS. */
  GOOGLE_IOS: "373968438579-af8u6rm8oadu06i3jrarifh5mk8b93vh.apps.googleusercontent.com"
};
