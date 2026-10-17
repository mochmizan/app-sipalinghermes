// PostHog analytics bootstrap — shared by all pages via <script src="/posthog-init.js"></script>.
// Official PostHog JS snippet: installs a full method stub immediately (early capture/identify
// calls are QUEUED, not dropped) and loads the library from the dedicated assets host.
// The project API key lives in exactly ONE place (POSTHOG_PROJECT_KEY below); swap it there.
(() => {
  if (window.__hermesPosthogLoaded) return;
  window.__hermesPosthogLoaded = true;

  // PostHog project API key — exactly ONE place. The server injects the real key
  // from POSTHOG_API_KEY at serve time (see server.mjs); the repo only holds
  // this placeholder so no secret ever lands in git. Empty key = snippet stays
  // inert (stub installed, init skipped), page works normally.
  const POSTHOG_PROJECT_KEY = '__POSTHOG_PROJECT_KEY__';

  if (!POSTHOG_PROJECT_KEY || POSTHOG_PROJECT_KEY.indexOf('__') === 0) return;

  // Official PostHog snippet (guards itself via e.__SV).
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=s;void 0!==a?e[a]=[]:a="posthog";for(const c in e)"capture"!==c&&"people"!==c&&"register"!==c&&"unregister"!==c&&"identify"!==c&&"reset"!==c&&(u[c]=e[c]);e.config=s,e[a]=[],e.people=e.people||[],e.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},e.people.toString=function(){return e.toString(1)+".people (stub)"};for(o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset reset_feature_flags".split(" "),n=0;n<o.length;n++)g(e,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  posthog.init(POSTHOG_PROJECT_KEY, {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-05-30',
    person_profiles: 'identified_only',
    autocapture: true
  });
})();
