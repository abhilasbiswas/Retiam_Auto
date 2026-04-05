const fs = require('fs');
let content = fs.readFileSync('src/original_engine.html', 'utf-8');

let startIdx = content.indexOf('const rate_functions = {');
let endIdx = content.indexOf('};', startIdx);
let text = content.substring(startIdx, endIdx + 2);

fs.writeFileSync('src/math/rate_functions.ts', 'export ' + text);
