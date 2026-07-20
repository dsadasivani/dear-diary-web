/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
  readonly VITE_APP_ENV?: 'development' | 'staging' | 'production';
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SYNC_V2_API_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_MINIMUM_PROTOCOL_VERSION?: string;
  readonly VITE_TELEMETRY_RELEASE_VERSION?: string;
  readonly VITE_TELEMETRY_ENDPOINT?: string;
  readonly VITE_CRASH_REPORT_ENDPOINT?: string;
  readonly VITE_ENABLE_MD_FLOW_HOOKS?: string;
}

interface Navigator {
  userAgentData?: { platform?: string };
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
