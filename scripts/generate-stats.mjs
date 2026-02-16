// scripts/generate-stats.mjs
// Node 18+ (native fetch). Generates assets/stats.svg in a terminal style.

import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;

if (!USERNAME) throw new Error("Missing env: GITHUB_USERNAME");
if (!TOKEN) throw new Error("Missing env: GITHUB_TOKEN");

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

async function gql(query, variables = {}) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json, null, 2)}`);
  }
  return json.data;
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(n) {
  return new Intl.NumberFormat("en-US").format(Number(n) || 0);
}

// Terminal SVG renderer
function renderTerminalSvg({ name, followers, publicRepos, totalCommitsApprox, topLangs }) {
  const W = 760;
  const H = 280;
  const pad = 22;

  const title = name ? `${name}` : USERNAME;

  const lines = [
    `${USERNAME}@github:~$ whoami`,
    `${title}`,
    ``,
    `${USERNAME}@github:~$ stats --summary`,
    `followers: ${formatNumber(followers)}`,
    `public_repos: ${formatNumber(publicRepos)}`,
    `total_commits (approx): ${formatNumber(totalCommitsApprox)}`,
    ``,
    `${USERNAME}@github:~$ stats --top-languages`,
    ...topLangs.map((l) => `${l.name.padEnd(14)} ${String(l.percent).padStart(5)}%`),
    ``,
    `${USERNAME}@github:~$ _`,
  ];

  // Terminal look
  const bg = "#0b0f0e";
  const border = "#1f2a27";
  const green = "#22c55e";
  const dim = "#86efac";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

  // Positioning
  const lineHeight = 18;
  const startY = 48;
  const maxLines = Math.floor((H - startY - 22) / lineHeight);
  const clipped = lines.slice(0, maxLines);

  const textNodes = clipped
    .map((line, i) => {
      const y = startY + i * lineHeight;
      const color =
        line.startsWith(`${USERNAME}@github`) ? green :
        line === "" ? dim :
        line.endsWith("$ _") ? green :
        dim;
      return `<text x="${pad}" y="${y}" font-family="${mono}" font-size="14" fill="${color}">${esc(line)}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Terminal GitHub stats for ${esc(USERNAME)}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.45"/>
    </filter>
    <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.00"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="${bg}" filter="url(#shadow)"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="15" fill="none" stroke="${border}"/>

  <!-- Terminal header dots -->
  <g transform="translate(${pad}, 18)">
    <circle cx="8" cy="8" r="5" fill="#ef4444"/>
    <circle cx="28" cy="8" r="5" fill="#f59e0b"/>
    <circle cx="48" cy="8" r="5" fill="#22c55e"/>
    <text x="76" y="12" font-family="${mono}" font-size="12" fill="#9ca3af">${esc(USERNAME)} — stats</text>
  </g>

  <!-- Scanline overlay -->
  <rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="url(#scan)"/>

  ${textNodes}
</svg>`;
}

function computeTopLanguages(langSizeMap) {
  const entries = Object.entries(langSizeMap).map(([name, size]) => ({ name, size }));
  entries.sort((a, b) => b.size - a.size);
  const top = entries.slice(0, 6);
  const total = top.reduce((s, x) => s + x.size, 0) || 1;
  return top.map((x) => ({
    name: x.name,
    percent: Math.round((x.size / total) * 100),
  }));
}

async function main() {
  // 1) Fetch user + repos + per-repo commit history count + languages
  // We paginate repos to cover most accounts, while staying within GraphQL limits.
  const query = `
    query($login: String!, $after: String) {
      user(login: $login) {
        name
        followers { totalCount }
        repositories(
          first: 50,
          after: $after,
          ownerAffiliations: OWNER,
          isFork: false,
          orderBy: {field: UPDATED_AT, direction: DESC}
        ) {
          pageInfo { hasNextPage endCursor }
          totalCount
          nodes {
            name
            isArchived
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 1) { totalCount }
                }
              }
            }
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges { size node { name } }
            }
          }
        }
      }
    }
  `;

  let after = null;
  let allRepos = [];
  let userName = "";
  let followers = 0;
  let publicRepos = 0;

  // Pull up to 150 repos (3 pages) to avoid heavy rate/cost.
  // If you have more, we still get a solid approximation.
  for (let page = 0; page < 3; page++) {
    const data = await gql(query, { login: USERNAME, after });
    const user = data.user;

    if (page === 0) {
      userName = user?.name ?? "";
      followers = user?.followers?.totalCount ?? 0;
      publicRepos = user?.repositories?.totalCount ?? 0;
    }

    const repos = user?.repositories?.nodes ?? [];
    allRepos.push(...repos);

    const pi = user?.repositories?.pageInfo;
    if (!pi?.hasNextPage) break;
    after = pi.endCursor;
  }

  // 2) Compute approx total commits and aggregate language sizes
  let totalCommitsApprox = 0;
  const langSizes = {}; // { "TypeScript": 12345, ... }

  for (const r of allRepos) {
    if (!r || r.isArchived) continue;

    const repoCommitCount =
      r?.defaultBranchRef?.target?.history?.totalCount ?? 0;

    totalCommitsApprox += repoCommitCount;

    const edges = r?.languages?.edges ?? [];
    for (const e of edges) {
      const name = e?.node?.name;
      const size = e?.size ?? 0;
      if (!name) continue;
      langSizes[name] = (langSizes[name] ?? 0) + size;
    }
  }

  const topLangs = computeTopLanguages(langSizes);

  const svg = renderTerminalSvg({
    name: userName,
    followers,
    publicRepos,
    totalCommitsApprox,
    topLangs,
  });

  const outDir = path.resolve("assets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "stats.svg"), svg, "utf8");

  console.log("✅ Generated assets/stats.svg");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});