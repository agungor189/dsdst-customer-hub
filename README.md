# DSDST Customer Hub

DSDST'nin bağımsız Customer Hub / omnichannel inbox uygulaması. Panel kullanıcılarını kullanır; kanal hesapları, müşteriler, kimlikler, konuşmalar, mesajlar, ekler, etiketler, notlar, senkronizasyon ve audit verisinin sahibi kendi SQLite veritabanıdır. Panel veritabanını hiçbir zaman açmaz.

## Mimari

```text
Browser ── same-origin cookie ──> Customer Hub (Express + React)
                                      │
                       /api/auth/* ────┼──> Panel HTTP API
                                      │
             webhooks / polling ──> adapters ──> channel providers
      website widget / public API ──> first-party Website adapter
                                      │
                              SQLite WAL + /data/attachments
                                      │
                        outbox worker / sync scheduler
```

- `server/auth`: Panel login proxy, her istekte `/api/auth/me`, server-side izin kontrolü.
- `server/channels`: capability tabanlı adapter registry; gerçek Instagram Messaging, Facebook Messenger, WhatsApp Cloud, Email IMAP/SMTP, Website ve Trendyol adapter'ları ile diğer kanal temelleri.
- `server/messages`: inbound normalizasyonu ve webhook/external message idempotency.
- `server/outbox`: atomik kuyruğa alma, local claim kilidi ve retry/backoff. SMTP protokolü gerçek exactly-once garantisi vermez; retry aynı deterministik Message-ID'yi kullanır.
- `server/db`: sıralı migrations; WAL, foreign keys ve busy timeout.
- `src/features`: inbox, conversations, contacts ve auth arayüzleri.
- `shared`: istemci/sunucu ortak domain tipleri ve Zod şemaları.

Provider foundation adapter'ları gerçek credential olmadan `NOT_CONFIGURED` kalır; sahte başarı dönmez. Instagram Messaging, Facebook Messenger, WhatsApp Cloud API, Email ve first-party Website chat gerçek adapter kullanır.

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

Meta callback: `https://<hub-host>/api/webhooks/meta`. Instagram, Facebook Messenger ve WhatsApp aynı callback'i kullanır. GET challenge `META_WEBHOOK_VERIFY_TOKEN`; POST body `META_APP_SECRET` ile `X-Hub-Signature-256` HMAC-SHA256 doğrulanır. Event önce `webhook_events` içine unique provider/event id ile yazılır, ardından external account/conversation/message ID kapsamlarında upsert edilir. İmzasız payload işlenmez. App secret, verify token ve provider access token değerleri webhook metadata'sına, audit'e veya hata kaydına yazılmaz.

WhatsApp kanal hesabı credential şeması `access_token`, `phone_number_id`, opsiyonel `business_account_id` ve `vXX.X` biçiminde `graph_api_version` alanlarından oluşur. `channel_accounts.external_account_id`, aynı `phone_number_id` değerini taşımalıdır. Serbest metin yanıtı yalnız son inbound WhatsApp mesajından sonraki 24 saat içinde kuyruğa alınır; worker göndermeden hemen önce pencereyi yeniden kontrol eder. Template gönderimi ve inbound medya binary indirme bu sürümün kapsamında değildir.

### Facebook Messenger

Facebook hesabı için bir Facebook Page, Page access token, `pages_messaging` izni ve Meta app/Page webhook kurulumu gerekir. Credential şeması:

```json
{
  "access_token": "<page-access-token>",
  "page_id": "<facebook-page-id>",
  "graph_api_version": "vXX.X"
}
```

Üç alan da zorunludur; `external_account_id`, `page_id` ile aynı olmalıdır. Metin yanıtları yapılandırılan Graph sürümünde `/{page_id}/messages` adresine Bearer auth ile gider ve provider `message_id` değeri saklanır. Standart `RESPONSE` mesajı yalnız son müşteri inbound mesajından sonraki 24 saat içinde kuyruğa alınır; worker göndermeden hemen önce aynı kontrolü tekrarlar. Sponsored messages, notification token ve Human Agent yolu bu sürümde yoktur. `mark_seen` desteklenir. Delivery event'inde provider message ID bulunduğunda `DELIVERED` uygulanır; message ID taşımayan watermark-only read event'inden sahte `READ` üretilmez.

### Instagram Messaging

Instagram için bir Professional Account, ilgili Instagram messaging izni, geçerli access token ve Meta webhook kurulumu gerekir. Credential şeması:

```json
{
  "access_token": "<instagram-access-token>",
  "ig_account_id": "<instagram-professional-account-id>",
  "graph_api_version": "vXX.X"
}
```

`ig_account_id` zorunlu canonical alandır; geçiş uyumluluğu için eski `account_id` alanı alias olarak kabul edilir. `external_account_id`, çözülen Instagram account ID ile aynı olmalıdır. Metin yanıtları `graph.instagram.com/{graph_api_version}/{ig_account_id}/messages` adresine gider. Yalnız daha önce bu Professional Account'a inbound mesaj göndermiş exact scoped user/conversation kimliğine yanıt verilebilir; unsolicited/promotional messaging uygulanmaz. Resmi ve kesin bir mark-read sözleşmesi kullanılmadığı için Instagram `MARK_READ` capability'si ilan etmez.

Facebook ve Instagram inbound attachment binary'leri indirilmez. Mesaj, `[Görsel]`, `[Video]`, `[Ses]`, `[Belge]`, `[Sticker]` veya `[Paylaşım]` placeholder'ı ve yalnız tip/provider ID/URL/title güvenli metadata alt kümesiyle korunur. Her iki adapter'daki `CUSTOMER_PROFILE` capability'si bu sürümde webhook sender identity'sinin Hub contact/identity modeline dönüştürülmesi ve provider-specific fallback adını ifade eder; ayrı bir profile API lookup çağrısı yapılmaz.

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

## Website Live Chat

Website kanalı Shopify Inbox veya dış bir mesaj sağlayıcısı kullanmaz. Widget mesajları Hub'ın public API'sine gelir; agent yanıtı mevcut `queueReply → outbox → WebsiteAdapter` hattından geçer ve Hub veritabanında widget teslimatına hazır olur. Widget fetch'i `DELIVERED`, görünür thread'in read ACK'i `READ` statüsü üretir. Adapter hiçbir external send endpoint'ine HTTP çağrısı yapmaz.

Website kanal hesabı `external_account_id = site_id` olacak şekilde oluşturulur. `allowed_origins`, wildcard içermeyen exact HTTPS origin'lerinden oluşan JSON array string'idir; yalnız lokal geliştirmede localhost HTTP kabul edilir. `widget_secret` opsiyoneldir ve verildiğinde en az 16 karakter olmalıdır.

```json
{
  "channel_type": "WEBSITE",
  "name": "DSDST Shopify TR",
  "external_account_id": "dsdst-shopify-tr",
  "credentials": {
    "site_id": "dsdst-shopify-tr",
    "site_name": "DSDST",
    "allowed_origins": "[\"https://dsdst.com\",\"https://dsdst.myshopify.com\"]"
  }
}
```

Public API panel cookie/login istemez; bunun yerine exact origin, `X-DSDST-Site-ID`, opaque Bearer session token, IP/session rate limitleri, Zod payload sınırları ve repeated-message koruması uygular:

- `POST /api/public/chat/session`
- `POST /api/public/chat/messages`
- `GET /api/public/chat/messages`
- `POST /api/public/chat/read`

Session token 256-bit kriptografik rastgele üretilir; veritabanında yalnız SHA-256 hash'i ve 30 günlük expiry tutulur. Token URL'ye yazılmaz ve account + oluşturulduğu exact origin kapsamından çıkarılamaz. Widget cookie, Shopify customer tokenı, Panel anahtarı, Hub encryption key'i veya Shopify Admin tokenı almaz. Mesaj gövdesi plain text saklanır ve widget tarafından yalnız `textContent` ile render edilir. İsim/e-posta/telefon opsiyoneldir; email lowercase, telefon güvenli karşılaştırma biçimine normalize edilir. Ürün sayfası context'i yalnız açıkça izin verilen product/page alanlarıyla conversation metadata'sına eklenir.

### Shopify kurulumu

Önce `npm run build` ile `dist/widget/dsdst-chat.js` üretin ve Hub'ı örneğin `https://hub.dsdst.com` altında yayınlayın. Shopify theme Custom Liquid alanına veya kapanış `</body>` öncesine şunu ekleyin:

```liquid
<script
  src="https://hub.dsdst.com/widget/dsdst-chat.js"
  data-site-id="dsdst-shopify-tr"
  data-product-id="{{ product.id }}"
  data-product-handle="{{ product.handle | escape }}"
  data-product-title="{{ product.title | escape }}"
  data-variant-id="{{ product.selected_or_first_available_variant.id }}"
  defer>
</script>
```

Hub URL'si widget bundle'ında hardcode değildir; API origin'i varsayılan olarak script `src` origin'inden türetilir. Ayrı API hostu gerekiyorsa `data-api-base="https://hub.dsdst.com"` kullanılabilir. Sıkı CSP kullanan mağazalar Hub origin'ini `script-src` ve `connect-src` allowlist'lerine eklemelidir; nonce tabanlı CSP'de script'e verilen nonce widget style elementi tarafından da devralınır. Hub widget dosyasını `Cross-Origin-Resource-Policy: cross-origin` ile sunar. Bu repository değişikliği Shopify temasına veya production domain'e otomatik deploy yapmaz.

İlk sürüm 2,5 saniyelik kısa polling kullanır. Attachment capability kanal mimarisinde korunur ancak public upload endpoint'i ve widget attachment butonu bu sürümde yoktur. Agent online/offline presence ve CAPTCHA da henüz uygulanmaz.

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
