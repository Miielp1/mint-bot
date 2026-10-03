#!/usr/bin/env node
// AERENT OG Pass auto-mint bot — Robinhood Chain (4663), 4 whitelisted wallets.
// Cara pakai:
//   node bot.mjs --check [--slug <slug>] [--qty <n>] [--phase <nama>]   cek eligibility (tanpa kirim tx)
//   node bot.mjs --fire  [--slug <slug>] [--qty <n>] [--phase <nama>]   ambil tx dari OpenSea & kirim sekarang
//   node bot.mjs --wait  [--slug <slug>] [--qty <n>] [--phase <nama>]   tunggu sampai drop/phase aktif, lalu auto-mint
//   node bot.mjs --dry-run [--slug <slug>]                            simulasi (eth_call) tanpa kirim tx
// Slug bisa nama koleksi atau URL opensea.io/collection/<slug>. Default: aerent.
// --phase "<label>" (mis. "OG List"): hanya mint saat phase itu yang aktif.
//   --fire menolak kalau phase belum aktif; --wait menunggu phase itu dibuka.
import "dotenv/config";
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import {
  mainnet, base, polygon, arbitrum, optimism, avalanche, bsc, zora,
} from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const slugFromUrl = (s) => {
  const m = String(s || "").match(/opensea\.io\/collection\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : String(s || "").trim();
};

const OS_KEY = process.env.OPENSEA_API_KEY;
const KEYS = (process.env.PRIVATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SLUG = slugFromUrl(getFlag("--slug") || process.env.DROP_SLUG || "aerent");
const QTY = parseInt(getFlag("--qty") || process.env.QUANTITY || "1", 10);
const PHASE = getFlag("--phase") || null; // label phase, mis. "OG List"
const POLL_MS = parseInt(process.env.POLL_MS || "5000", 10);
const MAX_WAIT_MS = parseInt(process.env.MAX_WAIT_MINUTES || "120", 10) * 60_000;
const OS_BASE = "https://api.opensea.io";
// Aturan: mint GRATIS (value=0) boleh auto-fire. Mint BERBAYAR wajib persetujuan user dulu.
const AUTO_MINT_PAID = (process.env.AUTO_MINT_PAID || "false").toLowerCase() === "true";

if (!OS_KEY) { console.error("OPENSEA_API_KEY belum diisi di .env"); process.exit(1); }
if (KEYS.length === 0) { console.error("PRIVATE_KEYS belum diisi di .env"); process.exit(1); }

const robinhoodChain = (rpc) => defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});
// nama chain versi OpenSea -> viem chain
const CHAIN_MAP = {
  ethereum: mainnet, base, matic: polygon, polygon,
  arbitrum, optimism, avalanche, bsc, zora,
};

// Chain dibaca dari info drop OpenSea, jadi bot bisa dipakai untuk koleksi di chain mana pun.
async function resolveChain() {
  const res = await fetch(`${OS_BASE}/api/v2/drops/${SLUG}`, {
    headers: { "x-api-key": OS_KEY, "accept": "application/json" },
  });
  if (!res.ok) throw new Error(`gagal baca info drop "${SLUG}": HTTP ${res.status}`);
  const j = await res.json();
  const name = String(j.chain || "").toLowerCase();
  if (name === "robinhood") return { chain: robinhoodChain(RPC_URL), rpc: RPC_URL, label: j.chain };
  const c = CHAIN_MAP[name];
  if (!c) throw new Error(`chain "${j.chain}" belum didukung bot ini`);
  return { chain: c, rpc: null, label: j.chain }; // rpc null = pakai RPC publik bawaan viem
}

const { chain: CHAIN, rpc: CHAIN_RPC, label: CHAIN_LABEL } = await resolveChain();
const transport = CHAIN_RPC ? http(CHAIN_RPC) : http();
const publicClient = createPublicClient({ chain: CHAIN, transport });
const accounts = KEYS.map(k => privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k));
const walletClients = accounts.map(a => createWalletClient({ account: a, chain: CHAIN, transport }));

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Notifikasi Telegram (opsional). Isi TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID di .env.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
// TG_QUIET=true: bot diam kecuali hal kritis (minta persetujuan). Jawaban lain hanya kalau user chat.
const TG_QUIET = (process.env.TG_QUIET || "true").toLowerCase() === "true";
async function tg(text, critical = false) {
  if (!TG_TOKEN || !TG_CHAT) return;
  if (TG_QUIET && !critical) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch { /* notif gagal bukan alasan bot berhenti */ }
}
const EXPLORER = CHAIN.blockExplorers.default.url.replace(/\/$/, "") + "/tx/";

// Minta tx mint siap-sign ke OpenSea Drops API.
// OpenSea yang milih stage (allowlist/signed/public) + proof-nya server-side.
async function buildMintTx(minter, quantity) {
  const res = await fetch(`${OS_BASE}/api/v2/drops/${SLUG}/mint`, {
    method: "POST",
    headers: { "x-api-key": OS_KEY, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ minter, quantity }),
  });
  const text = await res.text();
  if (res.status === 200) return { ok: true, tx: JSON.parse(text) };
  return { ok: false, status: res.status, body: text.slice(0, 200) };
}

function describeErr(r) {
  if (r.status === 422) return "NOT_ELIGIBLE (wallet tidak masuk whitelist / limit tercapai)";
  if (r.status === 409) return "DROP_INACTIVE (drop belum dibuka)";
  if (r.status === 401) return "API key salah / tidak punya akses Drops API";
  if (r.status === 404) return "drop tidak ditemukan";
  return `HTTP ${r.status}: ${r.body}`;
}

async function sendMint(walletClient, account, txData, dryRun) {
  const to = txData.to, data = txData.data, value = BigInt(txData.value ?? "0x0");
  if (dryRun) {
    // simulasi tanpa kirim
    await publicClient.call({ account: account.address, to, data, value });
    return { simulated: true };
  }
  const [fees, gas, bal] = await Promise.all([
    publicClient.estimateFeesPerGas(),
    publicClient.estimateGas({ account: account.address, to, data, value }),
    publicClient.getBalance({ address: account.address }),
  ]);
  const gasLimit = gas * 120n / 100n;
  const maxCost = gasLimit * (fees.maxFeePerGas ?? 0n) + value;
  if (bal < maxCost) throw new Error(`saldo kurang: punya ${bal} wei, butuh ~${maxCost} wei`);
  const hash = await walletClient.sendTransaction({
    account, to, data, value, chain: CHAIN,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return { hash };
}

async function fireWallet(i, dryRun) {
  const account = accounts[i], wc = walletClients[i];
  log(`wallet[${i}] ${account.address}: minta tx ke OpenSea...`);
  const r = await buildMintTx(account.address, QTY);
  if (!r.ok) { log(`wallet[${i}] ${account.address}: GAGAL ambil tx — ${describeErr(r)}`); return { i, ok: false, reason: describeErr(r) }; }
  const priceWei = BigInt(r.tx.value ?? "0x0");
  const priceEth = Number(priceWei) / 1e18;
  log(`wallet[${i}] ${account.address}: tx diterima (to=${r.tx.to}, harga=${priceEth} ETH)`);
  if (priceWei > 0n && !AUTO_MINT_PAID) {
    log(`wallet[${i}] ${account.address}: ⛔ MINT BERBAYAR (${priceEth} ETH) — butuh persetujuan user, tx TIDAK dikirim.`);
    return { i, ok: false, paid: true, priceEth };
  }
  try {
    const res = await sendMint(wc, account, r.tx, dryRun);
    if (res.simulated) { log(`wallet[${i}] ${account.address}: SIMULASI OK (eth_call sukses)`); return { i, ok: true, simulated: true }; }
    log(`wallet[${i}] ${account.address}: TX TERKIRIM ${res.hash}`);
    await tg(`🚀 Mint terkirim\nwallet: ${account.address}\ntx: ${EXPLORER}${res.hash}`);
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: res.hash, timeout: 120_000 });
    const okTx = rcpt.status === "success";
    log(`wallet[${i}] ${account.address}: ${okTx ? "MINT SUKSES ✅" : "TX GAGAL ❌"} (block ${rcpt.blockNumber})`);
    await tg(okTx
      ? `✅ MINT SUKSES\nwallet: ${account.address}\ntx: ${EXPLORER}${res.hash}`
      : `❌ TX GAGAL (reverted)\nwallet: ${account.address}\ntx: ${EXPLORER}${res.hash}`);
    return { i, ok: okTx, hash: res.hash };
  } catch (e) {
    log(`wallet[${i}] ${account.address}: ERROR — ${e.message?.slice(0, 160)}`);
    await tg(`❌ ERROR wallet ${account.address}\n${e.message?.slice(0, 200)}`);
    return { i, ok: false, reason: e.message?.slice(0, 160) };
  }
}

// ---------- Phase selection ----------
async function getDropInfo() {
  const res = await fetch(`${OS_BASE}/api/v2/drops/${SLUG}`, {
    headers: { "x-api-key": OS_KEY, "accept": "application/json" },
  });
  if (!res.ok) throw new Error(`gagal baca info drop "${SLUG}": HTTP ${res.status}`);
  return res.json();
}
function findStage(info, label) {
  const q = String(label).toLowerCase();
  const stages = info.stages || [];
  const hit = stages.filter(s => String(s.label || "").toLowerCase().includes(q));
  if (hit.length === 0) {
    const names = stages.map(s => s.label).join(", ") || "(tidak ada)";
    throw new Error(`phase "${label}" tidak ditemukan. Phase tersedia: ${names}`);
  }
  if (hit.length > 1) log(`peringatan: "${label}" cocok ke ${hit.length} phase, pakai "${hit[0].label}"`);
  return hit[0];
}
function stageActiveNow(stage, activeStage) {
  if (activeStage && activeStage.uuid && stage.uuid && activeStage.uuid === stage.uuid) return true;
  const now = Date.now();
  const start = new Date(stage.start_time).getTime();
  const end = new Date(stage.end_time).getTime();
  return now >= start && now < end;
}
function fmtStage(s) {
  const price = (Number(BigInt(s.price || "0")) / 1e18).toString();
  return `"${s.label}" [${s.stage_type}] harga=${price} ETH max/wallet=${s.max_per_wallet} | ${s.start_time} → ${s.end_time}`;
}
// Gate untuk --fire/--wait: pastikan phase yang diminta memang aktif sekarang.
async function requireActivePhase() {
  const info = await getDropInfo();
  const stage = findStage(info, PHASE);
  if (!stageActiveNow(stage, info.active_stage)) {
    const cur = info.active_stage ? `"${info.active_stage.label}"` : "tidak ada";
    throw new Error(`phase "${stage.label}" BELUM AKTIF (sekarang aktif: ${cur}). Tidak mint.`);
  }
  log(`phase "${stage.label}" AKTIF — lanjut.`);
  return stage;
}

async function modeCheck() {
  if (PHASE) {
    const info = await getDropInfo().catch(e => { log(`gagal baca info drop: ${e.message}`); return null; });
    if (info) {
      const stage = findStage(info, PHASE);
      const active = stageActiveNow(stage, info.active_stage);
      log(`phase: ${fmtStage(stage)}`);
      log(`status phase: ${active ? "AKTIF ✅" : "belum aktif ⏳"}`);
    }
  }
  log(`cek eligibility ${accounts.length} wallet...`);
  for (let i = 0; i < accounts.length; i++) {
    const r = await buildMintTx(accounts[i].address, QTY).catch(e => ({ ok: false, status: 0, body: e.message }));
    if (r.ok) {
      const priceEth = Number(BigInt(r.tx.value ?? "0x0")) / 1e18;
      log(`wallet[${i}] ${accounts[i].address}: ELIGIBLE ✅ — harga ${priceEth} ETH ${priceEth > 0 ? "(BERBAYAR, butuh persetujuan)" : "(GRATIS, bisa auto-mint)"}`);
    } else {
      log(`wallet[${i}] ${accounts[i].address}: ${describeErr(r)}`);
    }
  }
}

async function modeFire(dryRun) {
  if (PHASE) {
    try { await requireActivePhase(); }
    catch (e) { log(`⛔ ${e.message}`); await tg(`⛔ ${e.message}`); return; }
  }
  log(`${dryRun ? "DRY-RUN" : "FIRE"} ${accounts.length} wallet...`);
  await tg(`🤖 Bot mulai: ${dryRun ? "DRY-RUN" : "FIRE"} ${accounts.length} wallet (${SLUG})`);
  const results = await Promise.all(accounts.map((_, i) => fireWallet(i, dryRun)));
  const ok = results.filter(r => r.ok).length;
  const paid = results.filter(r => r.paid);
  if (paid.length > 0) {
    const total = paid.reduce((s, r) => s + r.priceEth, 0);
    log(`⛔ ${paid.length} wallet butuh persetujuan: ${paid.map(r => r.priceEth).join(" + ")} = ${total} ETH total. Set AUTO_MINT_PAID=true di .env setelah user setuju, lalu jalankan --fire lagi.`);
    await tg(`⛔ MINT BERBAYAR terdeteksi, bot berhenti.\n${paid.length} wallet butuh persetujuan: total ~${total} ETH.\nBalas OK kalau setuju, baru bot lanjut.`, true);
  }
  log(`selesai: ${ok}/${results.length} sukses`);
  await tg(`🏁 Selesai: ${ok}/${results.length} wallet sukses mint.`);
}

async function modeWait() {
  log(`mode WAIT: polling tiap ${POLL_MS}ms sampai ${PHASE ? `phase "${PHASE}"` : "drop"} aktif (maks ${MAX_WAIT_MS / 60000} mnt)`);
  await tg(`🤖 Bot siaga: polling drop ${SLUG}${PHASE ? ` (phase "${PHASE}")` : ""} tiap ${POLL_MS / 1000} detik.\nAkan auto-mint dari ${accounts.length} wallet begitu ${PHASE ? "phase dibuka" : "drop aktif"}.`);
  const done = new Array(accounts.length).fill(false);
  const paidDetected = [];
  const seen422 = new Array(accounts.length).fill(false);
  let waitLoggedPhase = null; // anti-spam log saat menunggu phase tertentu
  const t0 = Date.now();
  const CANCELLED = new URL("./CANCELLED", import.meta.url).pathname;
  while (done.some(d => !d)) {
    if (fs.existsSync(CANCELLED)) { log("⛔ Dibatalkan user via Telegram. Berhenti."); await tg("⛔ Auto-mint dibatalkan sesuai perintah."); break; }
    if (Date.now() - t0 > MAX_WAIT_MS) { log("timeout, berhenti."); break; }
    if (PHASE) {
      // Tunggu phase yang diminta (ala osnm-z: "Waiting for OG List preparation window").
      const info = await getDropInfo().catch(() => null);
      const stage = info ? findStage(info, PHASE) : null;
      if (!stage || !stageActiveNow(stage, info.active_stage)) {
        const cur = info?.active_stage ? `"${info.active_stage.label}"` : "tidak ada";
        if (!waitLoggedPhase || waitLoggedPhase !== cur) {
          waitLoggedPhase = cur;
          log(`⏳ menunggu phase "${PHASE}" (sekarang aktif: ${cur})...`);
        }
        await sleep(POLL_MS);
        continue;
      }
      if (waitLoggedPhase !== "__active__") {
        waitLoggedPhase = "__active__";
        log(`✅ phase "${stage.label}" AKTIF — mulai mint!`);
        await tg(`✅ Phase "${stage.label}" dibuka — bot mulai mint ${accounts.length} wallet.`);
      }
    }
    await Promise.all(accounts.map(async (_, i) => {
      if (done[i]) return;
      try {
        const r = await buildMintTx(accounts[i].address, QTY);
        if (r.ok) {
          const priceWei = BigInt(r.tx.value ?? "0x0");
          if (priceWei > 0n && !AUTO_MINT_PAID) {
            done[i] = true;
            const priceEth = Number(priceWei) / 1e18;
            log(`wallet[${i}] ${accounts[i].address}: ⛔ DROP AKTIF tapi BERBAYAR (${priceEth} ETH) — berhenti, butuh persetujuan user dulu.`);
            paidDetected.push({ i, priceEth });
          } else {
            done[i] = true;
            log(`wallet[${i}] ${accounts[i].address}: DROP AKTIF — langsung mint!`);
            await fireWallet(i, false);
          }
        } else if (r.status === 422) {
          // 422 belum tentu "tidak whitelist" — bisa jadi stagenya belum giliran
          // (mis. masih phase Team Mint sementara wallet ini jatah OG List).
          // Jangan skip; tetap polling sampai timeout. Log sekali saja.
          if (!seen422[i]) {
            seen422[i] = true;
            log(`wallet[${i}] ${accounts[i].address}: 422 untuk saat ini — tetap polling (mungkin stage-nya belum dibuka)...`);
          }
        } else if (r.status === 401 || r.status === 404) {
          done[i] = true;
          log(`wallet[${i}] FATAL: ${describeErr(r)} — hentikan polling wallet ini`);
        }
        // 409 / 5xx / network error -> tetap polling
      } catch (e) { /* network error, coba lagi */ }
    }));
    if (done.some(d => !d)) await sleep(POLL_MS);
  }
  if (paidDetected.length > 0) {
    const total = paidDetected.reduce((s, r) => s + r.priceEth, 0);
    log(`⛔ STOP: ${paidDetected.length} wallet butuh persetujuan (total ~${total} ETH). Kabari user sebelum lanjut.`);
    const state = { paid_pending: true, at: new Date().toISOString(), total_eth: total, wallets: paidDetected.length };
    fs.writeFileSync(new URL("./state.json", import.meta.url).pathname, JSON.stringify(state, null, 1));
    await tg(`⛔ STOP: mint ternyata BERBAYAR (total ~${total} ETH untuk ${paidDetected.length} wallet).\nBot berhenti. Balas OK kalau setuju, atau BATAL untuk stop total.`, true);
  }
  const pending = accounts.map((a, i) => ({ a, i })).filter(({ i }) => !done[i]);
  if (pending.length > 0) {
    log(`⚠️ ${pending.length} wallet tidak sempat mint: ${pending.map(({ a }) => a.address).join(", ")}`);
  }
  log("wait selesai.");
  await tg(`🏁 Bot selesai. ${accounts.length - pending.length}/${accounts.length} wallet beres.${pending.length ? `\n⚠️ Tidak sempat: ${pending.map(({ a }) => a.address.slice(0, 10) + "...").join(", ")}` : ""}`);
}

const MODES = ["--check", "--fire", "--wait", "--dry-run"];
const mode = argv.find(a => MODES.includes(a)) || "--check";
if (!MODES.includes(mode)) { console.error("mode tidak dikenal: --check | --fire | --wait | --dry-run"); process.exit(1); }
log(`slug=${SLUG} qty=${QTY} mode=${mode} chain=${CHAIN_LABEL} (id ${CHAIN.id})${PHASE ? ` phase="${PHASE}"` : ""}`);
if (mode === "--check") await modeCheck();
else if (mode === "--fire") await modeFire(false);
else if (mode === "--dry-run") await modeFire(true);
else if (mode === "--wait") await modeWait();
