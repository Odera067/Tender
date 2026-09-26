/**
 * Wallet helper.
 *   npm run wallet            → print the buyer's AgentKit wallet address + USDC balance
 *   npm run wallet -- faucet  → (Base Sepolia + CDP keys only) request testnet USDC from the CDP faucet
 *   npm run wallet -- new     → generate a fresh private key for BUYER_PRIVATE_KEY or SELLER_PAY_TO
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CdpClient } from "@coinbase/cdp-sdk";
import { config } from "../src/config.js";
import { createX402Payer } from "../src/buyer/payer.js";

const cmd = process.argv[2];

if (cmd === "new") {
  const pk = generatePrivateKey();
  console.log(`private key: ${pk}\naddress:     ${privateKeyToAccount(pk).address}`);
  console.log("Keep the key secret. Put it in .env; never commit it.");
  process.exit(0);
}

const payer = await createX402Payer();
console.log(`buyer wallet: ${payer.address} (${config.network})`);
if (config.wallet.cdpApiKeyId && !config.wallet.cdpAddress)
  console.log(`  ↳ new CDP account. Add CDP_WALLET_ADDRESS=${payer.address} to .env so every run reuses it.`);
console.log(`USDC balance: ${(await payer.usdcBalance()) ?? "unavailable"}`);

if (cmd === "faucet") {
  if (config.network !== "eip155:84532") throw new Error("faucet is testnet-only (X402_NETWORK=eip155:84532)");
  const w = config.wallet;
  if (!w.cdpApiKeyId || !w.cdpApiKeySecret) throw new Error("faucet needs CDP_API_KEY_ID / CDP_API_KEY_SECRET");
  const cdp = new CdpClient({ apiKeyId: w.cdpApiKeyId, apiKeySecret: w.cdpApiKeySecret, walletSecret: w.cdpWalletSecret });
  const { transactionHash } = await cdp.evm.requestFaucet({
    address: payer.address as `0x${string}`,
    network: "base-sepolia",
    token: "usdc",
  });
  console.log(`faucet tx: https://sepolia.basescan.org/tx/${transactionHash}`);
}
