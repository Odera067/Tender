/**
 * Terminal version of the demo.
 *   npm run shop -- "Is ETH in an uptrend this month?" --budget 0.02
 * Expects the seller to be running (npm run seller), or SELLER_URL set.
 */
import { config } from "./config.js";
import { createPayer } from "./buyer/payer.js";
import { createPlanner } from "./buyer/planner.js";
import { runShopper, type AgentEvent } from "./buyer/agent.js";
import { saveRun } from "./store.js";

const args = process.argv.slice(2);
const bi = args.indexOf("--budget");
const budget = bi >= 0 ? args.splice(bi, 2)[1] : config.buyer.defaultBudgetUsd;
const question = args.join(" ").trim();
if (!question) {
  console.error('usage: npm run shop -- "<question>" [--budget 0.05]');
  process.exit(1);
}

const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };

function log(e: AgentEvent) {
  switch (e.type) {
    case "start":
      console.log(`${c.bold}Q: ${e.question}${c.reset}`);
      console.log(`${c.dim}budget ${e.budget} · per-call cap ${e.perCallCap} · ${e.planner} · payments=${e.payer} · ${e.wallet} on ${e.network}${c.reset}\n`);
      break;
    case "catalog":
      console.log(`${c.dim}catalog: ${e.products.map((p) => `${p.id} ${p.price}`).join(" · ")}${c.reset}`);
      break;
    case "proposal":
      if (e.proposal.action === "buy")
        console.log(`\n[${e.step}] SERV proposes: buy ${e.proposal.product}(${e.proposal.symbol}), confidence now ${e.proposal.confidence}\n    "${e.proposal.reason}"`);
      else console.log(`\n[${e.step}] SERV: ready to answer (confidence ${e.proposal.confidence})`);
      break;
    case "guard":
      console.log(e.approved ? `    ${c.green}✓ guard approved ${e.price ?? ""}${c.reset}` : `    ${c.red}✗ guard blocked: ${e.reason}${c.reset}`);
      break;
    case "purchase":
      console.log(`    ${c.green}paid ${e.item.price}${c.reset} ${e.item.mock ? "(MOCK, no settlement)" : e.item.explorerUrl ?? ""}`);
      break;
    case "purchase_failed":
      console.log(`    ${c.red}purchase failed: ${e.error}${c.reset}`);
      break;
    case "answer":
      console.log(`\n${c.bold}A:${c.reset} ${e.answer}\n${c.dim}(${e.reason})${c.reset}`);
      break;
    case "receipt": {
      const r = e.receipt;
      console.log(`\n${c.bold}── receipt ──${c.reset}`);
      for (const b of r.bought) console.log(`  ${b.price.padEnd(10)} ${b.product}(${b.symbol})  ${b.txHash ?? (b.mock ? "MOCK" : "")}\n             why: ${b.reason}`);
      for (const b of r.blocked) console.log(`  ${c.red}blocked${c.reset}    ${b.product}(${b.symbol})  ${b.reason}`);
      for (const n of r.notBought) console.log(`  ${c.dim}skipped    ${n.product}: ${n.why}${c.reset}`);
      console.log(`  spent ${r.spent} of ${r.budget} · unspent ${r.unspent} · SERV tokens ${r.servTokens.prompt}+${r.servTokens.completion}`);
      break;
    }
  }
}

const payer = await createPayer();
const planner = createPlanner();
saveRun(await runShopper({ question, budgetUsd: budget, payer, planner, emit: log }));
