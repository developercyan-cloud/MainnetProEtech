import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { AbiCoder, keccak256, isAddress, toBeHex, zeroPadValue } from "ethers";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const ANVIL_HOST = process.env.ANVIL_HOST || "127.0.0.1";
const ANVIL_PORT = Number(process.env.ANVIL_PORT || 8545);
const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "anvil-state.json");
const MANUAL_SNAPSHOT_FILE = path.join(DATA_DIR, "manual-anvil-dump.json");
const FORK_URL = process.env.ETHEREUM_RPC_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_DECIMALS = 6;
const RPC_URL = `http://${ANVIL_HOST}:${ANVIL_PORT}`;

if (!FORK_URL) {
  console.error("FATAL: ETHEREUM_RPC_URL is required (use an Ethereum Mainnet RPC provider URL).");
  process.exit(1);
}
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
  console.error("FATAL: ADMIN_TOKEN must be a random secret of at least 32 characters.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

let anvil;
let shuttingDown = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startAnvil() {
  const args = [
    "--fork-url", FORK_URL,
    "--chain-id", String(CHAIN_ID),
    "--host", ANVIL_HOST,
    "--port", String(ANVIL_PORT),
    "--state", STATE_FILE,
    "--state-interval", "30",
    "--silent"
  ];
  anvil = spawn("anvil", args, { stdio: ["ignore", "inherit", "inherit"] });
  anvil.on("exit", (code, signal) => {
    console.error(`Anvil exited (code=${code}, signal=${signal})`);
    if (!shuttingDown) process.exit(1);
  });
}

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Anvil RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || `RPC error ${data.error.code}`);
  return data.result;
}

async function waitForAnvil() {
  for (let i = 0; i < 90; i++) {
    try {
      const id = await rpc("eth_chainId");
      if (Number.parseInt(id, 16) === CHAIN_ID) {
        if (fs.existsSync(MANUAL_SNAPSHOT_FILE)) {
          try {
            const saved = JSON.parse(fs.readFileSync(MANUAL_SNAPSHOT_FILE, "utf8"));
            if (typeof saved.state === "string" && saved.state.startsWith("0x")) {
              await rpc("anvil_loadState", [saved.state]);
              console.log("Restored manual Anvil snapshot.");
            }
          } catch (e) {
            console.error("Manual snapshot restore skipped:", e.message);
          }
        }
        return;
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error("Anvil did not become ready within 90 seconds.");
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "256kb", strict: true }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RPC_RATE_LIMIT_PER_MINUTE || 300),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "RPC rate limit reached; retry shortly." }
});
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const PUBLIC_METHODS = new Set([
  "web3_clientVersion", "web3_sha3",
  "net_version",
  "eth_chainId", "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_getBalance", "eth_getStorageAt", "eth_getCode",
  "eth_getBlockByHash", "eth_getBlockByNumber",
  "eth_getTransactionCount", "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber", "eth_call", "eth_estimateGas",
  "eth_createAccessList", "eth_sendRawTransaction", "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt", "eth_getLogs"
]);

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function validRpcPayload(body) {
  return body && typeof body === "object" &&
    !Array.isArray(body) &&
    body.jsonrpc === "2.0" &&
    typeof body.method === "string" &&
    Array.isArray(body.params || []);
}

app.get("/", (_req, res) => res.json({
  service: "ProEshop Anvil Virtual Ethereum",
  chainId: CHAIN_ID,
  network: "isolated-ethereum-mainnet-fork",
  usdt: USDT,
  warning: "TEST NETWORK ONLY. Fork balances are not real or transferable USDT.",
  endpoints: { rpc: "/rpc", health: "/health", admin: "/admin/fund-usdt" }
}));

app.get("/health", async (_req, res) => {
  try {
    const [chainId, blockNumber] = await Promise.all([
      rpc("eth_chainId"), rpc("eth_blockNumber")
    ]);
    res.json({
      ok: true,
      chainId: Number.parseInt(chainId, 16),
      blockNumber: Number.parseInt(blockNumber, 16),
      stateFileConfigured: STATE_FILE,
      forkConfigured: Boolean(FORK_URL)
    });
  } catch {
    res.status(503).json({ ok: false, error: "Anvil RPC unavailable" });
  }
});

app.post("/rpc", publicLimiter, async (req, res) => {
  const payload = req.body;
  if (Array.isArray(payload)) {
    if (payload.length > 20) return res.status(400).json(rpcError(null, -32600, "Batch too large"));
    const results = [];
    for (const item of payload) {
      results.push(await handlePublicRpcItem(item));
    }
    return res.json(results);
  }
  const result = await handlePublicRpcItem(payload);
  res.json(result);
});

async function handlePublicRpcItem(item) {
  if (!validRpcPayload(item)) return rpcError(item?.id, -32600, "Invalid JSON-RPC request");
  if (!PUBLIC_METHODS.has(item.method)) {
    return rpcError(item.id, -32601, "Method is not available through the public RPC gateway");
  }
  try {
    const result = await rpc(item.method, item.params || []);
    return { jsonrpc: "2.0", id: item.id ?? null, result };
  } catch (err) {
    return rpcError(item.id, -32000, String(err.message || "RPC request failed").slice(0, 300));
  }
}

function requireAdmin(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token.length !== ADMIN_TOKEN.length ||
      !Buffer.from(token).equals(Buffer.from(ADMIN_TOKEN))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function parseUsdtAmount(value) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("amount must be a decimal USDT string");
  const s = String(value);
  if (!/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/.test(s)) throw new Error("amount must be non-negative USDT with at most 6 decimals");
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** 6n + BigInt((frac + "000000").slice(0, 6));
}
const coder = AbiCoder.defaultAbiCoder();
function mappingSlot(address, slotIndex) {
  const encoded = coder.encode(["address", "uint256"], [address, BigInt(slotIndex)]);
  return keccak256(encoded);
}
function hexWord(n) {
  return zeroPadValue(toBeHex(n), 32);
}
async function tokenBalanceRaw(address) {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(await rpc("eth_call", [{ to: USDT, data }, "latest"]));
}

app.post("/admin/fund-usdt", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { address, amount, gasEth = "5" } = req.body || {};
    if (!isAddress(address)) return res.status(400).json({ error: "Invalid Ethereum address" });
    const target = amountRawGuard(amount);
    const gas = Number(gasEth);
    if (!Number.isFinite(gas) || gas < 0 || gas > 10000) {
      return res.status(400).json({ error: "gasEth must be between 0 and 10000" });
    }

    const before = await tokenBalanceRaw(address);
    if (before !== target) {
      let funded = false;
      // Probe likely mapping slots. Each failed candidate is restored immediately.
      // This allows the exact, verified USDT contract on the fork to be tested
      // without deploying a substitute token. It never writes to Ethereum Mainnet.
      for (let slotIndex = 0; slotIndex <= 40; slotIndex++) {
        const slot = mappingSlot(address, slotIndex);
        const previous = await rpc("eth_getStorageAt", [USDT, slot, "latest"]);
        await rpc("anvil_setStorageAt", [USDT, slot, hexWord(target)]);
        const observed = await tokenBalanceRaw(address);
        if (observed === target) {
          funded = true;
          break;
        }
        await rpc("anvil_setStorageAt", [USDT, slot, previous]);
      }
      if (!funded) {
        return res.status(500).json({
          error: "Could not locate USDT balance mapping in storage slots 0-40; no unverified balance change was retained.",
          hint: "Check the fork block and verified USDT contract storage layout."
        });
      }
    }

    const gasWei = BigInt(Math.floor(gas * 1e6)) * 10n ** 12n;
    await rpc("anvil_setBalance", [address, hexWord(gasWei)]);
    const after = await tokenBalanceRaw(address);
    if (after !== target) return res.status(500).json({ error: "Post-funding balance verification failed" });

    res.json({
      ok: true,
      network: "ProEshop Anvil fork only",
      chainId: CHAIN_ID,
      address,
      token: USDT,
      decimals: USDT_DECIMALS,
      balanceRaw: after.toString(),
      balanceUSDT: (Number(after) / 1e6).toFixed(6),
      gasETH: gas,
      warning: "This is a local fork balance, not real USDT and cannot be transferred on Ethereum Mainnet."
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || "Funding failed").slice(0, 500) });
  }
});

function amountRawGuard(value) {
  try { return parseUsdtAmount(value); }
  catch (e) { throw new Error(e.message); }
}

app.post("/admin/snapshot", adminLimiter, requireAdmin, async (_req, res) => {
  try {
    const state = await rpc("anvil_dumpState");
    const tmp = `${MANUAL_SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, MANUAL_SNAPSHOT_FILE);
    res.json({ ok: true, snapshot: path.basename(MANUAL_SNAPSHOT_FILE) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || "Snapshot failed") });
  }
});

let server;
async function main() {
  startAnvil();
  await waitForAnvil();
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`RPC gateway listening on ${PORT}; Anvil is private on ${ANVIL_HOST}:${ANVIL_PORT}`);
    console.log(`Chain ID ${CHAIN_ID}; state file ${STATE_FILE}`);
  });
}
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; saving Anvil state...`);
  try {
    const state = await rpc("anvil_dumpState");
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("Could not dump state during shutdown:", e.message);
  }
  if (server) server.close();
  if (anvil && !anvil.killed) anvil.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
