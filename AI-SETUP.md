# Instruksi AI: Bot Auto-Mint NFT (OpenSea Drops)

Tempel seluruh dokumen ini ke AI, lalu minta ia mengoperasikan bot mint NFT mengikuti instruksi di bawah.

## 1. Gambaran

Bot Node.js (library `viem`) untuk auto-mint NFT dari **OpenSea Drops API**.
Bisa dipakai untuk **SEMUA koleksi drop OpenSea di chain mana pun** — chain dibaca otomatis dari API, tidak hardcode.

File yang dibutuhkan: `bot.mjs`, `package.json` (dependencies: `viem`, `dotenv`), dan `.env`.

## 2. Cara kerja

- Ambil transaksi mint siap-sign per wallet via:
  `POST https://api.opensea.io/api/v2/drops/{slug}/mint`
  header `x-api-key: <OPENSEA_API_KEY>`, body JSON `{ "address": "<wallet>", "quantity": <n> }`
- OpenSea yang memilihkan stage aktif + menyediakan signature/proof server-side.
- Chain dideteksi dari `GET https://api.opensea.io/api/v2/drops/{slug}` (field `chain`), lalu mapping ke viem chain.
- **HTTP 422 bukan vonis final**: artinya belum eligible *saat ini* (bisa jadi stage-nya belum giliran). Jangan skip — polling terus sampai timeout.
- Slug boleh nama koleksi (`aerent`) atau URL (`https://opensea.io/collection/aerent`).

## 3. Mode operasi

```
node bot.mjs --check [--slug <s>] [--qty <n>] [--phase "<label>"]   cek eligibility + harga, tanpa kirim tx
node bot.mjs --fire  [--slug <s>] [--qty <n>] [--phase "<label>"]   ambil tx dari OpenSea & kirim sekarang
node bot.mjs --wait  [--slug <s>] [--qty <n>] [--phase "<label>"]   polling sampai drop/phase aktif, lalu auto-mint
node bot.mjs --dry-run [--slug <s>]                                 simulasi eth_call tanpa kirim tx
```

`--phase "<label>"` (mis. `"OG List"`): bot HANYA mint saat phase itu yang aktif.
`--fire` menolak mentah-mentah kalau phase belum aktif; `--wait` menunggu sampai phase itu dibuka baru mint.
Tanpa `--phase`, bot memakai stage aktif apa pun (perilaku default).

## 4. Template `.env` (isi sendiri, JANGAN bagikan yang sudah terisi)

```
OPENSEA_API_KEY=
PRIVATE_KEYS=0x...,0x...        # private key tiap wallet, dipisah koma tanpa spasi
TELEGRAM_BOT_TOKEN=            # opsional, untuk notifikasi
TELEGRAM_CHAT_ID=              # opsional
TG_QUIET=true                  # true = bot diam kecuali hal kritis
AUTO_MINT_PAID=false           # JANGAN ubah tanpa persetujuan user (lihat aturan)
RPC_URL=https://rpc.mainnet.chain.robinhood.com
DROP_SLUG=aerent
QUANTITY=1
POLL_MS=5000
MAX_WAIT_MINUTES=120
```

## 5. ATURAN KERAS (wajib dipatuhi AI)

1. **Mint GRATIS** (`value=0`) → auto-mint langsung, tidak perlu tanya.
2. **Mint BERBAYAR** → JANGAN kirim transaksi. Berhenti, tampilkan harga per wallet + total, dan **minta persetujuan eksplisit user dulu**.
3. Jangan pernah set `AUTO_MINT_PAID=true` tanpa persetujuan eksplisit user.
4. Jangan pernah menampilkan, mengutip, atau membocorkan private key, token, chat ID, atau API key dalam bentuk apa pun.
5. Kalau user bilang "batal"/"stop", hentikan bot segera.

## 6. Perintah chat yang umum dipakai user

- `cek <nama/link koleksi>` → jalankan `--check`, laporkan eligibility + harga per wallet.
- `mint <nama/link koleksi>` → jalankan `--fire` (ikut aturan gratis/bayar di atas).
- `jadwal mint <nama> jam <HH:MM>` → jadwalkan `--wait` ~25 menit sebelumnya.
- `status` → cek status drop + bot, jawab ringkas.
