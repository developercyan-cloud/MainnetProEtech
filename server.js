import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { AbiCoder, keccak256, isAddress, toBeHex, zeroPadValue } from "ethers";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const ANVIL_HOST = process.env.ANVIL_HOST || "127.0.0.1";
const ANVIL_PORT = Number(process.env.ANVIL_PORT || 8545);
const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "anvil-state.json");
const MANUAL_SNAPSHOT_FILE = path.join(DATA_DIR, "manual-anvil-dump.json");
const TRANSFER_LOG_FILE = path.join(DATA_DIR, "usdt-transfer-audit.jsonl");
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
const transferRecords = new Map();

function loadTransferAudit() {
  if (!fs.existsSync(TRANSFER_LOG_FILE)) return;
  const lines = fs.readFileSync(TRANSFER_LOG_FILE, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.idempotencyHash === "string") {
        transferRecords.set(record.idempotencyHash, record);
      }
    } catch (err) {
      console.error("TRANSFER_AUDIT_CORRUPT_LINE: ignored an unreadable audit entry:", err.message);
    }
  }
}
function appendTransferAudit(record) {
  const line = JSON.stringify({ ...record, updatedAt: new Date().toISOString() }) + "\n";
  fs.appendFileSync(TRANSFER_LOG_FILE, line, { mode: 0o600 });
  transferRecords.set(record.idempotencyHash, { ...record, updatedAt: new Date().toISOString() });
}
function hashIdempotencyKey(key) {
  return createHash("sha256").update(key).digest("hex");
}
function httpError(status, code, message, details = {}) {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  error.details = details;
  return error;
}
loadTransferAudit();

let anvil;
let shuttingDown = false;
let transferInProgress = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startAnvil() {
  const args = [
    "--fork-url", FORK_URL,
    "--chain-id", String(CHAIN_ID),
    "--host", ANVIL_HOST,
    "--port", String(ANVIL_PORT),
    "--state", STATE_FILE,
    "--state-interval", "1",
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
        // Do not automatically load MANUAL_SNAPSHOT_FILE here. A manual snapshot
        // may be older than STATE_FILE and would rewind the chain on every restart.
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
  endpoints: { rpc: "/rpc", health: "/health", admin: "/admin/fund-usdt", transfer: "/admin/transfer-usdt", transferStatus: "/admin/transfer-status" }
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

app.post("/admin/transfer-usdt", adminLimiter, requireAdmin, async (req, res) => {
  let impersonating = false;
  let from = "";
  let to = "";
  let amountRaw = 0n;
  let txHash = null;
  let idempotencyHash = null;
  let fingerprint = null;
  let submissionStarted = false;
  let auditRecord = null;
  let transferLockHeld = false;

  try {
    const { fromAddress, toAddress, amount, chainId, requestId } = req.body || {};
    const idempotencyKey = String(req.get("Idempotency-Key") || requestId || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw httpError(400, "IDEMPOTENCY_KEY_REQUIRED",
        "Provide an Idempotency-Key header or requestId (8–128 characters). Reuse the same key only when retrying the same operation.");
    }
    if (CHAIN_ID !== 1 || Number(chainId) !== 1) {
      throw httpError(409, "CHAIN_ID_MISMATCH",
        "This endpoint only permits test transfers on a fork configured with Chain ID 1. No transaction was submitted.",
        { configuredChainId: CHAIN_ID, requestedChainId: chainId ?? null });
    }
    if (!isAddress(fromAddress)) {
      throw httpError(400, "INVALID_SENDER_ADDRESS", "fromAddress is not a valid Ethereum address.");
    }
    if (!isAddress(toAddress)) {
      throw httpError(400, "INVALID_RECIPIENT_ADDRESS", "toAddress is not a valid Ethereum address.");
    }
    from = fromAddress.toLowerCase();
    to = toAddress.toLowerCase();
    if (from === to) {
      throw httpError(400, "SENDER_EQUALS_RECIPIENT", "Sender and recipient must be different addresses.");
    }
    try { amountRaw = amountRawGuard(amount); }
    catch (err) { throw httpError(400, "INVALID_AMOUNT", err.message); }
    if (amountRaw <= 0n) {
      throw httpError(400, "INVALID_AMOUNT", "Transfer amount must be greater than zero.");
    }

    fingerprint = createHash("sha256").update(JSON.stringify({
      chainId: 1, from, to, amountRaw: amountRaw.toString(), token: USDT.toLowerCase()
    })).digest("hex");
    idempotencyHash = hashIdempotencyKey(idempotencyKey);
    const previous = transferRecords.get(idempotencyHash);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw httpError(409, "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key is already associated with a different transfer. Use a new key for a new operation.");
      }
      if (previous.status === "confirmed" && previous.response) {
        return res.status(200).json({ ...previous.response, replayed: true });
      }
      throw httpError(409, "TRANSFER_ALREADY_PROCESSED_OR_UNCERTAIN",
        "This request key has already been processed or has an uncertain outcome. No second transfer was submitted. Check the saved txHash/audit record before taking action.",
        { operationStatus: previous.status, txHash: previous.txHash || null, updatedAt: previous.updatedAt || null });
    }
    if (transferInProgress) {
      throw httpError(409, "TRANSFER_BUSY", "Another USDT transfer is currently being processed. Wait for its result before starting another operation.");
    }
    transferInProgress = true;
    transferLockHeld = true;

    let balanceBefore;
    try { balanceBefore = await tokenBalanceRaw(from); }
    catch (err) { throw httpError(503, "TOKEN_BALANCE_CHECK_FAILED", "Could not read the sender's virtual USDT balance from Anvil.", { cause: err.message }); }
    if (balanceBefore < amountRaw) {
      throw httpError(400, "INSUFFICIENT_VIRTUAL_USDT",
        "The sender does not have enough virtual USDT on this Anvil fork.",
        { availableRaw: balanceBefore.toString(), requiredRaw: amountRaw.toString(), decimals: USDT_DECIMALS });
    }

    let recipientBalanceBefore;
    try { recipientBalanceBefore = await tokenBalanceRaw(to); }
    catch (err) { throw httpError(503, "RECIPIENT_BALANCE_CHECK_FAILED", "Could not read the recipient's virtual USDT balance from Anvil.", { cause: err.message }); }

    const nativeBefore = BigInt(await rpc("eth_getBalance", [from, "latest"]));
    if (nativeBefore < 10n ** 16n) {
      await rpc("anvil_setBalance", [from, hexWord(5n * 10n ** 18n)]);
    }

    // Persist intent before any transaction submission. This also prevents a retry
    // after a process crash from blindly submitting the same operation twice.
    auditRecord = {
      idempotencyHash, fingerprint, status: "prepared", from, to,
      token: USDT, amountRaw: amountRaw.toString(), chainId: 1,
      balanceBeforeRaw: balanceBefore.toString(), recipientBalanceBeforeRaw: recipientBalanceBefore.toString(),
      txHash: null, response: null
    };
    appendTransferAudit(auditRecord);

    const data = "0xa9059cbb" + to.slice(2).padStart(64, "0") + amountRaw.toString(16).padStart(64, "0");
    await rpc("anvil_impersonateAccount", [from]);
    impersonating = true;
    const gasPrice = await rpc("eth_gasPrice", []);
    auditRecord = { ...auditRecord, status: "submitting" };
    appendTransferAudit(auditRecord);
    submissionStarted = true;

    try {
      txHash = await rpc("eth_sendTransaction", [{
        from, to: USDT, data, value: "0x0", gas: "0x186a0", gasPrice
      }]);
    } catch (err) {
      auditRecord = { ...auditRecord, status: "outcome_unknown", errorCode: "SEND_RESULT_UNKNOWN", error: err.message };
      appendTransferAudit(auditRecord);
      throw httpError(503, "SEND_RESULT_UNKNOWN",
        "Anvil did not return a definite response to transaction submission. The outcome is unknown; do not retry with a new key until you inspect the audit log and chain state.",
        { cause: err.message });
    }
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      auditRecord = { ...auditRecord, status: "outcome_unknown", errorCode: "INVALID_TX_HASH" };
      appendTransferAudit(auditRecord);
      throw httpError(502, "INVALID_TX_HASH", "Anvil returned an invalid transaction hash; submission outcome requires manual review.");
    }
    auditRecord = { ...auditRecord, status: "submitted", txHash };
    appendTransferAudit(auditRecord);

    let receipt = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      receipt = await rpc("eth_getTransactionReceipt", [txHash]);
      if (receipt) break;
      await sleep(500);
    }
    if (!receipt) {
      // Mine once as a recovery measure, then poll again. This is not considered
      // proof of success; the receipt and Transfer event still must be verified.
      try { await rpc("anvil_mine", ["0x1"]); }
      catch (err) { console.warn("TRANSFER_RECOVERY_MINE_FAILED:", err.message); }
      for (let attempt = 0; attempt < 20; attempt++) {
        receipt = await rpc("eth_getTransactionReceipt", [txHash]);
        if (receipt) break;
        await sleep(500);
      }
    }
    if (!receipt) {
      auditRecord = { ...auditRecord, status: "receipt_pending", txHash, errorCode: "RECEIPT_UNAVAILABLE" };
      appendTransferAudit(auditRecord);
      throw httpError(504, "RECEIPT_UNAVAILABLE",
        "Transaction hash was created, but Anvil did not return a receipt after polling and one mining attempt. The transfer is unconfirmed; do not submit it again.",
        { txHash });
    }
    if (String(receipt.status).toLowerCase() !== "0x1") {
      auditRecord = { ...auditRecord, status: "reverted", txHash, blockNumber: receipt.blockNumber || null, receiptStatus: receipt.status || null };
      appendTransferAudit(auditRecord);
      throw httpError(422, "TRANSACTION_REVERTED", "The transaction was mined but reverted. No successful USDT transfer was verified.",
        { txHash, blockNumber: receipt.blockNumber || null, receiptStatus: receipt.status || null });
    }

    const tx = await rpc("eth_getTransactionByHash", [txHash]);
    if (!tx) {
      auditRecord = { ...auditRecord, status: "receipt_inconsistent", txHash, blockNumber: receipt.blockNumber || null };
      appendTransferAudit(auditRecord);
      throw httpError(502, "TRANSACTION_LOOKUP_INCONSISTENT", "A successful receipt was returned, but the transaction lookup returned null. Result requires review.", { txHash });
    }
    if (String(tx.from || "").toLowerCase() !== from || String(tx.to || "").toLowerCase() !== USDT.toLowerCase() ||
        String(receipt.transactionHash || "").toLowerCase() !== txHash.toLowerCase()) {
      auditRecord = { ...auditRecord, status: "receipt_mismatch", txHash, blockNumber: receipt.blockNumber || null };
      appendTransferAudit(auditRecord);
      throw httpError(502, "RECEIPT_TRANSACTION_MISMATCH", "Receipt transaction details do not match the requested sender and USDT contract.", { txHash });
    }
    const block = await rpc("eth_getBlockByHash", [receipt.blockHash, false]);
    const blockContainsTransaction = Array.isArray(block?.transactions) && block.transactions.some(item =>
      String(typeof item === "string" ? item : item?.hash || "").toLowerCase() === txHash.toLowerCase());
    if (!block || String(block.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase() ||
        String(tx.blockHash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase() ||
        String(tx.blockNumber || "").toLowerCase() !== String(receipt.blockNumber || "").toLowerCase() ||
        !blockContainsTransaction) {
      auditRecord = { ...auditRecord, status: "block_verification_failed", txHash, blockNumber: receipt.blockNumber || null };
      appendTransferAudit(auditRecord);
      throw httpError(502, "BLOCK_VERIFICATION_FAILED", "The receipt's block could not be independently verified.", { txHash, blockNumber: receipt.blockNumber || null });
    }

    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const expectedFromTopic = "0x" + from.slice(2).padStart(64, "0");
    const expectedToTopic = "0x" + to.slice(2).padStart(64, "0");
    const validLog = (receipt.logs || []).some(log =>
      String(log.address || "").toLowerCase() === USDT.toLowerCase() &&
      String(log.topics?.[0] || "").toLowerCase() === transferTopic &&
      String(log.topics?.[1] || "").toLowerCase() === expectedFromTopic &&
      String(log.topics?.[2] || "").toLowerCase() === expectedToTopic &&
      BigInt(log.data || "0x0") === amountRaw
    );
    if (!validLog) {
      auditRecord = { ...auditRecord, status: "transfer_event_missing", txHash, blockNumber: receipt.blockNumber || null };
      appendTransferAudit(auditRecord);
      throw httpError(422, "USDT_TRANSFER_EVENT_MISSING", "Receipt did not contain the exact USDT Transfer event for the requested sender, recipient and amount.", { txHash, blockNumber: receipt.blockNumber || null });
    }

    const [balanceAfter, recipientBalanceAfter] = await Promise.all([tokenBalanceRaw(from), tokenBalanceRaw(to)]);
    if (balanceAfter !== balanceBefore - amountRaw || recipientBalanceAfter !== recipientBalanceBefore + amountRaw) {
      auditRecord = { ...auditRecord, status: "balance_verification_failed", txHash, blockNumber: receipt.blockNumber || null,
        balanceAfterRaw: balanceAfter.toString(), recipientBalanceAfterRaw: recipientBalanceAfter.toString() };
      appendTransferAudit(auditRecord);
      throw httpError(502, "POST_TRANSFER_BALANCE_MISMATCH", "The Transfer event was found, but the final token balances do not match the expected exact debit and credit. Manual review is required.", { txHash });
    }

    const responseBody = {
      ok: true,
      status: "confirmed",
      network: "ProEshop MainNet Lab Anvil fork only",
      chainId: CHAIN_ID,
      fromAddress: from,
      toAddress: to,
      token: USDT,
      decimals: USDT_DECIMALS,
      amount: `${(amountRaw / 1000000n).toString()}.${(amountRaw % 1000000n).toString().padStart(6, "0")}`,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed || null,
      auditLog: path.basename(TRANSFER_LOG_FILE),
      warning: "Test-only transfer on an isolated fork. No real USDT was sent on Ethereum Mainnet."
    };
    auditRecord = { ...auditRecord, status: "confirmed", txHash, blockNumber: receipt.blockNumber,
      receiptStatus: receipt.status, gasUsed: receipt.gasUsed || null, response: responseBody,
      balanceAfterRaw: balanceAfter.toString(), recipientBalanceAfterRaw: recipientBalanceAfter.toString() };
    try {
      appendTransferAudit(auditRecord);
    } catch (err) {
      console.error("TRANSFER_CONFIRMED_AUDIT_WRITE_FAILED:", { txHash, message: err.message });
      return res.status(500).json({ error: { code: "TRANSFER_CONFIRMED_AUDIT_WRITE_FAILED", message: "The transfer was verified on the Anvil fork, but the final audit record could not be written. Do not retry this transfer.", txHash } });
    }
    return res.status(200).json(responseBody);
  } catch (err) {
    const status = Number.isInteger(err.httpStatus) ? err.httpStatus : (submissionStarted ? 503 : 500);
    const code = err.code || (submissionStarted ? "TRANSFER_OUTCOME_REQUIRES_REVIEW" : "TRANSFER_INTERNAL_ERROR");
    if (auditRecord && idempotencyHash && !["confirmed", "reverted", "receipt_pending", "outcome_unknown", "receipt_inconsistent", "receipt_mismatch", "block_verification_failed", "transfer_event_missing", "balance_verification_failed"].includes(auditRecord.status)) {
      try {
        appendTransferAudit({ ...auditRecord, status: submissionStarted ? "outcome_unknown" : "failed_before_submission",
          errorCode: code, error: String(err.message || "Transfer failed").slice(0, 300), txHash: txHash || auditRecord.txHash || null });
      } catch (auditErr) {
        console.error("TRANSFER_AUDIT_WRITE_FAILED:", auditErr.message);
      }
    }
    console.error("USDT_TRANSFER_ERROR:", { code, status, txHash, message: String(err.message || "Transfer failed") });
    return res.status(status).json({ error: { code, message: String(err.message || "Transfer failed").slice(0, 500), ...(err.details || {}), ...(txHash ? { txHash } : {}) } });
  } finally {
    if (transferLockHeld) transferInProgress = false;
    if (impersonating && from) {
      try { await rpc("anvil_stopImpersonatingAccount", [from]); }
      catch (err) { console.error("IMPERSONATION_CLEANUP_FAILED:", { address: from, message: err.message }); }
    }
  }
});

app.get("/admin/transfer-status", adminLimiter, requireAdmin, (req, res) => {
  const idempotencyKey = String(req.get("Idempotency-Key") || req.query.requestId || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Provide the original Idempotency-Key header or requestId query parameter (8–128 characters)." } });
  }
  const record = transferRecords.get(hashIdempotencyKey(idempotencyKey));
  if (!record) return res.status(404).json({ error: { code: "TRANSFER_NOT_FOUND", message: "No transfer audit record exists for this request key." } });
  return res.json({
    ok: true,
    status: record.status,
    txHash: record.txHash || null,
    blockNumber: record.blockNumber || null,
    fromAddress: record.from || null,
    toAddress: record.to || null,
    token: record.token || USDT,
    amountRaw: record.amountRaw || null,
    chainId: record.chainId || CHAIN_ID,
    errorCode: record.errorCode || null,
    updatedAt: record.updatedAt || null,
    response: record.status === "confirmed" ? record.response : undefined,
    warning: "This endpoint reports the saved Anvil-fork audit record; it does not represent Ethereum Mainnet settlement."
  });
});

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
  console.log(`Received ${signal}; saving a manual Anvil snapshot...`);
  try {
    const state = await rpc("anvil_dumpState");
    const tmp = `${MANUAL_SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, MANUAL_SNAPSHOT_FILE);
  } catch (e) {
    console.error("MANUAL_SNAPSHOT_SAVE_FAILED:", e.message);
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
