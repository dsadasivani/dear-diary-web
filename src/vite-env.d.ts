/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_ENABLE_MD_FLOW_HOOKS?: string;
}

interface Navigator {
  userAgentData?: { platform?: string };
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
