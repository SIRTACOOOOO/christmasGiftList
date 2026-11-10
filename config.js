// PUBLIC settings for the website. Safe to commit: the browser needs both values.
// Find them in Supabase: Project Settings > API (URL) and API Keys (publishable key).
// NEVER put the service_role key or a secret key (sb_secret_...) here or anywhere in this repository.
window.GIFT_CONFIG = {
  SUPABASE_URL: 'https://hbzywhzgcugmksfclety.supabase.co',   // for example https://abcdefghijklmnop.supabase.co
  SUPABASE_KEY: 'sb_publishable_W6eSUcQPopYHdsC_ESPoxg_PTljb3gJ',   // the publishable key (sb_publishable_...) or the legacy "anon" key
  // Phone notifications (optional). The PUBLIC half of your VAPID key pair; see "Phone notifications" in SETUP.md. Leave '' to hide the bell.
  VAPID_PUBLIC_KEY: ''
};
