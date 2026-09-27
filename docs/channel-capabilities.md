# Kanal capability matrisi

`✓` adapter sözleşmesinde desteklenir; `—` bilinçli olarak sunulmaz. Foundation bulunması, provider credential olmadan hesabın aktif olduğu anlamına gelmez.

| Kanal | READ | SEND | ATTACHMENT | WEBHOOK | POLLING | Not |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Instagram | ✓ | ✓ | ✓ | ✓ | — | Instagram Login Messaging API; inbound başlatılmış conversation zorunlu, unsolicited mesaj yok |
| Facebook Messenger | ✓ | ✓ | ✓ | ✓ | — | Page Messaging API; 24 saatlik standart reply penceresi queue ve send aşamasında |
| WhatsApp Business | ✓ | ✓ | ✓ | ✓ | — | Cloud API; 24 saatlik serbest yanıt penceresi + pencere dışında approved template gönderimi |
| Email | ✓ | ✓ | ✓ | — | ✓ | Gerçek IMAP UID polling + SMTP text reply; RFC header threading, 10 MB güvenli inbound ek limiti |
| Website | ✓ | ✓ | ✓ | ✓ | — | First-party public chat API + local delivery queue; dış provider/send endpoint yok |
| Trendyol | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| n11 | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| Manual | ✓ | — | — | — | — | Dış URL + dahili not/geçmiş; reply UI gizli |

Ek capability'ler: Facebook Messenger ve WhatsApp `MARK_READ`; Instagram, Facebook, WhatsApp ve Email `CUSTOMER_PROFILE`; Trendyol/n11 `PRODUCT_QUESTIONS`. Instagram kesin bir resmi mark-read sözleşmesi kullanılmadığı için `MARK_READ` ilan etmez. Meta adapter'larında `CUSTOMER_PROFILE`, webhook sender identity'sinin contact/identity modeline alınması ve fallback display name anlamındadır; bu sürüm ayrı profile API fetch'i yapmaz. Provider dokümantasyonu doğrulanmadan capability eklenmez.

Instagram ve Facebook tek `/api/webhooks/meta` callback'ini WhatsApp ile paylaşır; GET verify token ve POST `X-Hub-Signature-256` doğrulaması ortaktır. Echo/self event'leri müşteri inbound mesajı oluşturmaz. Remote media binary indirilmez; attachment placeholder ve güvenli provider metadata alt kümesi saklanır. Facebook provider message ID içeren delivery event'leri generic status mekanizmasına gider; watermark-only read event'i message ID taşımadığı için sahte `READ` oluşturulmaz. Instagram için provider status desteği varsayılmaz.

WhatsApp normal text yanıtında 24 saatlik customer-service window queue ve worker send aşamalarında korunur. Approved template mesajı bu kurala tabi değildir ve aynı local outbox idempotency/retry garantilerini kullanır. Template listeleme WABA (`business_account_id`) kapsamındadır; gönderim conversation'ın bağlı olduğu aynı account'un `phone_number_id` endpoint'ine yapılır. İlk sürüm BODY text ve HEADER text runtime parametrelerini destekler; media header, dinamik button/Flow, catalog ve location desteklemez. Template create/edit/delete veya Meta approval işlemleri Hub'da yapılmaz; template Meta WhatsApp Manager'da oluşturulup onaylanmalıdır.

Email WEBHOOK capability'si sunmaz. Her hesap ayrı credential ve `sync_cursors` kapsamıyla poll edilir; singleton adapter hesap state'i taşımaz. SMTP kabulü `SENT` olarak kaydedilir, teslim/okunma durumu varsayılmaz. Outbound attachment ayrı bir feature'dır.

Website, DSDST'nin kendi first-party kanalıdır. `site_id` ile eşleşen `external_account_id`, `site_name` ve wildcard içermeyen exact `allowed_origins` listesi zorunludur. Public session tokenı yalnız hash olarak saklanır, 30 günde sona erer ve hesap + origin kapsamlıdır. Public endpoint'lerde IP/session rate limitleri, Zod sınırları, idempotency ve hızlı aynı mesaj tekrarı koruması bulunur. Agent reply generic outbox'tan geçip `SENT` olur; widget fetch'i `DELIVERED`, visible read ACK'i `READ` yapar ve generic statü sıralaması downgrade'i engeller. Widget şu an kısa polling kullanır. Capability matrisi gelecekteki attachment akışına izin verse de bu sürüm public upload veya attachment UI sunmaz.
