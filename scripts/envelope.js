#!/usr/bin/env node
// Back of the envelope calculation for DEVELOPER.md. Rerun with `node scripts/envelope.js`.
// All numbers are estimates in tokens. Prices are example inputs, not quotes; check the
// provider's price page before relying on a dollar figure.

const P = {
  docTokens: [20_000, 100_000, 400_000], // short report, book chapter set, long manual
  leafMax: 1500, // max tokens per leaf (default --leaf-tokens)
  leafFill: 0.7, // average leaf size as a share of leafMax
  summaryTokens: 80, // per node summary budget (default --summary-tokens)
  promptOverhead: 450, // fixed system plus instruction tokens per call
  fanout: 12, // max children per node before grouping
  beam: 3, // nodes chosen per navigation step
  readBudget: 6000, // tokens of leaf text sent to the answer call
  answerOut: 700, // typical answer output tokens
  navOut: 150, // typical navigation output tokens
  windowTokens: 3000, // segmentation window for unstructured text
  prices: [
    { name: 'example small model', inPerM: 1, outPerM: 5 },
    { name: 'example mid model', inPerM: 3, outPerM: 15 },
  ],
};

function indexRun(D, unstructured) {
  const leaves = Math.ceil(D / (P.leafMax * P.leafFill));
  // parents: roughly one per fanout/2 children per level, summed over levels
  let parents = 0;
  let level = leaves;
  while (level > P.fanout) {
    level = Math.ceil(level / (P.fanout / 2));
    parents += level;
  }
  parents += 1; // root
  const segCalls = unstructured ? Math.ceil(D / P.windowTokens) : 0;
  const leafIn = D + leaves * P.promptOverhead;
  const parentIn = parents * P.promptOverhead + (leaves + parents) * P.summaryTokens;
  const segIn = unstructured ? D * 1.15 + segCalls * P.promptOverhead : 0; // line numbers add ~15%
  const segOut = segCalls * 120;
  const calls = leaves + parents + segCalls;
  const input = Math.round(leafIn + parentIn + segIn);
  const output = Math.round((leaves + parents) * P.summaryTokens + segOut);
  return { leaves, parents, segCalls, calls, input, output };
}

function askRun(leaves) {
  const depth = Math.max(1, Math.ceil(Math.log(leaves) / Math.log(P.fanout)));
  const firstStep = Math.min(P.fanout, leaves);
  const laterStep = P.beam * P.fanout;
  const perCand = P.summaryTokens + 25; // title, path, line range
  let navIn = P.promptOverhead + firstStep * perCand;
  for (let i = 1; i < depth; i++) navIn += P.promptOverhead + laterStep * perCand;
  const navOut = depth * P.navOut;
  const ansIn = P.promptOverhead + P.readBudget * 1.15 + 100;
  const calls = depth + 1;
  return { depth, calls, input: Math.round(navIn + ansIn), output: navOut + P.answerOut };
}

const usd = (t, price) => (t.input * price.inPerM + t.output * price.outPerM) / 1e6;

for (const D of P.docTokens) {
  for (const unstructured of [false, true]) {
    const ix = indexRun(D, unstructured);
    const ask = askRun(ix.leaves);
    const costs = P.prices
      .map((pr) => `${pr.name} index $${usd(ix, pr).toFixed(3)} ask $${usd(ask, pr).toFixed(4)}`)
      .join('; ');
    console.log(
      `doc ${D} tokens, ${unstructured ? 'unstructured' : 'structured'}: ` +
        `index ${ix.calls} calls (${ix.leaves} leaves, ${ix.parents} parents, ${ix.segCalls} segment), ` +
        `${ix.input} in / ${ix.output} out; ask ${ask.calls} calls, ${ask.input} in / ${ask.output} out; ${costs}`,
    );
  }
}
