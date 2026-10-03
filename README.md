# mint-bot

Bot auto-mint NFT untuk **semua koleksi drop OpenSea** di chain mana pun. Node.js + `viem`.

## Fitur

- 🔄 Multi-wallet sekaligus (private key dipisah koma)
- 🌐 Multi-chain otomatis — chain dibaca dari API OpenSea (Ethereum, Base, Polygon, Robinhood Chain, dll.)
- 🎯 Pilih phase: `--phase "OG List"` — hanya mint saat phase itu aktif (`--fire` menolak kalau belum aktif, `--wait` menunggu sampai dibuka)
- ✅ Aturan aman: mint **gratis** auto-jalan, mint **berbayar** wajib persetujuan user dulu
- 📲 Bisa dikontrol via Telegram (opsional)

## Instalasi

Butuh Node.js 18+.

```bash
npm install
cp .env.example .env
# isi .env (lihat bawah), lalu:
node bot.mjs --check
```

## Konfigurasi (`.env`)

```ini
OPENSEA_API_KEY=            # API key dari https://docs.opensea.io/reference/api-keys
PRIVATE_KEYS=0x...,0x...    # private key tiap wallet, dipisah koma tanpa spasi
TELEGRAM_BOT_TOKEN=         # opsional, untuk notifikasi
TELEGRAM_CHAT_ID=           # opsional
TG_QUIET=true
AUTO_MINT_PAID=false        # JANGAN ubah tanpa persetujuan eksplisit user
RPC_URL=https://rpc.mainnet.chain.robinhood.com
DROP_SLUG=aerent
QUANTITY=1
POLL_MS=5000
MAX_WAIT_MINUTES=120
```

> ⚠️ Jangan pernah commit file `.env` ke Git!

## Cara pakai

```bash
node bot.mjs --check [--slug <s>] [--qty <n>] [--phase "<label>"]   # cek eligibility + harga
node bot.mjs --fire  [--slug <s>] [--qty <n>] [--phase "<label>"]   # mint sekarang
node bot.mjs --wait  [--slug <s>] [--qty <n>] [--phase "<label>"]   # tunggu drop/phase dibuka, auto-mint
node bot.mjs --dry-run [--slug <s>]                                 # simulasi tanpa kirim tx
```

- `--slug` bisa nama koleksi atau URL `opensea.io/collection/<slug>`.
- `--phase "<label>"` mis. `"OG List"`: bot hanya mint saat phase itu aktif.
- Contoh: `node bot.mjs --fire --slug doodles --qty 2`

## Cara kerja

Mengambil transaksi mint siap-sign per wallet via `POST /api/v2/drops/{slug}/mint` (OpenSea memilihkan stage aktif + signature/proof server-side). HTTP 422 = belum eligible *saat ini* — bot tetap polling, bukan skip.

## Aturan keras

1. Mint **gratis** (`value=0`) → auto-mint langsung.
2. Mint **berbayar** → bot berhenti, tampilkan harga per wallet + total, minta persetujuan user dulu.
3. Jangan pernah menampilkan private key / token / API key.

## Lisensi

MIT
