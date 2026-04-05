const fs = require('fs');
let text = fs.readFileSync('src/engine/renderEngine.ts', 'utf-8');
const createIdx = text.indexOf('createPipelines');
console.log(text.substring(createIdx - 300, createIdx + 1500));
