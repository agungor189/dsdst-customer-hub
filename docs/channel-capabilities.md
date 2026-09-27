# Kanal capability matrisi

`✓` adapter sözleşmesinde desteklenir; `—` bilinçli olarak sunulmaz. Foundation bulunması, provider credential olmadan hesabın aktif olduğu anlamına gelmez.

| Kanal | READ | SEND | ATTACHMENT | WEBHOOK | POLLING | Not |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Instagram | ✓ | ✓ | ✓ | ✓ | — | Instagram Login Messaging API; inbound başlatılmış conversation zorunlu, unsolicited mesaj yok |
| Facebook Messenger | ✓ | ✓ | ✓ | ✓ | — | Page Messaging API; 24 saatlik standart reply penceresi queue ve send aşamasında |
| WhatsApp Business | ✓ | ✓ | ✓ | ✓ | — | Cloud API; 24 saatlik serbest yanıt penceresi queue ve send aşamasında uygulanır |
| Email | ✓ | ✓ | ✓ | — | ✓ | Gerçek IMAP UID polling + SMTP text reply; RFC header threading, 10 MB güvenli inbound ek limiti |
| Website | ✓ | ✓ | ✓ | ✓ | — | İmzalı webhook ve yapılandırılmış send endpoint |
| Trendyol | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| n11 | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| Manual | ✓ | — | — | — | — | Dış URL + dahili not/geçmiş; reply UI gizli |

Ek capability'ler: Facebook Messenger ve WhatsApp `MARK_READ`; Instagram, Facebook, WhatsApp ve Email `CUSTOMER_PROFILE`; Trendyol/n11 `PRODUCT_QUESTIONS`. Instagram kesin bir resmi mark-read sözleşmesi kullanılmadığı için `MARK_READ` ilan etmez. Meta adapter'larında `CUSTOMER_PROFILE`, webhook sender identity'sinin contact/identity modeline alınması ve fallback display name anlamındadır; bu sürüm ayrı profile API fetch'i yapmaz. Provider dokümantasyonu doğrulanmadan capability eklenmez.

Instagram ve Facebook tek `/api/webhooks/meta` callback'ini WhatsApp ile paylaşır; GET verify token ve POST `X-Hub-Signature-256` doğrulaması ortaktır. Echo/self event'leri müşteri inbound mesajı oluşturmaz. Remote media binary indirilmez; attachment placeholder ve güvenli provider metadata alt kümesi saklanır. Facebook provider message ID içeren delivery event'leri generic status mekanizmasına gider; watermark-only read event'i message ID taşımadığı için sahte `READ` oluşturulmaz. Instagram için provider status desteği varsayılmaz.

Email WEBHOOK capability'si sunmaz. Her hesap ayrı credential ve `sync_cursors` kapsamıyla poll edilir; singleton adapter hesap state'i taşımaz. SMTP kabulü `SENT` olarak kaydedilir, teslim/okunma durumu varsayılmaz. Outbound attachment ayrı bir feature'dır.
