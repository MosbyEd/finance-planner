import path from "node:path";

/** Настройки сервера читаются при каждом обращении — так их можно менять в тестах. */
export const env = {
  get databasePath(): string {
    const fromEnv = process.env.DATABASE_PATH;
    return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), "data", "finance.sqlite");
  },
  get deepseekApiKey(): string {
    return process.env.DEEPSEEK_API_KEY ?? "";
  },
  /** Secure-cookie: по умолчанию включены в production. За HTTPS-прокси оставьте true. */
  get cookieSecure(): boolean {
    const v = process.env.COOKIE_SECURE;
    if (v === "true" || v === "false") return v === "true";
    return process.env.NODE_ENV === "production";
  },
  get registrationOpen(): boolean {
    return process.env.ALLOW_REGISTRATION !== "false";
  },
  /**
   * TRUST_PROXY=true — сервер стоит за своим обратным прокси (nginx, Caddy), который сам выставляет
   * X-Real-IP / дописывает X-Forwarded-For. Только тогда IP из этих заголовков используется в ограничителях
   * частоты. Без прокси заголовки присылает сам клиент и может подделать их на каждый запрос,
   * поэтому по умолчанию (false) все запросы считаются с одного «адреса».
   */
  get trustProxy(): boolean {
    return process.env.TRUST_PROXY === "true";
  },
  /**
   * Откуда брать адрес клиента при TRUST_PROXY=true:
   *  - по умолчанию (x-forwarded-for) — только ПОСЛЕДНИЙ адрес X-Forwarded-For: его дописывает наш прокси
   *    (nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for), а предыдущие мог прислать клиент;
   *  - TRUST_PROXY_HEADER=x-real-ip — заголовок X-Real-IP. Только если прокси ПЕРЕЗАПИСЫВАЕТ его
   *    (nginx: proxy_set_header X-Real-IP $remote_addr), иначе клиент подставит любой адрес.
   * X-Real-IP по умолчанию не читается: прокси, который его не выставляет, пропустил бы заголовок клиента.
   */
  get trustProxyHeader(): "x-forwarded-for" | "x-real-ip" {
    return process.env.TRUST_PROXY_HEADER?.trim().toLowerCase() === "x-real-ip" ? "x-real-ip" : "x-forwarded-for";
  },
};
