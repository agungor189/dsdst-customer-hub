# DSDST Customer Hub

DSDST'nin bağımsız Customer Hub / omnichannel inbox uygulaması. Panel kullanıcılarını kullanır; kanal hesapları, müşteriler, kimlikler, konuşmalar, mesajlar, ekler, etiketler, notlar, senkronizasyon ve audit verisinin sahibi kendi SQLite veritabanıdır. Panel veritabanını hiçbir zaman açmaz.

## Mimari

```text
Browser ── same-origin cookie ──> Customer Hub (Express + React)
                                      │
                       /api/auth/* ────┼──> Panel HTTP API
                                      │
             webhooks / polling ──> adapters ──> channel providers
                                      │
                              SQLite WAL + /data/attachments
                                      │
                        outbox worker / sync scheduler
```

- `server/auth`: Panel login proxy, her istekte `/api/auth/me`, server-side izin kontrolü.
- `server/channels`: capability tabanlı adapter registry; gerçek WhatsApp Cloud, Email IMAP/SMTP ve Trendyol adapter'ları ile diğer kanal temelleri.
- `server/messages`: inbound normalizasyonu ve webhook/external message idempotency.
- `server/outbox`: atomik kuyruğa alma, local claim kilidi ve retry/backoff. SMTP protokolü gerçek exactly-once garantisi vermez; retry aynı deterministik Message-ID'yi kullanır.
- `server/db`: sıralı migrations; WAL, foreign keys ve busy timeout.
- `src/features`: inbox, conversations, contacts ve auth arayüzleri.
- `shared`: istemci/sunucu ortak domain tipleri ve Zod şemaları.

Provider foundation adapter'ları gerçek credential olmadan `NOT_CONFIGURED` kalır; sahte başarı dönmez. WhatsApp Cloud API ve Email gerçek adapter kullanır. Mock adapter yalnız `NODE_ENV!=production` ve `MOCK_ADAPTERS_ENABLED=true` olduğunda açılır.

## Lokal geliştirme

Gereksinim: Node.js 22.

```bash
cp .env.example .env
npm ci
npm run dev          # API + production UI serving için server
npm run dev:client   # ayrı terminalde Vite, /api proxy :3100
```

Geliştirme seed'i, gerçek provider hesabı gibi davranmayan örnek konuşmaları ve `NOT_CONFIGURED` hesapları ekler. Panel'de kullanıcıya en az `customer_hub:view` izni verilmelidir.

## Panel auth ve izinler

`POST /api/auth/login`, bilgileri Panel `/api/auth/login` uç noktasına server-side iletir. Panel JWT yalnız 12 saatlik `HttpOnly`, `SameSite=Strict`, production'da `Secure` cookie olur; JSON veya JavaScript'e dönmez. Her korumalı istek Panel `/api/auth/me` ile aktif kullanıcı ve güncel izinleri tekrar doğrular.

İzinler: `customer_hub:view`, `reply`, `assign`, `manage_channels`, `manage_tags`, `view_customer_context`. `admin` tümüne sahiptir; `readonly`, JSON kaydında yanlışlıkla reply verilse bile yazamaz.

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PANEL_BASE_URL` | Panel internal HTTP adresi |
| `APP_ORIGIN` | CSRF origin kontrolünde kabul edilen public origin |
| `CUSTOMER_HUB_ENCRYPTION_KEY` | Zorunlu production AES-256-GCM anahtarı, 64 hex karakter |
| `DATABASE_PATH` | Varsayılan `/data/customer-hub.db` |
| `ATTACHMENTS_DIR` | Varsayılan `/data/attachments` |
| `SESSION_SECURE` | Production'da `true` |
| `META_APP_SECRET` | `X-Hub-Signature-256` doğrulaması |
| `META_WEBHOOK_VERIFY_TOKEN` | Meta webhook challenge tokenı |
| `ALLOWED_REMOTE_ATTACHMENT_HOSTS` | HTTPS remote attachment host allowlist'i |
| `MOCK_ADAPTERS_ENABLED` | Yalnız development mock Website send adapter |
| `OUTBOX_POLL_INTERVAL_MS` | Outbox worker tarama aralığı |

## Production

`Dockerfile` Node 22 multi-stage build kullanır, yalnız production bağımlılıklarını taşır ve `node` kullanıcısıyla çalışır. Örnek compose root filesystem'i read-only, `/tmp` tmpfs, `/data` yazılabilir mount, `cap_drop: ALL` ve `no-new-privileges` ile çalıştırır.

```bash
docker build -t dsdst/customer-hub:local .
docker compose -f compose.prod.example.yml up -d
curl -fsS http://localhost:${CUSTOMER_HUB_PORT:-3100}/api/health
```

Panel yalnız `internal` ağdan `http://panel:3000` ile erişilir; Hub reverse proxy için hem `edge` hem `internal` ağındadır. Production'da mock adapter açılamaz.

## Webhook kurulumu

Meta callback: `https://<hub-host>/api/webhooks/meta`. GET challenge `META_WEBHOOK_VERIFY_TOKEN`; POST body `META_APP_SECRET` ile HMAC-SHA256 doğrulanır. Event önce `webhook_events` içine unique provider/event id ile yazılır, ardından external account/conversation/message ID kapsamlarında upsert edilir. İmzasız payload işlenmez.

WhatsApp kanal hesabı credential şeması `access_token`, `phone_number_id`, opsiyonel `business_account_id` ve `vXX.X` biçiminde `graph_api_version` alanlarından oluşur. `channel_accounts.external_account_id`, aynı `phone_number_id` değerini taşımalıdır. Serbest metin yanıtı yalnız son inbound WhatsApp mesajından sonraki 24 saat içinde kuyruğa alınır; worker göndermeden hemen önce pencereyi yeniden kontrol eder. Template gönderimi ve inbound medya binary indirme bu sürümün kapsamında değildir.

## Email IMAP/SMTP adapter

Email hesabının `external_account_id` alanı mailbox adresidir. Credential'lar aşağıdaki şemayla kanal oluşturma API'sine verilir; değerler AES-256-GCM ile `encrypted_credentials` içinde saklanır ve API yanıtlarına/audit kayıtlarına dönmez.

```json
{
  "imap_host": "imap.example.com",
  "imap_port": "993",
  "imap_secure": "true",
  "smtp_host": "smtp.example.com",
  "smtp_port": "465",
  "smtp_secure": "true",
  "username": "support@example.com",
  "password": "<secret>",
  "from_address": "support@example.com",
  "from_name": "DSDST Destek",
  "reply_to": "support@example.com",
  "imap_mailbox": "INBOX"
}
```

Zorunlu alanlar: `imap_host`, `imap_port`, `imap_secure`, `smtp_host`, `smtp_port`, `smtp_secure`, `username`, `password`. Port aralığı 1–65535'tir; secure alanları `true`/`false` veya `1`/`0` kabul eder. `imap_mailbox` varsayılanı `INBOX`; `from_address` yoksa email biçimindeki `username` kullanılır.

Polling UNSEEN flag'ine bağlı değildir. Her hesap için `UIDVALIDITY` ve son başarıyla işlenen UID, `sync_cursors` içinde ayrı tutulur. İlk sync son 7 günle ve en yeni 500 mesajla sınırlıdır; sonraki sync cursor sonrasını alır. `UIDVALIDITY` değişince aynı sınırlı pencere yeniden taranır ve RFC `Message-ID` idempotency'si tekrarları engeller. `Message-ID` yoksa hesap + UIDVALIDITY + UID üzerinden deterministik ID üretilir.

Thread çözümü sırasıyla `In-Reply-To`, sonra `References` zincirini sondan başa kullanır; subject benzerliği thread birleştirmez. SMTP yanıtı conversation `reply_to` adresine (yoksa müşteri adresine) gider, tek bir `Re:` kullanır ve `In-Reply-To`/`References` başlıklarını korur. Her Hub mesajı için deterministik RFC Message-ID retry boyunca aynıdır. SMTP kabulü yalnız `SENT` sayılır; `DELIVERED` veya `READ` üretilmez.

Inbound HTML allowlist ile sanitize edilmeden saklanmaz; UI metin gövdesini kullanmaya devam eder. JPEG, PNG, WebP ve PDF ekleri attachment başına en fazla 10 MB olacak şekilde rastgele disk adı, normalize filename ve SHA-256 ile `ATTACHMENTS_DIR` altında saklanır. Desteklenmeyen/büyük ek atlanır, email korunur ve güvenli skip metadata'sı yazılır. Hub'dan outbound attachment gönderimi bu sürümün kapsamında değildir.

Development mock inbound, yalnız mock modu açıkken ve `manage_channels` izniyle `POST /api/dev/mock/inbound` üzerinden gönderilebilir. Bu endpoint production'da 404'tür.

## Yeni adapter geliştirme

1. `ChannelAdapter` arayüzünü `server/channels/core/types.ts` üzerinden uygula.
2. Yalnız gerçekten desteklenen capability'leri bildir; UI/servis bunlara güvenir.
3. `validateConfiguration` eksik credential'ı reddetmeli; credential loglamamalı.
4. Provider ID'lerini external idempotency anahtarı olarak koru.
5. Retry edilebilir hata için `ProviderError(..., true, code)` kullan.
6. Registry'ye ekle, normalization/capability/error mapping testlerini yaz.

Dokümante edilmemiş endpoint, scraping veya browser automation kullanılmaz. Email transport'ları account-scoped factory sınırının arkasındadır ve threading `Message-ID`, `In-Reply-To`, `References` sırasını kullanır.

## Güvenlik

Credential'lar AES-256-GCM ile şifrelenir ve API response'larına seçilmez. Helmet/CSP, same-origin CSRF kontrolü, login rate limit, 1 MB JSON ve 10 MB attachment limiti, MIME allowlist, filename normalization, HTTPS/DNS tabanlı SSRF koruması ve audit redaction bulunur. Remote download uygulanırken `assertSafeRemoteUrl` zorunludur. HTML email render edilmeden önce `sanitize-html` allowlist'i uygulanmalıdır; V1 UI ham `body_html` render etmez.

## Backup ve restore

Çalışan WAL DB klasörünü arşivlemek desteklenmez. Online backup `better-sqlite3 backup()` ile tutarlı snapshot üretir ve `PRAGMA integrity_check` çalıştırır.

```bash
docker compose exec dsdst-customer-hub /app/scripts/backup.sh
docker compose exec dsdst-customer-hub /app/scripts/restore-check.sh /data/backups/customer-hub-....db /data/backups/customer-hub-attachments-....tar.gz
```

Restore sırasında servisi durdurun, integrity kontrolü geçen DB'yi `DATABASE_PATH` konumuna ve attachment arşivini boş `ATTACHMENTS_DIR` içine açın; sahipliği container `node` kullanıcısına verin.

## Kalite kapıları

```bash
npm test
npm run typecheck
npm run build
```

CI bunlara ek olarak production `npm audit`, Gitleaks, Docker build ve Trivy HIGH/CRITICAL taraması çalıştırır. Kanal matrisi: [docs/channel-capabilities.md](docs/channel-capabilities.md). Operations entegrasyonu: [docs/operations-integration.md](docs/operations-integration.md).
