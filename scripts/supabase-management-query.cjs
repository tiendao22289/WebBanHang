const fs = require('node:fs');

async function runQuery({ token, queryFile, outputFile }) {
  const query = fs.readFileSync(queryFile, 'utf8');
  const response = await fetch('https://api.supabase.com/v1/projects/wglhqlrumieujmugpxel/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body}`);
  const rows = JSON.parse(body);
  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(rows, null, 2));
    console.log(JSON.stringify({ outputFile, resultRows: rows.length }));
  } else console.log(JSON.stringify(rows, null, 2));
  return rows;
}

module.exports = { runQuery };
