const fs = require('fs');
let arenaLines = fs.readFileSync('src/gpu/arena.ts', 'utf-8').split('\n');
fs.writeFileSync('src/gpu/arena.ts', arenaLines.slice(0, 72).join('\n'));
