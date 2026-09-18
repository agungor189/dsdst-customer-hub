# Architecture decisions

- Panel; kullanıcı, izin, ürün/SKU, stok ve satışın source of truth'üdür. Hub yalnız Panel HTTP API'sini kullanır.
- Hub SQLite; channel account, contact identity, conversation, message, attachment, outbox, sync cursor, webhook ve audit kayıtlarının source of truth'üdür.
- Inbound tam sırası: signature → durable webhook event → account/identity/conversation upsert → message insert → unread/status update. Transaction başarısızsa event processed olmaz.
- Outbound tam sırası: authorization → message `QUEUED` + unique client ID → unique outbox job → atomic claim → adapter → `SENT` veya backoff. Provider'a `messageId` idempotency anahtarı verilir.
- Contact merge, conversation ve identity FK'lerini tek transaction içinde taşır; `contact_merge_events.snapshot_json` geri alma için gereken önceki kimlikleri saklar.
- Panel outage mesaj depolama/outbox/listeme akışını etkilemez. Yalnız customer context `unavailable` olur.
- Kanal outage hesabı degraded yapabilir; scheduler diğer hesapları işlemeye devam eder.
- AI entegrasyonu V1'de provider interface için ayrılmıştır; otomatik send yolu yoktur. UI taslak düğmesi provider eklenene kadar disabled'dır.
