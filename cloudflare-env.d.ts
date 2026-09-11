declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    WEBSITE_DB?: D1Database;
    GITHUB_LOGIN_ENABLED?: string;
    GITHUB_OAUTH_CLIENT_ID?: string;
    GITHUB_OAUTH_CLIENT_SECRET?: string;
    FEISHU_LOGIN_ENABLED?: string;
    FEISHU_NOTIFICATIONS_ENABLED?: string;
    FEISHU_LOGIN_APP_ID?: string;
    FEISHU_LOGIN_APP_SECRET?: string;
    FEISHU_LOGIN_TENANT_KEY?: string;
    OA_PUBLIC_ORIGIN?: string;
    PUBLIC_LAB_AI_SERVICE_TOKEN: string;
    OA_LAB_AI_ENABLED?: string;
    OA_LAB_AI_ENDPOINT?: string;
    OA_LAB_AI_API_KEY?: string;
    OA_LAB_AI_MODEL?: string;
    OA_LAB_AI_FORMAT?: string;
    OA_LAB_AI_TIMEOUT_MS?: string;
  }
}
