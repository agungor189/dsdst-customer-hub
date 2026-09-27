# Kanal capability matrisi

`✓` adapter sözleşmesinde desteklenir; `—` bilinçli olarak sunulmaz. Foundation bulunması, provider credential olmadan hesabın aktif olduğu anlamına gelmez.

| Kanal | READ | SEND | ATTACHMENT | WEBHOOK | POLLING | Not |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Instagram | ✓ | ✓ | ✓ | ✓ | — | Meta foundation; credential zorunlu |
| Facebook Messenger | ✓ | ✓ | ✓ | ✓ | — | Meta foundation; credential zorunlu |
| WhatsApp Business | ✓ | ✓ | ✓ | ✓ | — | Cloud API; 24 saatlik serbest yanıt penceresi queue ve send aşamasında uygulanır |
| Email | ✓ | ✓ | ✓ | — | ✓ | Gerçek IMAP UID polling + SMTP text reply; RFC header threading, 10 MB güvenli inbound ek limiti |
| Website | ✓ | ✓ | ✓ | ✓ | — | İmzalı webhook ve yapılandırılmış send endpoint |
| Trendyol | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| n11 | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| Manual | ✓ | — | — | — | — | Dış URL + dahili not/geçmiş; reply UI gizli |

Ek capability'ler: Meta kanalları `MARK_READ` ve `CUSTOMER_PROFILE`; Email `CUSTOMER_PROFILE`; Trendyol/n11 `PRODUCT_QUESTIONS`. Provider dokümantasyonu doğrulanmadan capability eklenmez.

Email WEBHOOK capability'si sunmaz. Her hesap ayrı credential ve `sync_cursors` kapsamıyla poll edilir; singleton adapter hesap state'i taşımaz. SMTP kabulü `SENT` olarak kaydedilir, teslim/okunma durumu varsayılmaz. Outbound attachment ayrı bir feature'dır.
