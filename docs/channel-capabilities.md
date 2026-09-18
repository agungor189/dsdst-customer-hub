# Kanal capability matrisi

`✓` adapter sözleşmesinde desteklenir; `—` bilinçli olarak sunulmaz. Foundation bulunması, provider credential olmadan hesabın aktif olduğu anlamına gelmez.

| Kanal | READ | SEND | ATTACHMENT | WEBHOOK | POLLING | Not |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Instagram | ✓ | ✓ | ✓ | ✓ | — | Meta foundation; credential zorunlu |
| Facebook Messenger | ✓ | ✓ | ✓ | ✓ | — | Meta foundation; credential zorunlu |
| WhatsApp Business | ✓ | ✓ | ✓ | ✓ | — | 24 saat/template kısıtı adapter validation katmanında uygulanır |
| Email | ✓ | ✓ | ✓ | — | ✓ | IMAP/SMTP provider interface |
| Website | ✓ | ✓ | ✓ | ✓ | — | İmzalı webhook ve yapılandırılmış send endpoint |
| Trendyol | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| n11 | ✓ | ✓ | — | — | ✓ | `PRODUCT_QUESTION`, klasik DM değil |
| Manual | ✓ | — | — | — | — | Dış URL + dahili not/geçmiş; reply UI gizli |

Ek capability'ler: Meta kanalları `MARK_READ` ve `CUSTOMER_PROFILE`; Trendyol/n11 `PRODUCT_QUESTIONS`. Provider dokümantasyonu doğrulanmadan capability eklenmez.
